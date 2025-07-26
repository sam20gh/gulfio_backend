const express = require('express');
const Video = require('../models/Video');
const Reel = require('../models/Reel');
const Source = require('../models/Source');
const puppeteer = require('puppeteer');
const axios = require('axios'); // Replace fetch with axios
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { getDeepSeekEmbedding } = require('../utils/deepseek');
const { igdl } = require('btch-downloader');// Adjust the path as needed
const NodeCache = require('node-cache');
const router = express.Router();

// You should have dotenv.config() in your main entrypoint (not needed here if already loaded)
const {
    AWS_S3_REGION,
    AWS_S3_BUCKET,
    AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY,
} = process.env;
function cosineSimilarity(vec1, vec2) {
    const dotProduct = vec1.reduce((sum, val, i) => sum + val * vec2[i], 0);
    const magnitudeA = Math.sqrt(vec1.reduce((sum, val) => sum + val * val, 0));
    const magnitudeB = Math.sqrt(vec2.reduce((sum, val) => sum + val * val, 0));
    return dotProduct / (magnitudeA * magnitudeB);
}
// Helper: Get the real Instagram video URL with multiple extraction strategies


async function getInstagramVideoUrl(reelUrl) {
    try {
        const result = await igdl(reelUrl);

        // The result is usually an array of objects with a `url` key for the direct mp4
        // For example: [ { url: "https://...mp4", ... }, ... ]
        if (Array.isArray(result) && result.length > 0 && result[0].url && result[0].url.startsWith('http')) {
            return result[0].url;
        }

        throw new Error('No valid MP4 URL found in btch-downloader result');
    } catch (err) {
        console.error('btch-downloader igdl error:', err);
        throw new Error('Failed to extract video URL using btch-downloader');
    }
}
// Helper: Upload to R2
const s3 = new S3Client({
    region: AWS_S3_REGION,
    credentials: {
        accessKeyId: AWS_ACCESS_KEY_ID,
        secretAccessKey: AWS_SECRET_ACCESS_KEY,
    },
});

async function uploadToR2(videoUrl, filename) {
    try {
        const response = await axios({
            method: 'get',
            url: videoUrl,
            responseType: 'arraybuffer'
        });

        const buffer = Buffer.from(response.data);
        const command = new PutObjectCommand({
            Bucket: AWS_S3_BUCKET,
            Key: filename,
            Body: buffer,
            ContentType: 'video/mp4',
        });

        await s3.send(command);
        console.log(`✅ S3 upload successful: ${filename}`);

        // Generate signed URL (valid for 7 days)
        const signedUrl = await getSignedUrl(
            s3,
            new GetObjectCommand({
                Bucket: AWS_S3_BUCKET,
                Key: filename,
            }),
            { expiresIn: 60 * 60 * 24 * 7 } // 7 days
        );

        return { signedUrl, key: filename };
    } catch (error) {
        console.error('❌ Error in uploadToR2:', error);
        throw new Error(`Failed to upload to R2: ${error.message}`);
    }
}
// ===================== EXISTING ROUTES =====================
router.get('/', async (req, res) => {
    try {
        const videos = await Video.find().sort({ publishedAt: -1 }).limit(20);
        res.json(videos);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Failed to fetch videos' });
    }
});
router.post('/related', async (req, res) => {
    const { embedding, sourceId } = req.body;
    if (!embedding || !sourceId) return res.status(400).json({ error: 'Missing embedding or sourceId' });

    const videos = await Video.find({ source: sourceId, embedding: { $exists: true, $type: 'array' } });
    let bestMatch = null;
    let bestScore = -Infinity;

    for (const video of videos) {
        const sim = cosineSimilarity(embedding, video.embedding);
        if (sim > bestScore) {
            bestScore = sim;
            bestMatch = video;
        }
    }

    if (bestMatch) return res.json(bestMatch);
    return res.status(404).json({ message: 'No related video found' });
});

