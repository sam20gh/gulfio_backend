/**
 * Enhanced Video/Reel Routes with Personalized Recommendations
 * 
 * PERSONALIZATION FEATURES:
 * - 🎯 Smart user preference detection based on interaction history
 * - 🔄 Three recommendation strategies: Discovery, Balanced, Personalized
 * - 🎲 Intelligent content mixing: Fresh + Popular + Trending + Random
 * - 🚫 Duplicate avoidance using recently viewed tracking
 * - 📊 Source variety enforcement (max 33% from any single source)
 * - 🧠 AI embedding-based similarity recommendations
 * - ⚡ Enhanced view tracking with user activity logging
 * - 👤 Complete interaction system (like, dislike, save, view)
 * 
 * CONTENT STRATEGY BY USER TYPE:
 * - New Users (0-10 interactions): Discovery mode with popular/trending content
 * - Moderate Users (10-50 interactions): Balanced mix of preferences + discovery
 * - Active Users (50+ interactions): Heavily personalized using AI embeddings
 * 
 * API ENDPOINTS:
 * - GET /reels?sort=personalized - Main personalized feed (default for logged users)
 * - POST /reels/:id/view - Enhanced view tracking with user data
 * - POST /reels/:id/like|dislike|save - User interaction tracking
 * - POST /reels/interaction-status - Bulk interaction status check
 * - GET /user/preferences - User's personalization data
 * - POST /user/clear-history - Privacy: clear user interaction history
 */

