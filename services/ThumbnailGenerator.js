const ffmpeg = require('fluent-ffmpeg');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

// Configure AWS S3 (for Cloudflare R2 compatibility)
const s3Client = new S3Client({
    region: 'auto', // Use 'auto' for Cloudflare R2
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY,
        secretAccessKey: process.env.R2_SECRET_KEY,
    },
});

class ThumbnailGenerator {
    constructor() {
        this.tempDir = path.join(__dirname, '..', 'temp', 'thumbnails');
        this.ensureTempDir();
        this.bucketName = process.env.R2_BUCKET || 'gulfio';
    }

    ensureTempDir() {
        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
            console.log('✅ Created thumbnail temp directory:', this.tempDir);
        }
    }

    async generateThumbnail(videoUrl, reelId) {
        const thumbnailFileName = `${reelId}-thumbnail.jpg`;
        const thumbnailPath = path.join(this.tempDir, thumbnailFileName);

        try {
            console.log(`🎬 Generating thumbnail for reel: ${reelId}`);
            console.log(`📹 Video URL: ${videoUrl}`);

            // Generate thumbnail at 2 second mark using FFmpeg
            await new Promise((resolve, reject) => {
                ffmpeg(videoUrl)
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

            const uploadResult = await s3Client.send(uploadCommand);
            const thumbnailUrl = `${process.env.R2_PUBLIC_URL}/thumbnails/${reelId}-thumbnail.jpg`;

            // Clean up temp file
            this.cleanupTempFile(thumbnailPath);

            console.log(`🎉 Thumbnail uploaded successfully: ${thumbnailUrl}`);
            return thumbnailUrl;

        } catch (error) {
            console.error(`❌ Thumbnail generation failed for ${reelId}:`, error.message);

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

    // Batch process existing videos without thumbnails
    async processExistingVideos(batchSize = 10) {
        const Reel = require('../models/Reel');

        try {
            // Find videos without thumbnails
            const videosWithoutThumbnails = await Reel.find({
                $or: [
                    { thumbnailUrl: { $exists: false } },
                    { thumbnailUrl: null },
                    { thumbnailUrl: '' }
                ]
            }).limit(batchSize);

            console.log(`📊 Found ${videosWithoutThumbnails.length} videos without thumbnails to process`);

            if (videosWithoutThumbnails.length === 0) {
                console.log('🎉 All videos already have thumbnails!');
                return { processed: 0, successful: 0, failed: 0 };
            }

            let successful = 0;
            let failed = 0;

            for (const video of videosWithoutThumbnails) {
                try {
                    console.log(`\n🔄 Processing video ${successful + failed + 1}/${videosWithoutThumbnails.length}: ${video._id}`);

                    const thumbnailUrl = await this.generateThumbnail(video.videoUrl, video._id);

                    // Update the video record
                    await Reel.findByIdAndUpdate(video._id, {
                        thumbnailUrl: thumbnailUrl
                    });

                    successful++;
                    console.log(`✅ Thumbnail generated and saved for ${video._id}`);

                    // Add delay to avoid overwhelming the system
                    await new Promise(resolve => setTimeout(resolve, 2000)); // 2 second delay

                } catch (error) {
                    failed++;
                    console.error(`❌ Failed to generate thumbnail for ${video._id}:`, error.message);

                    // Continue processing other videos even if one fails
                    continue;
                }
            }

            const results = {
                processed: videosWithoutThumbnails.length,
                successful,
                failed
            };

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