router.get('/reels', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = Math.min(parseInt(req.query.limit) || 10, 50); // Cap at 50 to prevent abuse
        const skip = (page - 1) * limit;
        const sort = req.query.sort || 'recent'; // recent, random, mixed
        const seed = req.query.seed || Date.now(); // For consistent random ordering

        // Performance improvement: Use skip/limit parameter instead of page parameter
        const actualSkip = parseInt(req.query.skip) || skip;

        // Determine sorting strategy
        let sortQuery = { scrapedAt: -1 }; // Default: most recent first
        let aggregationPipeline = [];

        if (sort === 'random') {
            // Random sampling for variety
            aggregationPipeline = [
                { $sample: { size: Math.min(limit * 5, 200) } }, // Sample more than needed
                { $sort: { scrapedAt: -1 } },
                { $skip: actualSkip },
                { $limit: limit }
            ];
        } else if (sort === 'mixed') {
            // Mixed content: recent + popular + random
            const recentLimit = Math.ceil(limit * 0.4);
            const popularLimit = Math.ceil(limit * 0.3);
            const randomLimit = limit - recentLimit - popularLimit;

            // Get different types of content
            const [recent, popular, random] = await Promise.all([
                Reel.find()
                    .select('source reelId videoUrl thumbnailUrl caption likes dislikes viewCount saves scrapedAt publishedAt embedding originalKey')
                    .populate('source', 'name icon favicon')
                    .sort({ scrapedAt: -1 })
                    .limit(recentLimit)
                    .lean(),
                Reel.find()
                    .select('source reelId videoUrl thumbnailUrl caption likes dislikes viewCount saves scrapedAt publishedAt embedding originalKey')
                    .populate('source', 'name icon favicon')
                    .sort({ viewCount: -1, likes: -1 })
                    .limit(popularLimit)
                    .lean(),
                Reel.aggregate([
                    { $sample: { size: randomLimit } },
                    {
                        $lookup: {
                            from: 'sources',
                            localField: 'source',
                            foreignField: '_id',
                            as: 'source'
                        }
                    },
                    { $unwind: { path: '$source', preserveNullAndEmptyArrays: true } }
                ])
            ]);

            // Shuffle the mixed content
            const mixedReels = [...recent, ...popular, ...random]
                .sort(() => 0.5 - Math.random())
                .slice(0, limit);

            return res.json(req.query.simple === 'true' ? mixedReels : {
                reels: mixedReels,
                pagination: {
                    currentPage: page,
                    totalPages: Math.ceil(200 / limit), // Approximate
                    totalCount: mixedReels.length,
                    limit,
                    hasNextPage: true,
                    hasPreviousPage: page > 1,
                    nextPage: page + 1,
                    previousPage: page > 1 ? page - 1 : null
                }
            });
        }

        // Default case or when using aggregation
        let reels, totalCount;

        if (aggregationPipeline.length > 0) {
            // Use aggregation for random sampling
            aggregationPipeline.unshift({
                $lookup: {
                    from: 'sources',
                    localField: 'source',
                    foreignField: '_id',
                    as: 'source'
                }
            });
            aggregationPipeline.unshift({ $unwind: { path: '$source', preserveNullAndEmptyArrays: true } });

            reels = await Reel.aggregate(aggregationPipeline);
            totalCount = await Reel.countDocuments();
        } else {
            // Parallel execution for better performance
            [reels, totalCount] = await Promise.all([
                Reel.find()
                    .select('source reelId videoUrl thumbnailUrl caption likes dislikes viewCount saves scrapedAt publishedAt embedding originalKey') // Only select needed fields
                    .populate('source', 'name icon favicon') // Populate source info efficiently with more fields
                    .sort(sortQuery)
                    .skip(actualSkip)
                    .limit(limit)
                    .lean(), // Use lean() for better performance
                Reel.countDocuments()
            ]);
        }

        // Debug log to check source population (remove in production)
        if (reels.length > 0 && process.env.NODE_ENV === 'development') {
            console.log('📊 Sample reel source data:', {
                reelId: reels[0]?.reelId,
                sourceType: typeof reels[0]?.source,
                sourceData: reels[0]?.source,
                hasSourceName: !!reels[0]?.source?.name
            });
        }

        const totalPages = Math.ceil(totalCount / limit);

        // Return direct array if no pagination metadata needed (for mobile apps)
        if (req.query.simple === 'true') {
            return res.json(reels);
        }

        res.json({
            reels,
            pagination: {
                currentPage: page,
                totalPages,
                totalCount,
                limit,
                hasNextPage: page < totalPages,
                hasPreviousPage: page > 1,
                nextPage: page < totalPages ? page + 1 : null,
                previousPage: page > 1 ? page - 1 : null
            }
        });
    } catch (err) {
        console.error('Error fetching reels:', err.message);
        res.status(500).json({ error: 'Failed to fetch reels' });
    }
});