const express = require('express');
const Video = require('../models/Video');
const Reel = require('../models/Reel');
const Source = require('../models/Source');
const UserActivity = require('../models/UserActivity');
const puppeteer = require('puppeteer');
const axios = require('axios'); // Replace fetch with axios
const { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { getDeepSeekEmbedding } = require('../utils/deepseek');
const { convertToPCAEmbedding } = require('../utils/pcaEmbedding');
const { igdl } = require('btch-downloader');// Adjust the path as needed
const NodeCache = require('node-cache');
const redis = require('../utils/redis'); // Ensure Redis is set up
const crypto = require('crypto');
const mongoose = require('mongoose');
const router = express.Router();

// You should have dotenv.config() in your main entrypoint (not needed here if already loaded)
const {
    AWS_S3_REGION,
    AWS_S3_BUCKET,
    AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY,
    ADMIN_API_KEY
} = process.env;

// Debug AWS configuration
console.log('🔧 AWS Configuration Debug:', {
    region: AWS_S3_REGION ? 'Set' : 'Missing',
    bucket: AWS_S3_BUCKET ? 'Set' : 'Missing',
    accessKeyId: AWS_ACCESS_KEY_ID ? 'Set' : 'Missing',
    secretKey: AWS_SECRET_ACCESS_KEY ? 'Set' : 'Missing'
});

function cosineSimilarity(vec1, vec2) {
    const dotProduct = vec1.reduce((sum, val, i) => sum + val * vec2[i], 0);
    const magnitudeA = Math.sqrt(vec1.reduce((sum, val) => sum + val * val, 0));
    const magnitudeB = Math.sqrt(vec2.reduce((sum, val) => sum + val * val, 0));
    return dotProduct / (magnitudeA * magnitudeB);
}

// Helper: Intelligent shuffle that maintains some structure while randomizing
function intelligentShuffle(reels, seed = Date.now()) {
    // Use seed for consistent randomization if needed
    Math.seedrandom = Math.seedrandom || function (seed) {
        const m = 2147483647; // 2^31 - 1
        let a = 1103515245;
        let c = 12345;
        let state = seed ? seed : Math.floor(Math.random() * (m - 1));

        return function () {
            state = (a * state + c) % m;
            return state / m;
        };
    };

    const rng = Math.seedrandom(seed);
    const result = [...reels];

    // Weighted Fisher-Yates shuffle - prioritizes higher weight items towards the beginning
    for (let i = result.length - 1; i > 0; i--) {
        // Adjust swap probability based on content weight
        const currentWeight = result[i].weight || 0.5;
        const swapProbability = currentWeight * rng();

        if (swapProbability > 0.3) { // Threshold for swapping
            const j = Math.floor(rng() * (i + 1));
            [result[i], result[j]] = [result[j], result[i]];
        }
    }

    return result;
}

// Add completion rate to scoring
async function scoreReel(reel, userPrefs, isFresh = false) {
    const now = new Date();
    const userEmbedding = userPrefs.averageEmbedding;
    const reelEmbedding = reel.embedding_pca || reel.embedding;

    let similarity = 0;
    if (userEmbedding && reelEmbedding) {
        similarity = reel._searchScore || cosineSimilarity(userEmbedding, reelEmbedding);
    }

    const reelAge = now - new Date(reel.scrapedAt || reel.publishedAt);
    const hoursAge = reelAge / (1000 * 60 * 60);
    const freshnessBonus = hoursAge < 1 ? 0.5 : hoursAge < 24 ? 0.3 : hoursAge < 72 ? 0.1 : 0;
    const recencyScore = Math.max(0, 1 - (hoursAge / 168));

    const maxViews = 10000;
    const engagementScore = Math.min(1, (reel.viewCount || 0) / maxViews) * 0.3 +
        Math.min(1, (reel.likes || 0) / 1000) * 0.2 +
        (reel.completionRate || 0) * 0.5; // New: completion rate

    const finalScore = (
        similarity * 0.3 +
        recencyScore * 0.3 +
        engagementScore * 0.3 +
        (isFresh ? freshnessBonus : 0) * 0.1
    );

    return { ...reel, similarity, recencyScore, engagementScore, finalScore, isFresh };
}

// Helper: Get user preferences based on interaction history
async function getUserPreferences(userId) {
    try {
        const recentActivity = await UserActivity.find({
            userId,
            eventType: { $in: ['view', 'like', 'save'] }
        })
            .populate('articleId', 'category embedding')
            .sort({ timestamp: -1 })
            .limit(100)
            .lean();

        // Also check reel interactions from the Reel model
        const likedReels = await Reel.find({
            likedBy: userId
        }).select('source categories embedding').populate('source', 'name').lean();

        const savedReels = await Reel.find({
            savedBy: userId
        }).select('source categories embedding').populate('source', 'name').lean();

        const viewedReels = await Reel.find({
            viewedBy: userId
        }).select('source categories embedding').populate('source', 'name').lean();

        // Analyze preferences
        const sourcePreferences = {};
        const categoryPreferences = {};
        const interactionWeights = { like: 3, save: 2.5, view: 1 };

        // Process reel interactions
        [...likedReels.map(r => ({ ...r, type: 'like' })),
        ...savedReels.map(r => ({ ...r, type: 'save' })),
        ...viewedReels.map(r => ({ ...r, type: 'view' }))].forEach(reel => {
            const weight = interactionWeights[reel.type] || 1;

            // Source preferences
            const sourceName = reel.source?.name || 'Unknown';
            sourcePreferences[sourceName] = (sourcePreferences[sourceName] || 0) + weight;

            // Category preferences
            if (reel.categories) {
                reel.categories.forEach(category => {
                    categoryPreferences[category] = (categoryPreferences[category] || 0) + weight;
                });
            }
        });

        // Calculate average embedding for content-based recommendations
        let averageEmbedding = null;
        const validEmbeddings = [...likedReels, ...savedReels]
            .filter(reel => reel.embedding && reel.embedding.length > 0)
            .map(reel => reel.embedding);

        if (validEmbeddings.length > 0) {
            const embeddingSize = validEmbeddings[0].length;
            averageEmbedding = new Array(embeddingSize).fill(0);

            validEmbeddings.forEach(embedding => {
                embedding.forEach((value, index) => {
                    averageEmbedding[index] += value;
                });
            });

            averageEmbedding = averageEmbedding.map(sum => sum / validEmbeddings.length);
        }

        return {
            sourcePreferences: Object.entries(sourcePreferences)
                .sort(([, a], [, b]) => b - a)
                .slice(0, 10), // Top 10 sources
            categoryPreferences: Object.entries(categoryPreferences)
                .sort(([, a], [, b]) => b - a)
                .slice(0, 10), // Top 10 categories
            averageEmbedding,
            totalInteractions: likedReels.length + savedReels.length + viewedReels.length,
            recentActivityCount: recentActivity.length
        };
    } catch (error) {
        console.error('Error getting user preferences:', error);
        return {
            sourcePreferences: [],
            categoryPreferences: [],
            averageEmbedding: null,
            totalInteractions: 0,
            recentActivityCount: 0
        };
    }
}

// Helper: Get personalized reels for a user with Atlas Search
async function getPersonalizedReels(req, res, userId, limit, page, skip) {
    try {
        console.log(`🎯 Getting personalized reels for user ${userId}`);
        const sessionId = req.query.sessionId || crypto.randomUUID(); // For dynamism
        const cacheKey = `reels_personalized_${userId}_page_${page}_limit_${limit}_session_${sessionId}`;

        // Check Redis cache
        let cached;
        try {
            cached = await redis.get(cacheKey);
        } catch (err) {
            console.error('⚠️ Redis get error:', err.message);
        }

        if (cached) {
            console.log('🧠 Returning cached reels');
            return res.json(JSON.parse(cached));
        }

        // Get user preferences
        const userPrefs = await getUserPreferences(userId);
        const userEmbedding = userPrefs.averageEmbedding?.slice(0, 128); // Ensure 128D
        const lastSeenReelIds = await UserActivity.find({ userId, eventType: 'view' })
            .sort({ timestamp: -1 })
            .limit(100)
            .distinct('articleId');

        let reels = [];
        if (!userEmbedding || !Array.isArray(userEmbedding) || userEmbedding.length !== 128) {
            console.warn('Falling back to engagement-based sorting');
            reels = await Reel.find({
                _id: { $nin: lastSeenReelIds.concat(userPrefs.disliked_videos || []) }
            })
                .populate('source')
                .sort({ viewCount: -1, scrapedAt: -1 })
                .skip(skip)
                .limit(limit * 2)
                .lean();
        } else {
            // Atlas Search kNN query
            reels = await Reel.aggregate([
                {
                    $search: {
                        index: 'reel_vector_index',
                        knnBeta: {
                            vector: userEmbedding,
                            path: 'embedding_pca',
                            k: limit * 2,
                            filter: {
                                compound: {
                                    mustNot: [{ terms: { path: '_id', value: lastSeenReelIds.concat(userPrefs.disliked_videos || []) } }]
                                }
                            }
                        }
                    }
                },
                { $limit: limit * 2 },
                { $lookup: { from: 'sources', localField: 'source', foreignField: '_id', as: 'source' } },
                { $unwind: { path: '$source', preserveNullAndEmptyArrays: true } }
            ]);

            // Score reels
            reels = reels.map(reel => scoreReel(reel, userPrefs, reel.scrapedAt > new Date(Date.now() - 24 * 60 * 60 * 1000)));
        }

        // Inject trending reels (10%)
        const trendingLimit = Math.ceil(limit * 0.1);
        const trendingReels = await Reel.find({
            _id: { $nin: reels.map(r => r._id).concat(lastSeenReelIds, userPrefs.disliked_videos || []) },
            viewCount: { $exists: true },
            scrapedAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
        })
            .populate('source')
            .sort({ viewCount: -1, scrapedAt: -1 })
            .limit(trendingLimit)
            .lean();

        const trendingEnhanced = trendingReels.map(reel => ({
            ...reel,
            isTrending: true
        }));

        // Inject exploratory reels (20%)
        const exploratoryLimit = Math.ceil(limit * 0.2);
        const exploratoryReels = await Reel.aggregate([
            { $match: { _id: { $nin: reels.map(r => r._id).concat(lastSeenReelIds, userPrefs.disliked_videos || []) } } },
            { $sample: { size: exploratoryLimit } },
            { $lookup: { from: 'sources', localField: 'source', foreignField: '_id', as: 'source' } },
            { $unwind: { path: '$source', preserveNullAndEmptyArrays: true } }
        ]);

        const exploratoryEnhanced = exploratoryReels.map(reel => ({
            ...reel,
            isExploratory: true
        }));

        // Combine, sort, and shuffle for dynamism
        let finalReels = [...reels.sort((a, b) => (b.finalScore || 0) - (a.finalScore || 0)).slice(0, limit - trendingLimit - exploratoryLimit), ...trendingEnhanced, ...exploratoryEnhanced];
        finalReels = intelligentShuffle(finalReels, sessionId).slice(0, limit);

        // Cache results
        try {
            await redis.set(cacheKey, JSON.stringify(finalReels), 'EX', 3600); // 1h TTL
        } catch (err) {
            console.error('⚠️ Redis set error:', err.message);
        }

        console.log(`🎯 Recommendations: ${finalReels.length} reels`, {
            limit,
            embeddingType: 'PCA (128d)',
            excludedCount: lastSeenReelIds.length,
            trendingCount: trendingEnhanced.length,
            exploratoryCount: exploratoryEnhanced.length,
            avgSimilarity: (finalReels.reduce((sum, r) => sum + (r.similarity || 0), 0) / finalReels.length).toFixed(3)
        });

        res.json(finalReels);
    } catch (err) {
        console.error('Error fetching recommendations:', err.message);
        res.status(500).json({ error: 'Failed to fetch recommendations' });
    }
}

// Helper: Get embedding-based recommendations
async function getEmbeddingBasedReels(userEmbedding, limit, excludeIds = []) {
    try {
        const usePCA = userEmbedding.length === 128;
        const embeddingField = usePCA ? 'embedding_pca' : 'embedding';

        const reelsWithEmbeddings = await Reel.find({
            [embeddingField]: { $exists: true, $type: 'array' },
            _id: { $nin: excludeIds }
        })
            .select(`source reelId videoUrl thumbnailUrl caption likes dislikes viewCount saves scrapedAt publishedAt ${embeddingField} originalKey`)
            .populate('source', 'name icon favicon')
            .lean();

        // Calculate similarity scores
        const scoredReels = reelsWithEmbeddings.map(reel => {
            const reelEmbedding = usePCA ? reel.embedding_pca : reel.embedding;
            const similarity = cosineSimilarity(userEmbedding, reelEmbedding);

            // Add small random factor to prevent identical recommendations
            const randomFactor = (Math.random() - 0.5) * 0.1; // ±0.05
            const finalScore = similarity + randomFactor;

            return {
                ...reel,
                similarity: finalScore
            };
        });

        // Sort by similarity and return top results
        return scoredReels
            .sort((a, b) => b.similarity - a.similarity)
            .slice(0, limit);

    } catch (error) {
        console.error('Error getting embedding-based reels:', error);
        return [];
    }
}

// Helper: Remove duplicates and ensure source variety
function removeDuplicatesAndEnsureVariety(reels, targetLimit) {
    const seen = new Set();
    const sourceCount = {};
    const maxPerSource = Math.ceil(targetLimit / 3); // Max 33% from any single source

    return reels.filter(reel => {
        const reelId = reel._id.toString();
        const sourceId = reel.source?._id?.toString() || 'unknown';
        const sourceName = reel.source?.name || 'Unknown';

        // Check for duplicates
        if (seen.has(reelId)) {
            return false;
        }

        // Check source variety
        const currentSourceCount = sourceCount[sourceId] || 0;
        if (currentSourceCount >= maxPerSource) {
            return false;
        }

        seen.add(reelId);
        sourceCount[sourceId] = currentSourceCount + 1;

        return true;
    }).slice(0, targetLimit);
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
let s3;
try {
    s3 = new S3Client({
        region: AWS_S3_REGION || 'me-central-1',
        credentials: {
            accessKeyId: AWS_ACCESS_KEY_ID,
            secretAccessKey: AWS_SECRET_ACCESS_KEY,
        },
    });
    console.log('✅ S3 Client initialized successfully');
} catch (error) {
    console.error('❌ Failed to initialize S3 Client:', error);
    throw new Error(`S3 Client initialization failed: ${error.message}`);
}

async function uploadToR2(videoUrl, filename) {
    try {
        console.log(`🔄 Starting upload to R2: ${filename}`);
        console.log(`📥 Downloading video from: ${videoUrl}`);

        const response = await axios({
            method: 'get',
            url: videoUrl,
            responseType: 'arraybuffer',
            timeout: 60000, // 60 second timeout
            maxContentLength: 100 * 1024 * 1024, // 100MB max
        });

        console.log(`📊 Video downloaded: ${response.data.length} bytes`);
        const buffer = Buffer.from(response.data);

        if (!AWS_S3_BUCKET) {
            throw new Error('AWS_S3_BUCKET environment variable is not set');
        }

        const command = new PutObjectCommand({
            Bucket: AWS_S3_BUCKET,
            Key: filename,
            Body: buffer,
            ContentType: 'video/mp4',
        });

        console.log(`🚀 Uploading to S3 bucket: ${AWS_S3_BUCKET}`);
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

        console.log(`🔗 Generated signed URL: ${signedUrl.substring(0, 100)}...`);
        return { signedUrl, key: filename };
    } catch (error) {
        console.error('❌ Error in uploadToR2:', error);
        console.error('❌ Error details:', {
            message: error.message,
            code: error.code,
            statusCode: error.statusCode,
            region: AWS_S3_REGION,
            bucket: AWS_S3_BUCKET,
            hasCredentials: !!(AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY)
        });
        throw new Error(`Failed to upload to R2: ${error.message}`);
    }
}

const isSignedS3Url = (u) => {
    if (!u) return false;
    try {
        const url = new URL(u);
        return (
            url.searchParams.has('X-Amz-Signature') ||
            url.searchParams.has('X-Amz-Credential') ||
            url.searchParams.has('X-Amz-Security-Token')
        );
    } catch {
        return false;
    }
};

const extractKeyFromUrl = (u, bucket = AWS_S3_BUCKET, region = AWS_S3_REGION) => {
    try {
        const url = new URL(u);
        const host = url.hostname.toLowerCase();
        const path = decodeURIComponent(url.pathname || '/');

        // virtual-hosted style
        const vhHosts = new Set([
            `${bucket}.s3.${region}.amazonaws.com`,
            `${bucket}.s3.amazonaws.com`
        ]);
        if (vhHosts.has(host)) return path.replace(/^\/+/, '');

        // path style
        if (host === `s3.${region}.amazonaws.com` || host === 's3.amazonaws.com') {
            const parts = path.split('/').filter(Boolean);
            if (parts.length >= 2 && parts[0] === bucket) return parts.slice(1).join('/');
        }

        return null;
    } catch {
        return null;
    }
};
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
        const sort = req.query.sort || 'personalized'; // personalized, recent, random, mixed
        const seed = req.query.seed || Date.now(); // For consistent random ordering

        // Performance improvement: Use skip/limit parameter instead of page parameter
        const actualSkip = parseInt(req.query.skip) || skip;

        // Extract user information from token (if available)
        const authToken = req.headers.authorization?.replace('Bearer ', '');
        let userId = null;
        let userPreferences = null;

        if (authToken) {
            try {
                const jwt = require('jsonwebtoken');
                const decoded = jwt.decode(authToken);
                userId = decoded?.sub || decoded?.user_id || decoded?.id;
                console.log(`👤 Personalized feed for user: ${userId}`);
            } catch (err) {
                console.warn('⚠️ Could not decode user token for personalization:', err.message);
            }
        }

        // If user is logged in, provide personalized content
        if (userId && (sort === 'personalized' || sort === 'mixed')) {
            return await getPersonalizedReels(req, res, userId, limit, page, actualSkip);
        }

        // Fallback to original logic for anonymous users or specific sort requests
        let sortQuery = { scrapedAt: -1 }; // Default: most recent first
        let aggregationPipeline = [];

        if (sort === 'random') {
            // Enhanced random sampling with better distribution
            const totalReels = await Reel.countDocuments();
            const sampleSize = Math.min(limit * 8, Math.max(totalReels * 0.1, 100)); // Sample 10% of total or at least 100

            aggregationPipeline = [
                { $sample: { size: sampleSize } },
                // Add variety scoring
                {
                    $addFields: {
                        varietyScore: {
                            $add: [
                                { $multiply: ['$viewCount', 0.3] },
                                { $multiply: ['$likes', 0.4] },
                                { $multiply: [{ $rand: {} }, 1000] }, // Random factor
                                {
                                    $multiply: [
                                        {
                                            $divide: [
                                                { $subtract: [new Date(), '$scrapedAt'] },
                                                1000 * 60 * 60 * 24 // Convert to days
                                            ]
                                        },
                                        -0.1 // Slight penalty for older content
                                    ]
                                }
                            ]
                        }
                    }
                },
                { $sort: { varietyScore: -1 } },
                { $skip: actualSkip },
                { $limit: limit }
            ];
        } else if (sort === 'mixed') {
            // Enhanced mixed content with better distribution
            const recentLimit = Math.ceil(limit * 0.35); // 35% recent
            const popularLimit = Math.ceil(limit * 0.25); // 25% popular
            const trendingLimit = Math.ceil(limit * 0.25); // 25% trending (high engagement)
            const randomLimit = limit - recentLimit - popularLimit - trendingLimit; // 15% random

            // Get different types of content with exclusions to avoid duplicates
            const [recent, popular, trending, random] = await Promise.all([
                Reel.find()
                    .select('source reelId videoUrl thumbnailUrl caption likes dislikes viewCount saves scrapedAt publishedAt embedding originalKey')
                    .populate('source', 'name icon favicon')
                    .sort({ scrapedAt: -1 })
                    .limit(recentLimit * 2) // Get more to allow for filtering
                    .lean(),
                Reel.find()
                    .select('source reelId videoUrl thumbnailUrl caption likes dislikes viewCount saves scrapedAt publishedAt embedding originalKey')
                    .populate('source', 'name icon favicon')
                    .sort({ viewCount: -1, likes: -1 })
                    .limit(popularLimit * 2)
                    .lean(),
                Reel.find({
                    $expr: {
                        $gt: [
                            { $add: ['$likes', { $multiply: ['$viewCount', 0.1] }] },
                            50 // Minimum engagement threshold
                        ]
                    }
                })
                    .select('source reelId videoUrl thumbnailUrl caption likes dislikes viewCount saves scrapedAt publishedAt embedding originalKey')
                    .populate('source', 'name icon favicon')
                    .sort({ likes: -1, viewCount: -1 })
                    .limit(trendingLimit * 2)
                    .lean(),
                Reel.aggregate([
                    { $sample: { size: randomLimit * 3 } },
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

            // Remove duplicates and ensure variety
            const usedIds = new Set();
            const sourceCount = {};
            const maxPerSource = Math.ceil(limit / 4); // Max 25% from any single source

            const selectReels = (reelArray, targetCount) => {
                return reelArray
                    .filter(reel => {
                        const reelId = reel._id.toString();
                        const sourceId = reel.source?._id?.toString() || 'unknown';
                        const sourceCurrentCount = sourceCount[sourceId] || 0;

                        if (usedIds.has(reelId) || sourceCurrentCount >= maxPerSource) {
                            return false;
                        }

                        usedIds.add(reelId);
                        sourceCount[sourceId] = sourceCurrentCount + 1;
                        return true;
                    })
                    .slice(0, targetCount);
            };

            // Select reels ensuring variety
            const selectedRecent = selectReels(recent, recentLimit);
            const selectedPopular = selectReels(popular, popularLimit);
            const selectedTrending = selectReels(trending, trendingLimit);
            const selectedRandom = selectReels(random, randomLimit);

            // Combine and shuffle with weighted randomization
            const allSelected = [
                ...selectedRecent.map(r => ({ ...r, contentType: 'recent', weight: 1.0 })),
                ...selectedPopular.map(r => ({ ...r, contentType: 'popular', weight: 0.8 })),
                ...selectedTrending.map(r => ({ ...r, contentType: 'trending', weight: 0.9 })),
                ...selectedRandom.map(r => ({ ...r, contentType: 'random', weight: 0.7 }))
            ];

            // Intelligent shuffle that maintains some structure
            const shuffledReels = intelligentShuffle(allSelected, seed);

            console.log(`🎯 Mixed content distribution:`, {
                recent: selectedRecent.length,
                popular: selectedPopular.length,
                trending: selectedTrending.length,
                random: selectedRandom.length,
                total: shuffledReels.length,
                sourcesUsed: Object.keys(sourceCount).length
            });

            return res.json(req.query.simple === 'true' ? shuffledReels : {
                reels: shuffledReels,
                pagination: {
                    currentPage: page,
                    totalPages: Math.ceil(1000 / limit), // Approximate for mixed content
                    totalCount: shuffledReels.length,
                    limit,
                    hasNextPage: true,
                    hasPreviousPage: page > 1,
                    nextPage: page + 1,
                    previousPage: page > 1 ? page - 1 : null
                },
                contentMix: {
                    recent: selectedRecent.length,
                    popular: selectedPopular.length,
                    trending: selectedTrending.length,
                    random: selectedRandom.length
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

// ===================== NEW: ENHANCED VIEW TRACKING ROUTE =====================
router.post('/reels/:reelId/view', async (req, res) => {
    try {
        const { reelId } = req.params;
        const { duration } = req.body; // Optional: how long the user viewed

        if (!reelId) {
            return res.status(400).json({ error: 'Missing reelId' });
        }

        // Extract user information from token (if available)
        const authToken = req.headers.authorization?.replace('Bearer ', '');
        let userId = null;

        if (authToken) {
            try {
                const jwt = require('jsonwebtoken');
                const decoded = jwt.decode(authToken);
                userId = decoded?.sub || decoded?.user_id || decoded?.id;
            } catch (err) {
                console.warn('Warning: Could not decode user token for view tracking:', err.message);
            }
        }

        // Find and update the reel's view count and user tracking
        const updateQuery = { $inc: { viewCount: 1 } };

        // Add user to viewedBy array if authenticated (avoid duplicates)
        if (userId) {
            updateQuery.$addToSet = { viewedBy: userId };
        }

        const reel = await Reel.findByIdAndUpdate(
            reelId,
            updateQuery,
            {
                new: true,
                select: 'viewCount likes dislikes saves viewedBy source'
            }
        ).populate('source', '_id name');

        if (!reel) {
            return res.status(404).json({ error: 'Reel not found' });
        }

        // Track user activity for personalization if user is authenticated
        if (userId) {
            try {
                // Create or update UserActivity record for reels
                // Note: We'll extend UserActivity to support reels or create a separate ReelActivity model
                const activityData = {
                    userId,
                    eventType: 'view',
                    articleId: reelId, // We can reuse this field or rename it to contentId
                    duration: duration || null,
                    timestamp: new Date()
                };

                // Try to create activity record (non-blocking)
                await UserActivity.create(activityData).catch(err => {
                    console.warn(`Could not create activity record: ${err.message}`);
                });

                console.log(`👀 User ${userId} viewed reel ${reelId} (duration: ${duration || 'unknown'}s)`);
            } catch (err) {
                // Don't fail the request if activity tracking fails
                console.warn('Warning: Could not track user activity:', err.message);
            }
        }

        res.json({
            success: true,
            viewCount: reel.viewCount,
            likes: reel.likes,
            dislikes: reel.dislikes,
            saves: reel.saves,
            isAuthenticated: !!userId,
            personalizedRecommendations: userId ? true : false
        });
    } catch (err) {
        console.error('Error tracking view:', err.message);
        res.status(500).json({ error: 'Failed to track view' });
    }
});

// ===================== NEW: ENHANCED INTERACTION ROUTES =====================
router.post('/reels/:reelId/like', async (req, res) => {
    try {
        const { reelId } = req.params;
        const authToken = req.headers.authorization?.replace('Bearer ', '');

        if (!authToken) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        let userId;
        try {
            const jwt = require('jsonwebtoken');
            const decoded = jwt.decode(authToken);
            userId = decoded?.sub || decoded?.user_id || decoded?.id;
        } catch (err) {
            return res.status(401).json({ error: 'Invalid token' });
        }

        // Toggle like status
        const reel = await Reel.findById(reelId);
        if (!reel) {
            return res.status(404).json({ error: 'Reel not found' });
        }

        const isLiked = reel.likedBy.includes(userId);
        const isDisliked = reel.dislikedBy.includes(userId);

        let updateQuery = {};

        if (isLiked) {
            // Unlike
            updateQuery = {
                $inc: { likes: -1 },
                $pull: { likedBy: userId }
            };
        } else {
            // Like (and remove from dislikes if present)
            updateQuery = {
                $inc: { likes: 1 },
                $addToSet: { likedBy: userId }
            };

            if (isDisliked) {
                updateQuery.$inc.dislikes = -1;
                updateQuery.$pull = { dislikedBy: userId };
            }
        }

        const updatedReel = await Reel.findByIdAndUpdate(
            reelId,
            updateQuery,
            { new: true, select: 'likes dislikes likedBy dislikedBy' }
        );

        // Track activity
        if (!isLiked) {
            await UserActivity.create({
                userId,
                eventType: 'like',
                articleId: reelId,
                timestamp: new Date()
            }).catch(err => console.warn('Activity tracking failed:', err.message));
        }

        res.json({
            success: true,
            likes: updatedReel.likes,
            dislikes: updatedReel.dislikes,
            isLiked: !isLiked,
            isDisliked: isDisliked && !isLiked ? false : !updatedReel.dislikedBy.includes(userId)
        });
    } catch (err) {
        console.error('Error toggling like:', err.message);
        res.status(500).json({ error: 'Failed to toggle like' });
    }
});

router.post('/reels/:reelId/dislike', async (req, res) => {
    try {
        const { reelId } = req.params;
        const authToken = req.headers.authorization?.replace('Bearer ', '');

        if (!authToken) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        let userId;
        try {
            const jwt = require('jsonwebtoken');
            const decoded = jwt.decode(authToken);
            userId = decoded?.sub || decoded?.user_id || decoded?.id;
        } catch (err) {
            return res.status(401).json({ error: 'Invalid token' });
        }

        const reel = await Reel.findById(reelId);
        if (!reel) {
            return res.status(404).json({ error: 'Reel not found' });
        }

        const isLiked = reel.likedBy.includes(userId);
        const isDisliked = reel.dislikedBy.includes(userId);

        let updateQuery = {};

        if (isDisliked) {
            // Remove dislike
            updateQuery = {
                $inc: { dislikes: -1 },
                $pull: { dislikedBy: userId }
            };
        } else {
            // Dislike (and remove from likes if present)
            updateQuery = {
                $inc: { dislikes: 1 },
                $addToSet: { dislikedBy: userId }
            };

            if (isLiked) {
                updateQuery.$inc.likes = -1;
                updateQuery.$pull = { likedBy: userId };
            }
        }

        const updatedReel = await Reel.findByIdAndUpdate(
            reelId,
            updateQuery,
            { new: true, select: 'likes dislikes likedBy dislikedBy' }
        );

        // Track activity
        if (!isDisliked) {
            await UserActivity.create({
                userId,
                eventType: 'dislike',
                articleId: reelId,
                timestamp: new Date()
            }).catch(err => console.warn('Activity tracking failed:', err.message));
        }

        res.json({
            success: true,
            likes: updatedReel.likes,
            dislikes: updatedReel.dislikes,
            isLiked: isLiked && !isDisliked ? false : !updatedReel.likedBy.includes(userId),
            isDisliked: !isDisliked
        });
    } catch (err) {
        console.error('Error toggling dislike:', err.message);
        res.status(500).json({ error: 'Failed to toggle dislike' });
    }
});

router.post('/reels/:reelId/save', async (req, res) => {
    try {
        const { reelId } = req.params;
        const authToken = req.headers.authorization?.replace('Bearer ', '');

        if (!authToken) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        let userId;
        try {
            const jwt = require('jsonwebtoken');
            const decoded = jwt.decode(authToken);
            userId = decoded?.sub || decoded?.user_id || decoded?.id;
        } catch (err) {
            return res.status(401).json({ error: 'Invalid token' });
        }

        const reel = await Reel.findById(reelId);
        if (!reel) {
            return res.status(404).json({ error: 'Reel not found' });
        }

        const isSaved = reel.savedBy.includes(userId);

        let updateQuery = {};
        let eventType = '';

        if (isSaved) {
            // Unsave
            updateQuery = {
                $inc: { saves: -1 },
                $pull: { savedBy: userId }
            };
            eventType = 'unsave';
        } else {
            // Save
            updateQuery = {
                $inc: { saves: 1 },
                $addToSet: { savedBy: userId }
            };
            eventType = 'save';
        }

        const updatedReel = await Reel.findByIdAndUpdate(
            reelId,
            updateQuery,
            { new: true, select: 'saves savedBy' }
        );

        // Track activity
        await UserActivity.create({
            userId,
            eventType,
            articleId: reelId,
            timestamp: new Date()
        }).catch(err => console.warn('Activity tracking failed:', err.message));

        res.json({
            success: true,
            saves: updatedReel.saves,
            isSaved: !isSaved
        });
    } catch (err) {
        console.error('Error toggling save:', err.message);
        res.status(500).json({ error: 'Failed to toggle save' });
    }
});

// Add completion endpoint
router.post('/reels/:id/completion', async (req, res) => {
    try {
        const authToken = req.headers.authorization?.replace('Bearer ', '');
        if (!authToken) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        const { percent } = req.body;
        const reelId = req.params.id;
        if (!percent || percent < 0 || percent > 100) {
            return res.status(400).json({ error: 'Invalid completion percent' });
        }

        await Reel.updateOne(
            { _id: reelId },
            {
                $push: { completionRates: percent },
                $set: {
                    completionRate: await Reel.aggregate([
                        { $match: { _id: new mongoose.Types.ObjectId(reelId) } },
                        { $unwind: '$completionRates' },
                        { $group: { _id: null, avg: { $avg: '$completionRates' } } }
                    ]).then(res => res[0]?.avg || percent)
                }
            }
        );
        res.json({ message: 'Completion recorded' });
    } catch (err) {
        console.error('Error recording completion:', err.message);
        res.status(500).json({ error: 'Failed to record completion' });
    }
});

// ===================== USER PREFERENCES AND STATS ROUTES =====================
router.get('/user/preferences', async (req, res) => {
    try {
        const authToken = req.headers.authorization?.replace('Bearer ', '');
        if (!authToken) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        let userId;
        try {
            const jwt = require('jsonwebtoken');
            const decoded = jwt.decode(authToken);
            userId = decoded?.sub || decoded?.user_id || decoded?.id;
        } catch (err) {
            return res.status(401).json({ error: 'Invalid token' });
        }

        const preferences = await getUserPreferences(userId);

        res.json({
            success: true,
            userId,
            preferences,
            recommendations: {
                availableStrategies: ['personalized', 'balanced', 'discovery'],
                currentStrategy: preferences.totalInteractions > 50 ? 'personalized' :
                    preferences.totalInteractions > 10 ? 'balanced' : 'discovery'
            }
        });
    } catch (err) {
        console.error('Error getting user preferences:', err.message);
        res.status(500).json({ error: 'Failed to get user preferences' });
    }
});

router.post('/reels/interaction-status', async (req, res) => {
    try {
        const { reelIds } = req.body;
        const authToken = req.headers.authorization?.replace('Bearer ', '');

        if (!authToken) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        if (!reelIds || !Array.isArray(reelIds)) {
            return res.status(400).json({ error: 'reelIds array is required' });
        }

        let userId;
        try {
            const jwt = require('jsonwebtoken');
            const decoded = jwt.decode(authToken);
            userId = decoded?.sub || decoded?.user_id || decoded?.id;
        } catch (err) {
            return res.status(401).json({ error: 'Invalid token' });
        }

        // Get interaction status for multiple reels at once
        const reels = await Reel.find({
            _id: { $in: reelIds }
        }).select('_id likedBy dislikedBy savedBy viewedBy').lean();

        const interactionStatus = {};

        reels.forEach(reel => {
            interactionStatus[reel._id] = {
                isLiked: reel.likedBy.includes(userId),
                isDisliked: reel.dislikedBy.includes(userId),
                isSaved: reel.savedBy.includes(userId),
                isViewed: reel.viewedBy.includes(userId)
            };
        });

        res.json({
            success: true,
            userId,
            interactions: interactionStatus
        });
    } catch (err) {
        console.error('Error getting interaction status:', err.message);
        res.status(500).json({ error: 'Failed to get interaction status' });
    }
});

router.post('/user/clear-history', async (req, res) => {
    try {
        const authToken = req.headers.authorization?.replace('Bearer ', '');
        if (!authToken) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        let userId;
        try {
            const jwt = require('jsonwebtoken');
            const decoded = jwt.decode(authToken);
            userId = decoded?.sub || decoded?.user_id || decoded?.id;
        } catch (err) {
            return res.status(401).json({ error: 'Invalid token' });
        }

        // Clear user from all reel interaction arrays
        const [reelUpdate, activityDelete] = await Promise.all([
            Reel.updateMany(
                {},
                {
                    $pull: {
                        likedBy: userId,
                        dislikedBy: userId,
                        savedBy: userId,
                        viewedBy: userId
                    }
                }
            ),
            UserActivity.deleteMany({ userId })
        ]);

        // Also update counters (this is approximate and may not be perfectly accurate)
        await Reel.updateMany(
            {},
            [
                {
                    $set: {
                        likes: { $size: "$likedBy" },
                        dislikes: { $size: "$dislikedBy" },
                        saves: { $size: "$savedBy" }
                    }
                }
            ]
        );

        console.log(`🗑️ Cleared interaction history for user ${userId}`, {
            reelsModified: reelUpdate.modifiedCount,
            activitiesDeleted: activityDelete.deletedCount
        });

        res.json({
            success: true,
            message: 'User interaction history cleared successfully',
            reelsModified: reelUpdate.modifiedCount,
            activitiesDeleted: activityDelete.deletedCount
        });
    } catch (err) {
        console.error('Error clearing user history:', err.message);
        res.status(500).json({ error: 'Failed to clear user history' });
    }
});

// ===================== NEW: UPLOAD REEL ROUTE =====================
router.post('/reels/upload', async (req, res) => {
    try {
        const { reelUrl, caption, sourceId } = req.body;
        console.log(`📥 Received upload request: ${JSON.stringify({ reelUrl, caption, sourceId })}`);

        if (!reelUrl || !caption || !sourceId) {
            return res.status(400).json({
                message: 'Missing required fields.',
                required: ['reelUrl', 'caption', 'sourceId'],
                received: { reelUrl: !!reelUrl, caption: !!caption, sourceId: !!sourceId }
            });
        }

        // Validate AWS credentials before proceeding
        if (!AWS_S3_REGION || !AWS_S3_BUCKET || !AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY) {
            console.error('❌ Missing AWS credentials:', {
                region: !!AWS_S3_REGION,
                bucket: !!AWS_S3_BUCKET,
                accessKey: !!AWS_ACCESS_KEY_ID,
                secretKey: !!AWS_SECRET_ACCESS_KEY
            });
            return res.status(500).json({
                message: 'Server configuration error: Missing AWS credentials'
            });
        }

        // 1. Get direct video URL from Instagram
        console.log('🔍 Extracting direct video URL...');
        let directVideoUrl;
        try {
            directVideoUrl = await getInstagramVideoUrl(reelUrl);
            console.log(`🎯 Extracted video URL: ${directVideoUrl}`);
        } catch (error) {
            console.error('❌ Failed to extract Instagram video URL:', error);
            return res.status(400).json({
                message: 'Failed to extract video from Instagram URL',
                error: error.message
            });
        }

        // 2. Upload to S3 and get signed URL
        const filename = `gulfio-${Date.now()}.mp4`;
        let uploadResult;
        try {
            uploadResult = await uploadToR2(directVideoUrl, filename);
            console.log(`🎬 Upload completed: ${filename}`);
        } catch (error) {
            console.error('❌ Failed to upload video:', error);
            return res.status(500).json({
                message: 'Failed to upload video to storage',
                error: error.message
            });
        }

        const { signedUrl, key } = uploadResult;

        // 3. Generate AI embedding and PCA embedding
        let embedding, embedding_pca;
        try {
            const embedInput = `${caption}\n\n${reelUrl}`;
            embedding = await getDeepSeekEmbedding(embedInput);
            console.log(`🧠 Generated embedding: ${embedding?.length} dimensions`);

            // Generate PCA embedding if the main embedding was successful
            if (embedding && embedding.length === 1536) {
                embedding_pca = await convertToPCAEmbedding(embedding);
                if (embedding_pca) {
                    console.log(`🧠 Generated PCA embedding: ${embedding_pca.length} dimensions`);
                } else {
                    console.warn('⚠️ Failed to generate PCA embedding, continuing without it');
                }
            }
        } catch (error) {
            console.error('❌ Failed to generate embedding:', error);
            // Continue without embedding - it's not critical for basic functionality
            embedding = null;
            embedding_pca = null;
        }

        // 4. Save to MongoDB
        let savedReel;
        try {
            const newReel = new Reel({
                videoUrl: signedUrl,       // ✅ signed S3 URL string
                originalKey: key,          // ✅ stored for refresh
                caption,
                source: sourceId,
                reelId: filename,
                scrapedAt: new Date(),
                updatedAt: new Date(),
                embedding,
                embedding_pca
            });

            savedReel = await newReel.save();
            console.log(`💾 Saved to MongoDB: ${savedReel._id} with embedding: ${!!embedding}, PCA: ${!!embedding_pca}`);
        } catch (error) {
            console.error('❌ Failed to save to database:', error);
            return res.status(500).json({
                message: 'Failed to save video to database',
                error: error.message
            });
        }

        // 5. Generate thumbnail using ThumbnailGenerator service
        let thumbnailUrl = null;
        try {
            const { thumbnailGenerator } = require('../services/ThumbnailGenerator');
            console.log('🎬 Generating thumbnail for new reel...');

            // Generate thumbnail synchronously for immediate feedback
            thumbnailUrl = await thumbnailGenerator.generateThumbnail(signedUrl, savedReel._id);
            
            if (thumbnailUrl) {
                // Update the reel with thumbnail URL
                await Reel.findByIdAndUpdate(savedReel._id, { 
                    thumbnailUrl,
                    updatedAt: new Date()
                });
                console.log(`✅ Thumbnail generated and saved for ${savedReel._id}: ${thumbnailUrl}`);
            }
        } catch (thumbnailError) {
            console.warn(`⚠️ Thumbnail generation failed for ${savedReel._id}: ${thumbnailError.message}`);
            // Continue without thumbnail - not critical for upload success
        }

        res.json({
            message: '✅ Reel uploaded and saved!',
            reel: {
                _id: savedReel._id,
                videoUrl: savedReel.videoUrl,
                thumbnailUrl: thumbnailUrl, // Include thumbnail URL in response
                caption: savedReel.caption,
                source: savedReel.source,
                scrapedAt: savedReel.scrapedAt
            },
            thumbnailGenerated: !!thumbnailUrl
        });

    } catch (err) {
        console.error('❌ Upload failed:', err);
        res.status(500).json({
            message: 'Upload failed',
            error: err.message,
            stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
        });
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

// Add personalized recommendations endpoint with time-based scoring
router.post('/reels/recommendations', async (req, res) => {
    try {
        const { embedding, limit = 10, lastSeenReelIds = [] } = req.body;

        if (!embedding || !Array.isArray(embedding)) {
            return res.status(400).json({ error: 'Valid embedding array required' });
        }

        // Validate embedding dimensions (should be 128 for PCA or 1536 for full)
        if (embedding.length !== 128 && embedding.length !== 1536) {
            return res.status(400).json({ error: `Invalid embedding size: ${embedding.length}. Expected 128 (PCA) or 1536 (full)` });
        }

        console.log(`🧠 Processing recommendation request with ${embedding.length}-dimension embedding`);

        // Use PCA embeddings if we receive a 128-dimension embedding
        const usePCA = embedding.length === 128;
        const embeddingField = usePCA ? 'embedding_pca' : 'embedding';
        const selectFields = `source reelId videoUrl thumbnailUrl caption likes dislikes viewCount saves scrapedAt publishedAt ${embeddingField}`;

        console.log(`🎯 Using ${usePCA ? 'PCA' : 'full'} embeddings for recommendation calculation`);

        // Get fresh reels (last 48 hours) and all reels separately
        const now = new Date();
        const twoDaysAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000);

        const [freshReels, allReels] = await Promise.all([
            Reel.find({
                [embeddingField]: { $exists: true, $type: 'array' },
                scrapedAt: { $gte: twoDaysAgo },
                _id: { $nin: lastSeenReelIds } // Exclude recently seen
            })
                .select(selectFields)
                .populate('source', 'name icon favicon')
                .lean(),

            Reel.find({
                [embeddingField]: { $exists: true, $type: 'array' },
                _id: { $nin: lastSeenReelIds } // Exclude recently seen
            })
                .select(selectFields)
                .populate('source', 'name icon favicon')
                .lean()
        ]);

        // Enhanced scoring algorithm
        const scoreReel = (reel, isFresh = false) => {
            // Use the appropriate embedding field based on input dimensions
            const reelEmbedding = usePCA ? reel.embedding_pca : reel.embedding;
            const similarity = cosineSimilarity(embedding, reelEmbedding);

            // Time-based scoring: newer content gets higher scores
            const reelAge = now - new Date(reel.scrapedAt || reel.publishedAt);
            const hoursAge = reelAge / (1000 * 60 * 60);
            const recencyScore = Math.max(0, 1 - (hoursAge / 168)); // Decay over 1 week

            // Engagement scoring (normalize to 0-1 range)
            const maxViews = 10000; // Reasonable upper bound
            const engagementScore = Math.min(1, (reel.viewCount || 0) / maxViews) * 0.3 +
                Math.min(1, (reel.likes || 0) / 1000) * 0.2;

            // Fresh content bonus
            const freshnessBonus = isFresh ? 0.3 : 0;

            // Combined score with weights
            const finalScore = (
                similarity * 0.4 +           // 40% content relevance
                recencyScore * 0.35 +        // 35% recency
                engagementScore * 0.15 +     // 15% engagement
                freshnessBonus               // 30% fresh content bonus
            );

            return { ...reel, similarity, recencyScore, engagementScore, finalScore, isFresh };
        };

        // Score fresh reels with bonus, other reels normally
        const scoredFreshReels = freshReels.map(reel => scoreReel(reel, true));
        const scoredOtherReels = allReels
            .filter(reel => !freshReels.some(fresh => fresh._id.toString() === reel._id.toString()))
            .map(reel => scoreReel(reel, false));

        // Combine and sort by final score
        const allScoredReels = [...scoredFreshReels, ...scoredOtherReels]
            .sort((a, b) => b.finalScore - a.finalScore);

        // Ensure variety by source (max 3 reels per source in top results)
        // If we don't have enough content, gradually relax the source diversity constraint
        const diversifiedReels = [];
        const sourceCount = {};
        const targetLimit = limit * 2; // Aim for 2x the limit for good selection
        let maxPerSource = 3;

        // First pass: strict diversity (max 3 per source)
        for (const reel of allScoredReels) {
            const sourceId = reel.source?._id?.toString() || 'unknown';
            const currentCount = sourceCount[sourceId] || 0;

            if (currentCount < maxPerSource && diversifiedReels.length < targetLimit) {
                diversifiedReels.push(reel);
                sourceCount[sourceId] = currentCount + 1;
            }
        }

        // If we don't have enough videos, do a second pass with relaxed diversity
        if (diversifiedReels.length < limit) {
            console.log(`⚠️ Only ${diversifiedReels.length} videos after diversity filter, relaxing constraints...`);
            maxPerSource = 5; // Allow up to 5 per source

            for (const reel of allScoredReels) {
                if (diversifiedReels.length >= targetLimit) break;

                const sourceId = reel.source?._id?.toString() || 'unknown';
                const currentCount = sourceCount[sourceId] || 0;
                const alreadyIncluded = diversifiedReels.some(r => r._id.toString() === reel._id.toString());

                if (!alreadyIncluded && currentCount < maxPerSource) {
                    diversifiedReels.push(reel);
                    sourceCount[sourceId] = currentCount + 1;
                }
            }
        }

        // If still not enough, add any remaining videos without source restrictions
        if (diversifiedReels.length < limit) {
            console.log(`⚠️ Still only ${diversifiedReels.length} videos, removing source restrictions...`);

            for (const reel of allScoredReels) {
                if (diversifiedReels.length >= targetLimit) break;

                const alreadyIncluded = diversifiedReels.some(r => r._id.toString() === reel._id.toString());
                if (!alreadyIncluded) {
                    diversifiedReels.push(reel);
                }
            }
        }

        // Final selection prioritizing fresh content
        const finalReels = diversifiedReels.slice(0, limit);

        console.log(`🎯 AI Recommendations: ${finalReels.length} reels selected`, {
            requestedLimit: limit,
            embeddingType: usePCA ? 'PCA (128d)' : 'Full (1536d)',
            excludedCount: lastSeenReelIds.length,
            freshCount: finalReels.filter(r => r.isFresh).length,
            totalSourcesUsed: Object.keys(sourceCount).length,
            sourcesBreakdown: Object.entries(sourceCount).map(([sourceId, count]) => {
                const sourceName = finalReels.find(r => r.source?._id?.toString() === sourceId)?.source?.name || 'Unknown';
                return `${sourceName}: ${count}`;
            }).join(', '),
            avgSimilarity: (finalReels.reduce((sum, r) => sum + r.similarity, 0) / finalReels.length).toFixed(3),
            avgRecency: (finalReels.reduce((sum, r) => sum + r.recencyScore, 0) / finalReels.length).toFixed(3),
            avgFinalScore: (finalReels.reduce((sum, r) => sum + r.finalScore, 0) / finalReels.length).toFixed(3)
        });

        res.json(finalReels);
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
        if (secret !== ADMIN_API_KEY) {
            return res.status(403).json({ error: 'Forbidden' });
        }

        const force = String(req.query.force || '').toLowerCase() === 'true';
        const reels = await Reel.find({}, '_id originalKey videoUrl').lean();

        let refreshed = 0;
        let backfilledOriginalKey = 0;
        let skipped = 0;
        let failed = 0;

        for (const reel of reels) {
            try {
                let key = reel.originalKey;
                if (!key && reel.videoUrl) key = extractKeyFromUrl(reel.videoUrl);

                if (!key) {
                    skipped++;
                    continue;
                }

                if (!force && isSignedS3Url(reel.videoUrl)) {
                    skipped++;
                    continue;
                }

                try {
                    await s3.send(new HeadObjectCommand({ Bucket: AWS_S3_BUCKET, Key: key }));
                } catch {
                    skipped++;
                    continue;
                }

                const cmd = new GetObjectCommand({ Bucket: AWS_S3_BUCKET, Key: key });
                const signed = await getSignedUrl(s3, cmd, { expiresIn: 60 * 60 * 24 * 7 });

                const update = { videoUrl: signed, updatedAt: new Date() };
                if (!reel.originalKey) {
                    update.originalKey = key;
                    backfilledOriginalKey++;
                }

                await Reel.updateOne({ _id: reel._id }, { $set: update });
                refreshed++;
            } catch (err) {
                failed++;
                console.warn(`⚠️ Failed to refresh/backfill _id=${reel._id}: ${err.message}`);
            }
        }

        res.json({
            message: '✅ Reel video URLs processed',
            refreshed,
            backfilledOriginalKey,
            skipped,
            failed,
            bucket: AWS_S3_BUCKET,
            region: AWS_S3_REGION,
            force
        });
    } catch (err) {
        console.error('❌ Failed to refresh reel URLs:', err);
        res.status(500).json({ error: err.message });
    }
});

// Precompute video recommendations for active users — for Google Cloud Scheduler
router.post('/reels/precompute-recommendations', async (req, res) => {
    try {
        const secret = req.headers['x-api-key'];
        if (secret !== process.env.ADMIN_API_KEY) {
            return res.status(403).json({ error: 'Forbidden' });
        }

        console.log('🎯 Starting precomputation of video recommendations...');

        // Get list of active users (users with recent activity in last 7 days)
        const activeUsers = await UserActivity.distinct('userId', {
            timestamp: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
        });

        console.log(`👥 Found ${activeUsers.length} active users`);

        let processed = 0;
        let cached = 0;
        const batchSize = 10;

        for (let i = 0; i < activeUsers.length; i += batchSize) {
            const batch = activeUsers.slice(i, i + batchSize);

            await Promise.all(batch.map(async (userId) => {
                try {
                    const sessionId = crypto.randomUUID();
                    const cacheKey = `reels_personalized_${userId}_page_0_limit_20_session_${sessionId}`;

                    // Get user preferences
                    const userPrefs = await getUserPreferences(userId);
                    const userEmbedding = userPrefs.averageEmbedding?.slice(0, 128);

                    if (!userEmbedding || !Array.isArray(userEmbedding) || userEmbedding.length !== 128) {
                        processed++;
                        return;
                    }

                    // Get recently viewed reels to exclude
                    const lastSeenReelIds = await UserActivity.find({
                        userId,
                        eventType: 'view'
                    })
                        .sort({ timestamp: -1 })
                        .limit(100)
                        .distinct('articleId');

                    // Atlas Search kNN query
                    const reels = await Reel.aggregate([
                        {
                            $search: {
                                index: 'reel_vector_index',
                                knnBeta: {
                                    vector: userEmbedding,
                                    path: 'embedding_pca',
                                    k: 40,
                                    filter: {
                                        compound: {
                                            mustNot: [{
                                                terms: {
                                                    path: '_id',
                                                    value: lastSeenReelIds.concat(userPrefs.disliked_videos || [])
                                                }
                                            }]
                                        }
                                    }
                                }
                            }
                        },
                        { $limit: 40 },
                        {
                            $lookup: {
                                from: 'sources',
                                localField: 'source',
                                foreignField: '_id',
                                as: 'source'
                            }
                        },
                        { $unwind: { path: '$source', preserveNullAndEmptyArrays: true } }
                    ]);

                    // Score reels based on engagement
                    const scoredReels = reels.map(reel => {
                        const similarity = reel._searchScore || 0;
                        const engagementScore = (reel.viewCount / 10000) * 0.3 +
                            (reel.likes / 1000) * 0.2 +
                            (reel.completionRate || 0) * 0.5;
                        const recencyScore = reel.scrapedAt > new Date(Date.now() - 24 * 60 * 60 * 1000) ? 0.3 : 0.1;
                        const finalScore = similarity * 0.3 + engagementScore * 0.3 + recencyScore * 0.4;

                        return { ...reel, finalScore };
                    });

                    // Sort by score and shuffle for dynamism
                    const finalReels = intelligentShuffle(
                        scoredReels.sort((a, b) => b.finalScore - a.finalScore),
                        crypto.randomUUID()
                    ).slice(0, 20);

                    // Cache results with 1 hour TTL
                    try {
                        await redis.set(cacheKey, JSON.stringify(finalReels), 'EX', 3600);
                        cached++;
                    } catch (redisErr) {
                        console.warn('Redis cache failed:', redisErr.message);
                    }

                    processed++;

                } catch (error) {
                    console.error(`❌ Error processing user ${userId}:`, error.message);
                    processed++;
                }
            }));

            // Log progress every 50 users
            if (processed % 50 === 0) {
                console.log(`📊 Processed ${processed}/${activeUsers.length} users, ${cached} cached`);
            }
        }

        const message = `✅ Precomputation completed! Processed ${processed} users, cached ${cached} recommendations`;
        console.log(message);

        res.json({
            message,
            totalUsers: activeUsers.length,
            processed,
            cached,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('❌ Precomputation failed:', error);
        res.status(500).json({
            error: 'Precomputation failed',
            details: error.message
        });
    }
});


module.exports = router;
