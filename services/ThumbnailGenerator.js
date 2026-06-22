const ffmpeg = require('fluent-ffmpeg');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

// Configure AWS S3 using the same environment variables as the upload route.
//
// `*ChecksumValidation/Calculation: WHEN_REQUIRED` is critical here: AWS SDK v3
// >= 3.729 defaults to WHEN_SUPPORTED, which injects `x-amz-checksum-mode=ENABLED`
// into presigned GET URLs. S3 then streams the object with a checksum trailer the
// container's (older) ffmpeg can't parse, failing with "Invalid data found when
// processing input". Newer local ffmpeg tolerates it — which is why thumbnails
// generate locally but not on Cloud Run. Forcing WHEN_REQUIRED yields a clean
// classic presigned URL any ffmpeg can read.
const s3Client = new S3Client({
    region: process.env.AWS_S3_REGION || 'me-central-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
});

class ThumbnailGenerator {
    constructor() {
        this.tempDir = path.join(__dirname, '..', 'temp', 'thumbnails');
        this.ensureTempDir();
        this.bucketName = process.env.AWS_S3_BUCKET || 'blipsbucket';

        // Debug AWS configuration
        console.log('🔧 ThumbnailGenerator AWS Config:', {
            region: process.env.AWS_S3_REGION ? 'Set' : 'Missing',
            bucket: this.bucketName,
            accessKeyId: process.env.AWS_ACCESS_KEY_ID ? 'Set' : 'Missing',
            secretKey: process.env.AWS_SECRET_ACCESS_KEY ? 'Set' : 'Missing'
        });
    }