// ===================== NEW: VIEW TRACKING ROUTE =====================
router.post('/reels/:reelId/view', async (req, res) => {
    try {
        const { reelId } = req.params;

        if (!reelId) {
            return res.status(400).json({ error: 'Missing reelId' });
        }

        // Find and update the reel's view count
        const reel = await Reel.findByIdAndUpdate(
            reelId,
            {
                $inc: { viewCount: 1 }
            },
            {
                new: true,
                select: 'viewCount likes dislikes saves'
            }
        );

        if (!reel) {
            return res.status(404).json({ error: 'Reel not found' });
        }

        // Optionally track user viewing history if user is authenticated
        const authToken = req.headers.authorization?.replace('Bearer ', '');
        if (authToken) {
            try {
                // You can add user tracking logic here if needed
                // For now, just acknowledge the authenticated view
                console.log(`👀 Authenticated view tracked for reel ${reelId}`);
            } catch (err) {
                // Don't fail the request if user tracking fails
                console.warn('Warning: Could not track user view:', err.message);
            }
        }

        res.json({
            success: true,
            viewCount: reel.viewCount,
            likes: reel.likes,
            dislikes: reel.dislikes,
            saves: reel.saves
        });
    } catch (err) {
        console.error('Error tracking view:', err.message);
        res.status(500).json({ error: 'Failed to track view' });
    }
});

// ===================== NEW: UPLOAD REEL ROUTE =====================
router.post('/reels/upload', async (req, res) => {
    try {
        const { reelUrl, caption, sourceId } = req.body;
        console.log(`📥 Received upload request: ${JSON.stringify({ reelUrl, caption, sourceId })}`);

        if (!reelUrl || !caption || !sourceId) {
            return res.status(400).json({ message: 'Missing required fields.' });
        }

        // 1. Get direct video URL from Instagram
        console.log('🔍 Extracting direct video URL...');
        const directVideoUrl = await getInstagramVideoUrl(reelUrl);
        console.log(`🎯 Extracted video URL: ${directVideoUrl}`);

        // 2. Upload to S3 and get signed URL
        const filename = `gulfio-${Date.now()}.mp4`;
        const { signedUrl, key } = await uploadToR2(directVideoUrl, filename);

        // 3. Generate AI embedding
        const embedInput = `${caption}\n\n${reelUrl}`;
        const embedding = await getDeepSeekEmbedding(embedInput);

        // 4. Save to MongoDB
        const newReel = new Reel({
            videoUrl: signedUrl,       // ✅ signed S3 URL string
            originalKey: key,          // ✅ stored for refresh
            caption,
            source: sourceId,
            reelId: filename,
            scrapedAt: new Date(),
            updatedAt: new Date(),
            embedding
        });

        const savedReel = await newReel.save();

        // 5. Generate thumbnail in background (don't wait for it)
        try {
            const { thumbnailGenerator } = require('../services/ThumbnailGenerator');
            console.log('🎬 Generating thumbnail for new reel...');
            
            // Generate thumbnail asynchronously
            thumbnailGenerator.generateForNewVideo(signedUrl, savedReel._id)
                .then(thumbnailUrl => {
                    if (thumbnailUrl) {
                        // Update the reel with thumbnail URL
                        Reel.findByIdAndUpdate(savedReel._id, { thumbnailUrl })
                            .then(() => console.log(`✅ Thumbnail generated for ${savedReel._id}: ${thumbnailUrl}`))
                            .catch(err => console.error(`❌ Failed to update reel with thumbnail: ${err.message}`));
                    }
                })
                .catch(err => {
                    console.warn(`⚠️ Thumbnail generation failed for ${savedReel._id}: ${err.message}`);
                });
        } catch (thumbnailError) {
            console.warn(`⚠️ Thumbnail service not available: ${thumbnailError.message}`);
        }

        res.json({ message: '✅ Reel uploaded and saved!', reel: savedReel });

    } catch (err) {
        console.error('❌ Upload failed:', err);
        res.status(500).json({ message: 'Upload failed', error: err.message });
    }
});

// ============= Instagram refresh route remains unchanged =============
router.post('/:id/instagram/refresh', async (req, res) => {
    try {
        const source = await Source.findById(req.params.id);
        if (!source || !source.instagramUsername) {
            return res.status(404).json({ error: 'No Instagram username configured for this source' });
        }
        const reels = await scrapeReelsForSource(source._id, source.instagramUsername);
        res.json({
            message: `✅ Scraped ${reels.length} reels for @${source.instagramUsername}`,
            count: reels.length,
            data: reels,
        });
    } catch (err) {
        console.error('❌ Error refreshing Instagram reels:', err);
        res.status(500).json({ error: err.message });
    }
});

// Add caching for frequently accessed data
const reelCache = new NodeCache({ stdTTL: 300 }); // 5 minutes cache

router.get('/reels/trending', async (req, res) => {
    try {
        const cacheKey = 'trending-reels';
        const cached = reelCache.get(cacheKey);

        if (cached) {
            return res.json(cached);
        }

        const trending = await Reel.find()
            .select('source reelId videoUrl thumbnailUrl caption likes dislikes viewCount saves scrapedAt publishedAt')
            .populate('source', 'name icon favicon') // Populate source info
            .sort({ viewCount: -1, likes: -1 })
            .limit(20)
            .lean();

        reelCache.set(cacheKey, trending);
        res.json(trending);
    } catch (err) {
        console.error('Error fetching trending reels:', err.message);
        res.status(500).json({ error: 'Failed to fetch trending reels' });
    }
});

// Add personalized recommendations endpoint
router.post('/reels/recommendations', async (req, res) => {
    try {
        const { embedding, limit = 10 } = req.body;

        if (!embedding || !Array.isArray(embedding)) {
            return res.status(400).json({ error: 'Valid embedding array required' });
        }

        const reels = await Reel.find({
            embedding: { $exists: true, $type: 'array' }
        })
            .select('source reelId videoUrl thumbnailUrl caption likes dislikes viewCount saves scrapedAt publishedAt embedding')
            .populate('source', 'name icon favicon') // Populate source info
            .lean();

        // Calculate similarity and sort
        const reelsWithSimilarity = reels.map(reel => {
            const similarity = cosineSimilarity(embedding, reel.embedding);
            return { ...reel, similarity };
        }).sort((a, b) => b.similarity - a.similarity);

        res.json(reelsWithSimilarity.slice(0, limit));
    } catch (err) {
        console.error('Error fetching recommendations:', err.message);
        res.status(500).json({ error: 'Failed to fetch recommendations' });
    }
});

// Add route to check for orphaned reels and fix source issues
router.get('/reels/debug', async (req, res) => {
    try {
        // Check for reels with invalid source references
        const [totalReels, reelsWithSource, reelsWithPopulatedSource] = await Promise.all([
            Reel.countDocuments(),
            Reel.countDocuments({ source: { $exists: true } }),
            Reel.find().populate('source').lean()
        ]);

        const validSources = reelsWithPopulatedSource.filter(reel => reel.source !== null);
        const invalidSources = reelsWithPopulatedSource.filter(reel => reel.source === null);

        console.log('📊 Debug stats:', {
            totalReels,
            reelsWithSource,
            validSources: validSources.length,
            invalidSources: invalidSources.length
        });

        res.json({
            totalReels,
            reelsWithSource,
            validSources: validSources.length,
            invalidSources: invalidSources.length,
            invalidSourceIds: invalidSources.map(r => r._id),
            sampleValidSource: validSources[0]?.source || null
        });
    } catch (err) {
        console.error('Debug error:', err);
        res.status(500).json({ error: err.message });
    }
});
// Refresh signed S3 URLs for all Reels — for Google Cloud Scheduler
router.post('/reels/refresh-urls', async (req, res) => {
    try {
        const secret = req.headers['x-api-key'];
        if (secret !== process.env.ADMIN_API_KEY) {
            return res.status(403).json({ error: 'Forbidden' });
        }

        const reels = await Reel.find({}, '_id originalKey');

        let updatedCount = 0;
        for (const reel of reels) {
            try {
                const command = new GetObjectCommand({
                    Bucket: AWS_S3_BUCKET,
                    Key: reel.originalKey
                });

                const newSignedUrl = await getSignedUrl(s3, command, {
                    expiresIn: 60 * 60 * 24 * 7 // 7 days
                });

                await Reel.updateOne({ _id: reel._id }, {
                    $set: {
                        videoUrl: newSignedUrl,
                        updatedAt: new Date()
                    }
                });

                updatedCount++;
            } catch (err) {
                console.warn(`⚠️ Failed to refresh ${reel.originalKey}: ${err.message}`);
            }
        }

        res.json({
            message: `✅ Refreshed ${updatedCount} reel video URLs`,
            count: updatedCount
        });
    } catch (err) {
        console.error('❌ Failed to refresh reel URLs:', err);
        res.status(500).json({ error: err.message });
    }
});


module.exports = router;