    ensureTempDir() {
        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
            console.log('✅ Created thumbnail temp directory:', this.tempDir);
        }
    }

    // Extract the S3/R2 object key from a stored video URL.
    extractKeyFromUrl(u) {
        try {
            const url = new URL(u);
            return decodeURIComponent(url.pathname || '').replace(/^\/+/, '') || null;
        } catch {
            return null;
        }
    }

    // Produce a URL ffmpeg can actually read. R2 (.r2.dev) URLs are public and
    // used as-is. S3 URLs are re-signed from the object key (originalKey if we
    // have it, otherwise parsed from the URL) so an expired signature — or an
    // unsigned `publicUrl` from the YouTube scraper on a private bucket — still
    // works. Falls back to the original URL if no key can be determined.
    async resolveInputUrl(videoUrl, originalKey) {
        if (!videoUrl) return videoUrl;
        if (videoUrl.includes('.r2.dev')) return videoUrl;
        if (videoUrl.includes('amazonaws.com')) {
            const key = originalKey || this.extractKeyFromUrl(videoUrl);
            if (key) {
                try {
                    return await getSignedUrl(
                        s3Client,
                        new GetObjectCommand({ Bucket: this.bucketName, Key: key }),
                        { expiresIn: 60 * 60 } // 1h is plenty to grab one frame
                    );
                } catch (e) {
                    console.warn(`⚠️ Could not re-sign ${key}: ${e.message}`);
                }
            }
        }
        return videoUrl;
    }

    async generateThumbnail(videoUrl, reelId, originalKey = null) {
        const thumbnailFileName = `${reelId}-thumbnail.jpg`;
        const thumbnailPath = path.join(this.tempDir, thumbnailFileName);

        try {
            console.log(`🎬 Generating thumbnail for reel: ${reelId}`);

            // Always feed ffmpeg a freshly-signed/playable URL.
            const inputUrl = await this.resolveInputUrl(videoUrl, originalKey);
            console.log(`📹 Video input: ${inputUrl.substring(0, 90)}...`);

            // Generate thumbnail at 2 second mark using FFmpeg
            await new Promise((resolve, reject) => {
                ffmpeg(inputUrl)
                    .screenshots({
                        timestamps: ['2'], // Extract frame at 2 seconds
                        filename: thumbnailFileName,
                        folder: this.tempDir,
                        size: '360x640' // 9:16 aspect ratio for mobile (portrait)
                    })
                    .on('end', () => {
                        console.log(`✅ Thumbnail generated locally: ${thumbnailPath}`);
                        resolve();
                    })
                    .on('error', (err) => {
                        console.error(`❌ FFmpeg error for ${reelId}:`, err.message);
                        reject(err);
                    });
            });

            // Optimize the image with Sharp
            const optimizedBuffer = await sharp(thumbnailPath)
                .jpeg({ quality: 80, progressive: true })
                .resize(360, 640, {
                    fit: 'cover',
                    position: 'center'
                })
                .toBuffer();

            // Upload to S3
            const s3Key = `thumbnails/${reelId}-thumbnail.jpg`;
            const uploadCommand = new PutObjectCommand({
                Bucket: this.bucketName,
                Key: s3Key,
                Body: optimizedBuffer,
                ContentType: 'image/jpeg',
                CacheControl: 'max-age=31536000', // Cache for 1 year
            });

            console.log(`🚀 Uploading thumbnail to S3: ${this.bucketName}/${s3Key}`);
            const uploadResult = await s3Client.send(uploadCommand);

            // Generate AWS S3 public URL
            const thumbnailUrl = `https://${this.bucketName}.s3.${process.env.AWS_S3_REGION}.amazonaws.com/${s3Key}`;
            console.log(`🔗 Generated thumbnail URL: ${thumbnailUrl}`);

            // Clean up temp file
            this.cleanupTempFile(thumbnailPath);

            console.log(`🎉 Thumbnail uploaded successfully: ${thumbnailUrl}`);
            return thumbnailUrl;

        } catch (error) {
            console.error(`❌ Thumbnail generation failed for ${reelId}:`, {
                error: error.message,
                stack: error.stack,
                videoUrl,
                reelId,
                tempPath: thumbnailPath,
                bucketName: this.bucketName,
                hasCredentials: !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY)
            });

            // Clean up on error
            this.cleanupTempFile(thumbnailPath);

            // Re-throw for handling upstream
            throw error;
        }
    }

    cleanupTempFile(filePath) {
        try {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                console.log(`🧹 Cleaned up temp file: ${filePath}`);
            }
        } catch (cleanupError) {
            console.warn(`⚠️ Failed to cleanup temp file ${filePath}:`, cleanupError.message);
        }
    }

    // Reels that need a thumbnail: missing/empty OR a non-URL value, and which
    // do have a video to extract a frame from.
    static get MISSING_THUMBNAIL_QUERY() {
        return {
            $and: [
                {
                    $or: [
                        { thumbnailUrl: { $exists: false } },
                        { thumbnailUrl: null },
                        { thumbnailUrl: '' },
                        { thumbnailUrl: { $not: /^https?:\/\/.+/ } }
                    ]
                },
                { videoUrl: { $exists: true, $nin: [null, ''] } }
            ]
        };
    }

    // Batch process existing videos without thumbnails. By default it keeps
    // going until every missing thumbnail is filled (capped by `maxTotal`),
    // processing `batchSize` reels per DB page so memory stays bounded.
    async processExistingVideos(batchSize = 10, maxTotal = Infinity) {
        const Reel = require('../models/Reel');
        // Guard against NaN/invalid caps so `processed < maxTotal` doesn't
        // short-circuit the whole loop to zero.
        if (!Number.isFinite(maxTotal) || maxTotal <= 0) maxTotal = Infinity;

        try {
            const query = ThumbnailGenerator.MISSING_THUMBNAIL_QUERY;
            const totalMissing = await Reel.countDocuments(query);
            console.log(`📊 ${totalMissing} reels need thumbnails (cap: ${maxTotal})`);

            if (totalMissing === 0) {
                console.log('🎉 All videos already have thumbnails!');
                return { processed: 0, successful: 0, failed: 0 };
            }

            let successful = 0;
            let failed = 0;
            let processed = 0;
            // IDs that failed this run — excluded from re-queries so a permanently
            // broken video (e.g. deleted S3 object) can't loop forever. Kept in
            // memory only; no data pollution.
            const failedIds = [];

            // Re-query each loop (not skip/paginate): every success removes a doc
            // from the result set, so always grabbing the next `batchSize` that
            // still match — minus this run's failures — avoids re-processing.
            while (processed < maxTotal) {
                const pageQuery = failedIds.length
                    ? { $and: [query, { _id: { $nin: failedIds } }] }
                    : query;
                const page = await Reel.find(pageQuery)
                    .select('_id videoUrl originalKey')
                    .limit(Math.min(batchSize, maxTotal - processed))
                    .lean();
                if (page.length === 0) break;

                for (const video of page) {
                    processed++;
                    try {
                        const thumbnailUrl = await this.generateThumbnail(video.videoUrl, video._id, video.originalKey);
                        await Reel.findByIdAndUpdate(video._id, { thumbnailUrl });
                        successful++;
                        console.log(`✅ [${processed}/${totalMissing}] Thumbnail saved for ${video._id}`);
                        await new Promise(resolve => setTimeout(resolve, 2000)); // pace the encoder
                    } catch (error) {
                        failed++;
                        failedIds.push(video._id);
                        console.error(`❌ [${processed}/${totalMissing}] Failed for ${video._id}: ${error.message}`);
                    }
                }
            }

            const results = { processed, successful, failed };
            console.log(`\n📈 Batch processing complete:`, results);
            return results;

        } catch (error) {
            console.error('❌ Error in batch processing:', error);
            throw error;
        }
    }

    // Generate thumbnail for a single video during upload
    async generateForNewVideo(videoUrl, reelId) {
        try {
            const thumbnailUrl = await this.generateThumbnail(videoUrl, reelId);
            return thumbnailUrl;
        } catch (error) {
            console.error(`❌ Failed to generate thumbnail for new video ${reelId}:`, error.message);
            // Return null so the video can still be saved without thumbnail
            return null;
        }
    }

    // Generate thumbnail by reel ID (fetches video URL from database)
    async generateThumbnailById(reelId) {
        try {
            const Reel = require('../models/Reel');
            console.log(`🔍 Fetching reel data for ID: ${reelId}`);

            const reel = await Reel.findById(reelId);
            if (!reel) {
                throw new Error(`Reel not found with ID: ${reelId}`);
            }

            if (!reel.videoUrl) {
                throw new Error(`Reel ${reelId} has no videoUrl`);
            }

            console.log(`✅ Found reel: ${reel.videoUrl}`);
            const thumbnailUrl = await this.generateThumbnail(reel.videoUrl, reelId, reel.originalKey);
            return thumbnailUrl;
        } catch (error) {
            console.error(`❌ Failed to generate thumbnail by ID ${reelId}:`, {
                error: error.message,
                stack: error.stack,
                reelId
            });
            return null;
        }
    }

    // Health check method
    async healthCheck() {
        try {
            // Test FFmpeg availability
            await new Promise((resolve, reject) => {
                ffmpeg.ffprobe('-version', (err) => {
                    if (err) reject(new Error('FFmpeg not available'));
                    else resolve();
                });
            });

            // Test S3 connection with a simple list operation
            const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
            const testCommand = new ListObjectsV2Command({
                Bucket: this.bucketName,
                MaxKeys: 1
            });

            await s3Client.send(testCommand);

            return { status: 'healthy', ffmpeg: true, s3: true };
        } catch (error) {
            return {
                status: 'unhealthy',
                error: error.message,
                ffmpeg: false,
                s3: false
            };
        }
    }
}

// Create singleton instance
const thumbnailGenerator = new ThumbnailGenerator();

module.exports = { ThumbnailGenerator, thumbnailGenerator };
