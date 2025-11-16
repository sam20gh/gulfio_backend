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

// ============================================
// PHASE 2.2: SMART CACHING
// Activity-based TTL for user embeddings
// ============================================

/**
 * Calculate smart cache TTL based on user activity level
 * 
 * @param {string} userId - Supabase user ID
 * @returns {Promise<number>} Cache TTL in seconds
 * 
 * Activity Tiers:
 * - Active users (10+ interactions/week): 6 hours
 * - Moderate users (3-10 interactions/week): 24 hours
 * - Inactive users (<3 interactions/week): 7 days
 */
async function getSmartCacheTTL(userId) {
    try {
        const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

        // Count recent interactions (likes, saves, views) in last 7 days
        const [likeCount, saveCount, viewCount] = await Promise.all([
            Reel.countDocuments({
                likedBy: userId,
                updatedAt: { $gte: oneWeekAgo }
            }),
            Reel.countDocuments({
                savedBy: userId,
                updatedAt: { $gte: oneWeekAgo }
            }),
            UserActivity.countDocuments({
                userId,
                eventType: 'reel_view',
                timestamp: { $gte: oneWeekAgo }
            })
        ]);

        const totalInteractions = likeCount + saveCount + viewCount;

        // Determine activity tier
        let ttl, tier;
        if (totalInteractions >= 10) {
            ttl = 6 * 60 * 60; // 6 hours
            tier = 'active';
        } else if (totalInteractions >= 3) {
            ttl = 24 * 60 * 60; // 24 hours
            tier = 'moderate';
        } else {
            ttl = 7 * 24 * 60 * 60; // 7 days
            tier = 'inactive';
        }

        console.log(`📊 Smart cache TTL for user ${userId.substring(0, 8)}: ${tier} (${totalInteractions} interactions/week) → ${ttl}s`);

        return ttl;
    } catch (error) {
        console.error('⚠️ Error calculating smart cache TTL:', error.message);
        // Fallback to 24 hours
        return 24 * 60 * 60;
    }
}

// Compatibility endpoint: provide recommendation system stats for mobile client
// Used by mobile service call: GET /videos/reels/stats
router.get('/videos/reels/stats', async (req, res) => {
    try {
        // Basic DB stats
        const totalReels = await Reel.countDocuments({});
        const reelsWithEmbeddings = await Reel.countDocuments({ embedding: { $exists: true, $ne: [] } });
        const reelsWithPcaEmbeddings = await Reel.countDocuments({ embedding_pca: { $exists: true, $ne: [] } });

        // Index/cache heuristics
        const indexSize = reelsWithPcaEmbeddings; // proxy for index size
        const isIndexBuilt = indexSize > 0;
        const lastIndexUpdate = process.env.RECOMMENDATION_LAST_INDEX_UPDATE || new Date().toISOString();
        const cacheSize = (redis && typeof redis.isConnected === 'function' && redis.isConnected()) ? 1 : 0;

        const pcaProgress = totalReels > 0 ? `${Math.round((reelsWithPcaEmbeddings / totalReels) * 100)}%` : '0%';

        return res.json({
            indexStats: {
                indexSize,
                isIndexBuilt,
                lastIndexUpdate,
                cacheSize
            },
            databaseStats: {
                totalReels,
                reelsWithEmbeddings,
                reelsWithPcaEmbeddings,
                pcaProgress
            }
        });
    } catch (err) {
        console.error('Error in /videos/reels/stats:', err);
        return res.status(500).json({ error: 'Failed to fetch recommendation stats' });
    }
});

// You should have dotenv.config() in your main entrypoint (not needed here if already loaded)
const {
    AWS_S3_REGION,
    AWS_S3_BUCKET,
    AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY,
    R2_ENDPOINT,
    R2_ACCESS_KEY,
    R2_SECRET_KEY,
    R2_PUBLIC_URL,
    R2_BUCKET,
    ADMIN_API_KEY
} = process.env;

// Debug storage configuration - prefer AWS S3 over R2 (since most reels are in S3)
const isUsingAWS = AWS_S3_REGION && AWS_S3_BUCKET && AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY;
const isUsingR2 = R2_ENDPOINT && R2_ACCESS_KEY && R2_SECRET_KEY && R2_BUCKET;

console.log('🔧 Storage Configuration Debug:', {
    r2: {
        endpoint: R2_ENDPOINT ? 'Set' : 'Missing',
        bucket: R2_BUCKET ? 'Set' : 'Missing',
        accessKey: R2_ACCESS_KEY ? 'Set' : 'Missing',
        secretKey: R2_SECRET_KEY ? 'Set' : 'Missing',
        publicUrl: R2_PUBLIC_URL ? 'Set' : 'Missing'
    },
    aws: {
        region: AWS_S3_REGION ? 'Set' : 'Missing',
        bucket: AWS_S3_BUCKET ? 'Set' : 'Missing',
        accessKeyId: AWS_ACCESS_KEY_ID ? 'Set' : 'Missing',
        secretKey: AWS_SECRET_ACCESS_KEY ? 'Set' : 'Missing'
    },
    usingR2: isUsingR2,
    usingAWS: isUsingAWS
});

function cosineSimilarity(vec1, vec2) {
    const dotProduct = vec1.reduce((sum, val, i) => sum + val * vec2[i], 0);
    const magnitudeA = Math.sqrt(vec1.reduce((sum, val) => sum + val * val, 0));
    const magnitudeB = Math.sqrt(vec2.reduce((sum, val) => sum + val * val, 0));
    return dotProduct / (magnitudeA * magnitudeB);
}

// ===================== CURSOR HELPERS FOR INFINITE SCROLL =====================
/**
 * Encode cursor data for pagination
 * @param {Object} data - Cursor data containing lastId, excludedIds, timestamp
 * @returns {string} Base64 encoded cursor
 */
function encodeCursor(data) {
    return Buffer.from(JSON.stringify(data)).toString('base64');
}

/**
 * Decode cursor data from base64 string
 * @param {string} cursor - Base64 encoded cursor
 * @returns {Object|null} Decoded cursor data or null if invalid
 */
function decodeCursor(cursor) {
    try {
        return JSON.parse(Buffer.from(cursor, 'base64').toString());
    } catch (err) {
        console.error('Invalid cursor:', err.message);
        return null;
    }
}

// ===================== REDIS-CACHED VIEW TRACKING =====================
/**
 * Get recently viewed reel IDs from Redis cache (or DB if cache miss)
 * Uses Redis SET for O(1) lookups and automatic deduplication
 * @param {string} userId - User ID
 * @param {number} limit - Max number of IDs to return
 * @returns {Array<mongoose.Types.ObjectId>} Array of viewed reel IDs
 */
async function getRecentlyViewedIds(userId, limit = 100) {
    const key = `user:viewed:${userId}`;

    try {
        // Try Redis first (fast path)
        // Note: Redis sets don't have ordering, so we get all and limit in memory
        const viewedIds = await redis.smembers(key);

        if (viewedIds && viewedIds.length > 0) {
            // Limit to prevent excluding too many reels
            const limitedIds = viewedIds.slice(0, Math.min(limit, viewedIds.length));
            console.log(`✅ Cache hit: ${limitedIds.length} viewed reels for user ${userId.substring(0, 8)} (total: ${viewedIds.length})`);
            return limitedIds.map(id => {
                try {
                    return new mongoose.Types.ObjectId(id);
                } catch (e) {
                    console.warn(`⚠️ Invalid ObjectId in cache: ${id}`);
                    return null;
                }
            }).filter(id => id !== null);
        }

        // Cache miss - warm from DB
        console.log(`⚠️ Cache miss: Loading viewed reels from DB for user ${userId.substring(0, 8)}...`);
        const activities = await UserActivity.find({
            userId,
            eventType: 'reel_view' // Changed from 'view' to 'reel_view' for specificity
        })
            .sort({ timestamp: -1 })
            .limit(limit)
            .select('articleId')
            .lean();

        const ids = activities.map(a => a.articleId.toString());

        // Warm Redis cache for next request (but cap at 500 to prevent bloat)
        if (ids.length > 0) {
            // Use sorted set instead of set to maintain order by timestamp
            const maxCacheSize = 500;
            const idsToCache = ids.slice(0, maxCacheSize);

            await redis.del(key); // Clear old data
            await redis.sadd(key, ...idsToCache);
            await redis.expire(key, 86400); // 24h expiry
            console.log(`✅ Warmed cache with ${idsToCache.length} viewed reels (limited from ${ids.length})`);
        }

        return ids.map(id => new mongoose.Types.ObjectId(id));
    } catch (err) {
        console.error('⚠️ Error in getRecentlyViewedIds:', err.message);
        // Fallback to empty array on error
        return [];
    }
}

/**
 * Track view in Redis cache (called from analytics endpoint)
 * Keeps Redis cache in sync with view tracking
 * @param {string} userId - User ID
 * @param {string} reelId - Reel ID
 */
async function trackViewInCache(userId, reelId) {
    const key = `user:viewed:${userId}`;

    try {
        await redis.sadd(key, reelId.toString());
        await redis.expire(key, 86400); // Reset 24h expiry

        // Keep max 200 items (prune oldest)
        const count = await redis.scard(key);
        if (count > 200) {
            const toRemove = count - 200;
            const members = await redis.smembers(key);
            // Remove random oldest items (SPOP would work but might remove recent)
            for (let i = 0; i < toRemove && i < members.length; i++) {
                await redis.srem(key, members[i]);
            }
        }
    } catch (err) {
        console.warn('⚠️ Failed to track view in cache:', err.message);
        // Non-critical: DB tracking still works
    }
}

// ===================== OPTIMIZED FEED BUILDERS =====================
/**
 * Build optimized feed based on user and strategy
 * Main orchestrator for new cursor-based feed system
 */
async function buildOptimizedFeed({ userId, cursor, limit, strategy }) {
    console.log(`🔍 buildOptimizedFeed called:`, {
        userId: userId?.substring(0, 8),
        hasUserId: !!userId,
        strategy,
        limit
    });

    // For logged-in users with personalized strategy
    if (userId && strategy === 'personalized') {
        console.log(`🎯 Attempting personalized feed for user ${userId.substring(0, 8)}`);

        // Get user embedding from CACHE first (not DB every time)
        let userEmbedding = null;

        try {
            const cachedEmbedding = await redis.get(`user:emb:${userId}`);

            if (cachedEmbedding) {
                userEmbedding = JSON.parse(cachedEmbedding);
                console.log(`✅ User embedding cache hit: ${userEmbedding.length}D`);
            } else {
                // Cache miss - load from DB and cache
                console.log(`⚠️ User embedding cache miss, loading from DB...`);

                // Try to get user embedding from User model or calculate from preferences
                const userPrefs = await getUserPreferences(userId);
                userEmbedding = userPrefs.averageEmbedding;

                console.log(`🧠 getUserPreferences returned embedding:`, {
                    hasEmbedding: !!userEmbedding,
                    embeddingLength: userEmbedding?.length || 0,
                    totalInteractions: userPrefs.totalInteractions
                });

                if (userEmbedding && userEmbedding.length > 0) {
                    // PHASE 2.2: Use smart cache TTL based on user activity
                    const cacheTTL = await getSmartCacheTTL(userId);
                    await redis.set(`user:emb:${userId}`, JSON.stringify(userEmbedding), 'EX', cacheTTL);
                    console.log(`✅ Cached user embedding: ${userEmbedding.length}D with ${cacheTTL}s TTL`);
                } else {
                    console.log(`❌ No valid embedding returned from getUserPreferences`);
                }
            }
        } catch (err) {
            console.error('❌ Error loading user embedding:', err.message, err.stack);
        }

        if (userEmbedding && userEmbedding.length > 0) {
            console.log(`✅ Using PHASE 3.1 hybrid personalization with ${userEmbedding.length}D embedding`);
            // PHASE 2.3: Get user preferences for negative signal filtering
            const userPrefs = await getUserPreferences(userId);
            return await getPersonalizedFeedOptimized(userId, userEmbedding, cursor, limit, userPrefs);
        } else {
            console.log(`⚠️ No embedding available, falling back to trending`);
        }
    } else {
        console.log(`ℹ️ Not using personalized strategy:`, { hasUserId: !!userId, strategy });
    }

    // Fallback to trending/mixed for non-personalized or no embedding
    console.log(`📊 Returning trending feed as fallback`);
    return await getTrendingFeedOptimized(cursor, limit, strategy);
}

/**
 * PHASE 3.1: Calculate hybrid personalization score with recency boost
 * Blends three signals for better diversity and relevance:
 * - 50% Embedding similarity (ML-based content understanding)
 * - 30% Source preferences (user's preferred news sources)
 * - 20% Category preferences (topic diversity)
 * Plus a recency multiplier to boost newer content (up to 1.5x for content from last 3 days)
 * 
 * @param {Object} reel - Reel document with embedding, source, categories
 * @param {Array} userEmbedding - User's average embedding vector
 * @param {Object} userPrefs - User preferences object
 * @returns {Object} Scoring breakdown and final hybrid score
 */
function calculateHybridScore(reel, userEmbedding, userPrefs) {
    // 1. Embedding similarity score (50%)
    let embeddingScore = 0;
    if (userEmbedding && reel.embedding_pca) {
        embeddingScore = cosineSimilarity(userEmbedding, reel.embedding_pca);
    } else if (reel.searchScore) {
        // Use Atlas Search score if available
        embeddingScore = reel.searchScore;
    }

    // 2. Source preference score (30%)
    let sourceScore = 0;
    if (reel.source?.name && userPrefs.sourcePreferences?.length > 0) {
        const sourceMap = new Map(userPrefs.sourcePreferences);
        const maxSourceWeight = Math.max(...userPrefs.sourcePreferences.map(([, weight]) => weight), 1);
        const sourceWeight = sourceMap.get(reel.source.name) || 0;
        sourceScore = sourceWeight / maxSourceWeight; // Normalize to 0-1
    }

    // 3. Category preference score (20%)
    let categoryScore = 0;
    if (reel.categories?.length > 0 && userPrefs.categoryPreferences?.length > 0) {
        const categoryMap = new Map(userPrefs.categoryPreferences);
        const maxCategoryWeight = Math.max(...userPrefs.categoryPreferences.map(([, weight]) => weight), 1);

        // Average category weight for reels with multiple categories
        const categoryWeights = reel.categories
            .map(cat => categoryMap.get(cat) || 0)
            .filter(w => w > 0);

        if (categoryWeights.length > 0) {
            const avgCategoryWeight = categoryWeights.reduce((a, b) => a + b, 0) / categoryWeights.length;
            categoryScore = avgCategoryWeight / maxCategoryWeight; // Normalize to 0-1
        }
    }

    // 4. Recency boost: newer content gets higher scores
    // 1.5x boost for last 3 days, 1.3x for last 7 days, 1.1x for last 14 days, 1.0x after that
    let recencyMultiplier = 1.0;
    if (reel.scrapedAt) {
        const ageInDays = (Date.now() - new Date(reel.scrapedAt).getTime()) / (1000 * 60 * 60 * 24);
        if (ageInDays <= 3) {
            recencyMultiplier = 1.5; // 50% boost for very fresh content
        } else if (ageInDays <= 7) {
            recencyMultiplier = 1.3; // 30% boost for fresh content
        } else if (ageInDays <= 14) {
            recencyMultiplier = 1.1; // 10% boost for recent content
        }
        // else 1.0 (no boost for older content)
    }

    // Calculate base hybrid score (50/30/20)
    const baseScore = (
        embeddingScore * 0.5 +
        sourceScore * 0.3 +
        categoryScore * 0.2
    );

    // Apply recency multiplier
    const hybridScore = baseScore * recencyMultiplier;

    return {
        hybridScore,
        embeddingScore,
        sourceScore,
        categoryScore,
        recencyMultiplier,
        breakdown: `E:${(embeddingScore * 100).toFixed(0)}% S:${(sourceScore * 100).toFixed(0)}% C:${(categoryScore * 100).toFixed(0)}% R:${recencyMultiplier.toFixed(1)}x`
    };
}

/**
 * Get optimized personalized feed using single Atlas Search compound query
 * Combines vector similarity + trending + fresh content in ONE query
 * PHASE 2.3: Filters out disliked sources and categories
 * PHASE 3.1: Hybrid scoring with 50/30/20 weighting (embedding/source/category)
 */
async function getPersonalizedFeedOptimized(userId, userEmbedding, cursor, limit, userPrefs = {}) {
    try {
        // Get excluded IDs from cursor or recent history
        // REDUCED from 200 to 50 to allow more variety and prioritize recency boost
        // If no cursor (fresh feed), only exclude last 20 to maximize new content visibility
        const exclusionLimit = cursor?.excludedIds ? 50 : 20;
        const excludedIds = cursor?.excludedIds || await getRecentlyViewedIds(userId, exclusionLimit);

        console.log(`🔍 Personalized feed query:`, {
            userIdShort: userId.substring(0, 8),
            embeddingDim: userEmbedding.length,
            excludedCount: excludedIds.length,
            hasCursor: !!cursor,
            sourcePrefs: userPrefs.sourcePreferences?.length || 0,
            categoryPrefs: userPrefs.categoryPreferences?.length || 0
        });

        // Use MongoDB Atlas Vector Search for personalized recommendations
        // Note: Atlas Vector Search uses $vectorSearch, not $search with knnBeta
        // FIX: Remove filter from $vectorSearch as it requires special index config
        // Instead, apply filters in $match stage after vector search
        const pipeline = [
            {
                $vectorSearch: {
                    index: 'default',
                    queryVector: userEmbedding,
                    path: 'embedding_pca',
                    numCandidates: limit * 15, // Increased to compensate for post-filtering
                    limit: limit * 8 // Get more results for date filtering
                }
            },
            // Add search score to results
            {
                $addFields: {
                    searchScore: { $meta: 'vectorSearchScore' }
                }
            },
            {
                $match: {
                    _id: { $nin: excludedIds },
                    videoUrl: { $exists: true, $ne: null },
                    scrapedAt: { $gte: new Date(Date.now() - 180 * 24 * 60 * 60 * 1000) } // Last 6 months (extended from 30 days)
                }
            },
            {
                $lookup: {
                    from: 'sources',
                    localField: 'source',
                    foreignField: '_id',
                    as: 'source',
                    pipeline: [
                        { $project: { name: 1, icon: 1, favicon: 1 } }
                    ]
                }
            },
            { $unwind: { path: '$source', preserveNullAndEmptyArrays: true } },
            {
                $project: {
                    // Include fields needed for hybrid scoring
                    reelId: 1,
                    videoUrl: 1,
                    thumbnailUrl: 1,
                    caption: 1,
                    likes: 1,
                    dislikes: 1,
                    viewCount: 1,
                    saves: 1,
                    completionRate: 1,
                    avgWatchTime: 1,
                    scrapedAt: 1,
                    source: 1,
                    categories: 1,
                    embedding_pca: 1,
                    searchScore: 1,
                    originalKey: 1
                }
            }
        ];

        const reels = await Reel.aggregate(pipeline);

        // PHASE 2.3: Filter out disliked sources and categories
        let filteredReels = reels;
        if (userPrefs.negativeSourcePreferences?.length > 0 || userPrefs.negativeCategoryPreferences?.length > 0) {
            const beforeFilter = reels.length;
            filteredReels = reels.filter(reel => {
                // Filter out disliked sources
                if (userPrefs.negativeSourcePreferences?.includes(reel.source?.name)) {
                    return false;
                }
                // Filter out reels with disliked categories
                if (reel.categories && userPrefs.negativeCategoryPreferences?.length > 0) {
                    const hasDislikedCategory = reel.categories.some(cat =>
                        userPrefs.negativeCategoryPreferences.includes(cat)
                    );
                    if (hasDislikedCategory) return false;
                }
                return true;
            });
            console.log(`🚫 Filtered ${beforeFilter - filteredReels.length} reels with negative signals (${beforeFilter} → ${filteredReels.length})`);
        }

        // PHASE 3.1: Apply hybrid scoring to all reels
        const scoredReels = filteredReels.map(reel => {
            const scoring = calculateHybridScore(reel, userEmbedding, userPrefs);
            return {
                ...reel,
                ...scoring
            };
        });

        // Sort by hybrid score (descending)
        scoredReels.sort((a, b) => b.hybridScore - a.hybridScore);

        // Log top 3 scores for debugging
        if (scoredReels.length > 0) {
            console.log(`🎯 PHASE 3.1 Hybrid scoring applied to ${scoredReels.length} reels`);
            console.log(`📊 Top 3 scores:`, scoredReels.slice(0, 3).map(r => ({
                source: r.source?.name,
                hybrid: r.hybridScore.toFixed(3),
                age: r.scrapedAt ? `${Math.floor((Date.now() - new Date(r.scrapedAt).getTime()) / (1000 * 60 * 60 * 24))}d` : 'N/A',
                breakdown: r.breakdown
            })));
        }

        // Check if there's more data
        const hasMore = scoredReels.length > limit;
        const results = hasMore ? scoredReels.slice(0, limit) : scoredReels;

        // Clean up results (remove embedding_pca to reduce payload)
        const cleanResults = results.map(({ embedding_pca, searchScore, embeddingScore, sourceScore, categoryScore, breakdown, ...reel }) => reel);

        // Build next cursor
        const nextCursor = hasMore ? encodeCursor({
            lastId: cleanResults[cleanResults.length - 1]._id,
            excludedIds: [...excludedIds, ...cleanResults.map(r => r._id)],
            timestamp: Date.now()
        }) : null;

        console.log(`✅ Personalized feed: ${cleanResults.length} reels, hasMore: ${hasMore}, strategy: hybrid (50/30/20)`);

        return {
            reels: cleanResults,
            cursor: nextCursor,
            hasMore,
            strategy: 'hybrid-personalized'
        };
    } catch (err) {
        console.error('❌ Personalized feed error:', err.message);
        // Fallback to trending on error
        return await getTrendingFeedOptimized(cursor, limit, 'trending');
    }
}

/**
 * Get optimized trending/mixed feed for anonymous users
 * Uses engagement-based sorting with cursor pagination
 */
async function getTrendingFeedOptimized(cursor, limit, strategy) {
    try {
        const excludedIds = cursor?.excludedIds || [];

        console.log(`🔥 Trending feed query:`, {
            strategy,
            excludedCount: excludedIds.length,
            limit
        });

        const pipeline = [
            {
                $match: {
                    _id: { $nin: excludedIds },
                    videoUrl: { $exists: true, $ne: null },
                    scrapedAt: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } // Last 30 days
                }
            },
            {
                $addFields: {
                    trendingScore: {
                        $add: [
                            { $multiply: [{ $ifNull: ['$viewCount', 0] }, 0.4] },
                            { $multiply: [{ $ifNull: ['$likes', 0] }, 0.4] },
                            { $multiply: [{ $ifNull: ['$completionRate', 0] }, 0.2] }
                        ]
                    }
                }
            },
            {
                $sort: { trendingScore: -1, scrapedAt: -1 }
            },
            { $limit: limit + 1 },
            {
                $lookup: {
                    from: 'sources',
                    localField: 'source',
                    foreignField: '_id',
                    as: 'source',
                    pipeline: [
                        { $project: { name: 1, icon: 1, favicon: 1 } }
                    ]
                }
            },
            { $unwind: { path: '$source', preserveNullAndEmptyArrays: true } },
            {
                $project: {
                    reelId: 1,
                    videoUrl: 1,
                    thumbnailUrl: 1,
                    caption: 1,
                    likes: 1,
                    dislikes: 1,
                    viewCount: 1,
                    saves: 1,
                    completionRate: 1,
                    avgWatchTime: 1,
                    scrapedAt: 1,
                    source: 1,
                    trendingScore: 1,
                    originalKey: 1
                }
            }
        ];

        const reels = await Reel.aggregate(pipeline);

        const hasMore = reels.length > limit;
        const results = hasMore ? reels.slice(0, limit) : reels;

        const nextCursor = hasMore ? encodeCursor({
            lastId: results[results.length - 1]._id,
            excludedIds: [...excludedIds, ...results.map(r => r._id)],
            timestamp: Date.now()
        }) : null;

        console.log(`✅ Trending feed: ${results.length} reels, hasMore: ${hasMore}`);

        return {
            reels: results,
            cursor: nextCursor,
            hasMore,
            strategy
        };
    } catch (err) {
        console.error('❌ Trending feed error:', err.message);
        throw err;
    }
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

// ⚡ PHASE 1.2: Weighted interaction scoring with time decay
const INTERACTION_WEIGHTS = {
    save: 5.0,           // Highest signal - user wants to keep it
    like: 3.0,           // Strong positive signal
    view_complete: 2.0,  // Watched >80% - good signal
    view_partial: 1.0,   // Watched 30-80% - mild interest
    view_skip: -0.5,     // Watched <30% - not interested
    dislike: -3.0        // Strong negative signal
};

/**
 * Calculate weighted interaction score with time decay
 * @param {Array} interactions - Array of {id, type, timestamp, weight}
 * @param {number} decayRate - Daily decay rate (default 0.95 = 5% decay per day)
 * @returns {Array} Weighted interactions with decayed scores
 */
function applyInteractionWeights(interactions, decayRate = 0.95) {
    const now = Date.now();

    return interactions.map(interaction => {
        const baseWeight = INTERACTION_WEIGHTS[interaction.type] || 1.0;
        const daysOld = (now - new Date(interaction.timestamp).getTime()) / (1000 * 60 * 60 * 24);
        const decayedWeight = baseWeight * Math.pow(decayRate, daysOld);

        return {
            ...interaction,
            baseWeight,
            decayedWeight,
            daysOld: Math.round(daysOld)
        };
    });
}

// Helper: Get user preferences based on interaction history
async function getUserPreferences(userId) {
    try {
        console.log(`🔍 Getting user preferences for userId: ${userId}`);

        // ⚡ PHASE 1 OPTIMIZATION: Try to use pre-calculated user embedding first (10-20x faster)
        const User = require('../models/User');
        const user = await User.findOne({ supabase_id: userId })
            .select('embedding_pca embedding following_sources')
            .lean();

        if (user?.embedding_pca?.length === 128) {
            console.log(`⚡ Using pre-calculated user embedding (128D) - FAST PATH`);
            return {
                averageEmbedding: user.embedding_pca,
                sourcePreferences: (user.following_sources || []).map(s => [s, 1]),
                categoryPreferences: [],
                totalInteractions: 1, // Indicate user has data
                recentActivityCount: 0
            };
        } else if (user?.embedding?.length === 1536) {
            console.log(`⚡ Using pre-calculated user embedding (1536D) - converting to 128D`);
            // Use first 128 dimensions as approximation (better than recalculating)
            return {
                averageEmbedding: user.embedding.slice(0, 128),
                sourcePreferences: (user.following_sources || []).map(s => [s, 1]),
                categoryPreferences: [],
                totalInteractions: 1,
                recentActivityCount: 0
            };
        }

        console.log(`⚠️ No pre-calculated embedding found, falling back to calculation from interactions`);

        const recentActivity = await UserActivity.find({
            userId,
            eventType: { $in: ['view', 'like', 'save'] }
        })
            .populate('articleId', 'category embedding')
            .sort({ timestamp: -1 })
            .limit(100)
            .lean();

        console.log(`📊 Found ${recentActivity.length} recent activities for user ${userId}`);

        // Also check reel interactions from the Reel model
        const likedReels = await Reel.find({
            likedBy: userId
        }).select('source categories embedding embedding_pca updatedAt').populate('source', 'name').lean();

        const savedReels = await Reel.find({
            savedBy: userId
        }).select('source categories embedding embedding_pca updatedAt').populate('source', 'name').lean();

        const viewedReels = await Reel.find({
            viewedBy: userId
        }).select('source categories embedding embedding_pca updatedAt').populate('source', 'name').lean();

        // PHASE 2.3: Get disliked reels for negative signal filtering
        const dislikedReels = await Reel.find({
            dislikedBy: userId
        }).select('source categories embedding embedding_pca updatedAt').populate('source', 'name').lean();

        console.log(`📊 User ${userId} interactions: ${likedReels.length} liked, ${savedReels.length} saved, ${viewedReels.length} viewed, ${dislikedReels.length} disliked`);

        // DEBUG: Check how many have embeddings
        const likedWithPCA = likedReels.filter(r => r.embedding_pca && r.embedding_pca.length > 0).length;
        const likedWithEmbedding = likedReels.filter(r => r.embedding && r.embedding.length > 0).length;
        const savedWithPCA = savedReels.filter(r => r.embedding_pca && r.embedding_pca.length > 0).length;
        const savedWithEmbedding = savedReels.filter(r => r.embedding && r.embedding.length > 0).length;
        console.log(`🔬 Embeddings breakdown: liked(pca:${likedWithPCA}, full:${likedWithEmbedding}), saved(pca:${savedWithPCA}, full:${savedWithEmbedding})`);

        // Analyze preferences
        const sourcePreferences = {};
        const categoryPreferences = {};

        // ⚡ PHASE 1.3: Apply TIME DECAY to interaction weights (5% daily decay)
        // PHASE 2.3: Include disliked reels with NEGATIVE weights
        // Recent interactions (last 7 days) are more influential than old interactions (30+ days)
        const allInteractions = [
            ...likedReels.map(r => ({ reel: r, type: 'like', timestamp: r.updatedAt || new Date() })),
            ...savedReels.map(r => ({ reel: r, type: 'save', timestamp: r.updatedAt || new Date() })),
            ...viewedReels.map(r => ({ reel: r, type: 'view', timestamp: r.updatedAt || new Date() })),
            ...dislikedReels.map(r => ({ reel: r, type: 'dislike', timestamp: r.updatedAt || new Date() }))
        ];

        const decayedInteractions = applyInteractionWeights(allInteractions, 0.95); // 5% daily decay

        console.log(`📉 Applied time decay to ${decayedInteractions.length} interactions (${dislikedReels.length} negative signals, decay rate: 5%/day)`);

        // Process interactions with decayed weights
        decayedInteractions.forEach(interaction => {
            const weight = interaction.decayedWeight;
            const reel = interaction.reel;

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

        // Calculate average days old for logging
        const avgDaysOld = decayedInteractions.length > 0
            ? (decayedInteractions.reduce((sum, i) => sum + i.daysOld, 0) / decayedInteractions.length).toFixed(1)
            : 0;

        console.log(`⚖️ Time-decayed preferences calculated: ${Object.keys(sourcePreferences).length} sources, ${Object.keys(categoryPreferences).length} categories, avg age: ${avgDaysOld} days`);

        // Calculate average embedding for content-based recommendations (prefer PCA)
        // Priority: 1) Liked/Saved reels, 2) Viewed reels (if no likes/saves), 3) Trending fallback
        let averageEmbedding = null;
        let validEmbeddings = [...likedReels, ...savedReels]
            .filter(reel => (reel.embedding_pca || reel.embedding) && (reel.embedding_pca?.length > 0 || reel.embedding?.length > 0))
            .map(reel => reel.embedding_pca || reel.embedding);

        console.log(`🧠 Found ${validEmbeddings.length} reels with embeddings from likes/saves for user ${userId}`);

        // Fallback to viewed reels if user has no likes/saves yet (cold start problem)
        if (validEmbeddings.length === 0 && viewedReels.length > 0) {
            console.log(`🔄 No liked/saved reels, using ${viewedReels.length} viewed reels for embedding`);
            validEmbeddings = viewedReels
                .filter(reel => (reel.embedding_pca || reel.embedding) && (reel.embedding_pca?.length > 0 || reel.embedding?.length > 0))
                .map(reel => reel.embedding_pca || reel.embedding);
            console.log(`🧠 Found ${validEmbeddings.length} viewed reels with embeddings`);
        }

        // Final fallback: Create synthetic embedding from source preferences (cold start)
        if (validEmbeddings.length === 0 && Object.keys(sourcePreferences).length > 0) {
            console.log(`🆕 Cold start: Creating synthetic embedding from ${Object.keys(sourcePreferences).length} source preferences`);
            try {
                // Get sample reels from preferred sources
                const preferredSources = Object.entries(sourcePreferences)
                    .sort(([, a], [, b]) => b - a)
                    .slice(0, 5)
                    .map(([sourceName]) => sourceName);

                console.log(`🔍 Preferred sources: ${preferredSources.join(', ')}`);

                const sourceDocs = await Source.find({ name: { $in: preferredSources } }).select('_id').lean();
                const sourceIds = sourceDocs.map(s => s._id);

                if (sourceIds.length > 0) {
                    const sampleReels = await Reel.find({
                        source: { $in: sourceIds },
                        $or: [
                            { embedding_pca: { $exists: true, $ne: [], $type: 'array' } },
                            { embedding: { $exists: true, $ne: [], $type: 'array' } }
                        ]
                    })
                        .select('embedding embedding_pca')
                        .limit(20)
                        .lean();

                    validEmbeddings = sampleReels
                        .filter(reel => (reel.embedding_pca || reel.embedding))
                        .map(reel => reel.embedding_pca || reel.embedding);

                    console.log(`✅ Cold start: Found ${validEmbeddings.length} reels from preferred sources`);
                }
            } catch (coldStartError) {
                console.error(`❌ Cold start embedding creation failed:`, coldStartError.message);
            }
        }

        if (validEmbeddings.length > 0) {
            const embeddingSize = validEmbeddings[0].length;
            averageEmbedding = new Array(embeddingSize).fill(0);

            validEmbeddings.forEach(embedding => {
                embedding.forEach((value, index) => {
                    averageEmbedding[index] += value;
                });
            });

            averageEmbedding = averageEmbedding.map(sum => sum / validEmbeddings.length);

            console.log(`✅ Calculated ${embeddingSize}D average embedding for user ${userId} from ${validEmbeddings.length} reels`);
        } else {
            console.log(`⚠️ No embeddings found for user ${userId} (no likes/saves/views), will use trending fallback`);
        }

        // PHASE 2.3: Extract negative signals (disliked sources and categories)
        const negativeSourcePreferences = {};
        const negativeCategoryPreferences = {};

        dislikedReels.forEach(reel => {
            const sourceName = reel.source?.name || 'Unknown';
            negativeSourcePreferences[sourceName] = (negativeSourcePreferences[sourceName] || 0) + 1;

            if (reel.categories) {
                reel.categories.forEach(category => {
                    negativeCategoryPreferences[category] = (negativeCategoryPreferences[category] || 0) + 1;
                });
            }
        });

        console.log(`🚫 Negative signals: ${Object.keys(negativeSourcePreferences).length} sources, ${Object.keys(negativeCategoryPreferences).length} categories to filter`);

        const prefs = {
            sourcePreferences: Object.entries(sourcePreferences)
                .sort(([, a], [, b]) => b - a)
                .slice(0, 10), // Top 10 sources
            categoryPreferences: Object.entries(categoryPreferences)
                .sort(([, a], [, b]) => b - a)
                .slice(0, 10), // Top 10 categories
            negativeSourcePreferences: Object.keys(negativeSourcePreferences), // Disliked sources
            negativeCategoryPreferences: Object.keys(negativeCategoryPreferences), // Disliked categories
            averageEmbedding,
            totalInteractions: likedReels.length + savedReels.length + viewedReels.length,
            recentActivityCount: recentActivity.length
        };

        console.log(`✅ User ${userId} preferences: ${prefs.totalInteractions} interactions, ${prefs.sourcePreferences.length} sources, embedding: ${averageEmbedding ? averageEmbedding.length + 'D' : 'none'}`);

        return prefs;
    } catch (error) {
        console.error(`❌ Error getting user preferences for ${userId}:`, error);
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

        // Get user preferences with error handling
        let userPrefs;
        try {
            userPrefs = await getUserPreferences(userId);
            console.log(`👤 User prefs loaded:`, {
                totalInteractions: userPrefs.totalInteractions,
                hasEmbedding: !!userPrefs.averageEmbedding,
                embeddingLength: userPrefs.averageEmbedding?.length || 0
            });
        } catch (prefError) {
            console.error('❌ Error getting user preferences:', prefError);
            userPrefs = {
                sourcePreferences: [],
                categoryPreferences: [],
                averageEmbedding: null,
                totalInteractions: 0,
                recentActivityCount: 0
            };
        }

        const userEmbedding = userPrefs.averageEmbedding?.slice(0, 128); // Ensure 128D

        let lastSeenReelIds = [];
        try {
            lastSeenReelIds = await UserActivity.find({ userId, eventType: 'view' })
                .sort({ timestamp: -1 })
                .limit(100)
                .distinct('articleId');
            console.log(`📊 Found ${lastSeenReelIds.length} previously seen reels for user`);
        } catch (activityError) {
            console.error('⚠️ Error fetching user activity:', activityError.message);
            lastSeenReelIds = [];
        }

        let reels = [];
        if (!userEmbedding || !Array.isArray(userEmbedding) || userEmbedding.length !== 128) {
            console.warn(`⚠️ Falling back to engagement-based sorting (embedding: ${userEmbedding ? 'invalid' : 'none'})`);
            try {
                reels = await Reel.find({
                    _id: { $nin: lastSeenReelIds.concat(userPrefs.disliked_videos || []) }
                })
                    .populate('source')
                    .sort({ viewCount: -1, scrapedAt: -1 })
                    .skip(skip)
                    .limit(limit * 2)
                    .lean();
                console.log(`✅ Fetched ${reels.length} reels using engagement-based sorting`);
            } catch (fetchError) {
                console.error('❌ Error fetching engagement-based reels:', fetchError);
                throw fetchError;
            }
        } else {
            // Atlas Search kNN query with error handling
            console.log(`🔍 Using Atlas Search with ${userEmbedding.length}D embedding`);
            try {
                const excludedIds = lastSeenReelIds.concat(userPrefs.disliked_videos || []);
                console.log(`📊 Excluding ${excludedIds.length} previously seen/disliked reels`);

                // Build aggregation pipeline
                const pipeline = [
                    {
                        $search: {
                            index: 'default', // Atlas Search index name
                            knnBeta: {
                                vector: userEmbedding,
                                path: 'embedding_pca',
                                k: limit * 3 // Get more to account for filtering
                            }
                        }
                    },
                    { $limit: limit * 3 }
                ];

                // Only add filter if we have excluded IDs
                if (excludedIds.length > 0) {
                    pipeline.push({
                        $match: {
                            _id: { $nin: excludedIds }
                        }
                    });
                }

                pipeline.push(
                    { $limit: limit * 2 },
                    { $lookup: { from: 'sources', localField: 'source', foreignField: '_id', as: 'source' } },
                    { $unwind: { path: '$source', preserveNullAndEmptyArrays: true } }
                );

                reels = await Reel.aggregate(pipeline);
                console.log(`✅ Atlas Search returned ${reels.length} reels`);

                // Score reels
                reels = reels.map(reel => scoreReel(reel, userPrefs, reel.scrapedAt > new Date(Date.now() - 24 * 60 * 60 * 1000)));
            } catch (searchError) {
                console.error('❌ Atlas Search failed, falling back to engagement-based:', searchError.message);
                // Fallback to engagement-based if Atlas Search fails
                reels = await Reel.find({
                    _id: { $nin: lastSeenReelIds.concat(userPrefs.disliked_videos || []) }
                })
                    .populate('source')
                    .sort({ viewCount: -1, scrapedAt: -1 })
                    .skip(skip)
                    .limit(limit * 2)
                    .lean();
                console.log(`✅ Fallback fetched ${reels.length} reels`);
            }
        }

        // Inject trending reels (10%)
        // Inject trending reels (10%) with error handling
        const trendingLimit = Math.ceil(limit * 0.1);
        let trendingReels = [];
        try {
            trendingReels = await Reel.find({
                _id: { $nin: reels.map(r => r._id).concat(lastSeenReelIds, userPrefs.disliked_videos || []) },
                viewCount: { $exists: true },
                scrapedAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
            })
                .populate('source')
                .sort({ viewCount: -1, scrapedAt: -1 })
                .limit(trendingLimit)
                .lean();
            console.log(`✅ Fetched ${trendingReels.length} trending reels`);
        } catch (trendingError) {
            console.error('⚠️ Error fetching trending reels:', trendingError.message);
            trendingReels = [];
        }

        const trendingEnhanced = trendingReels.map(reel => ({
            ...reel,
            isTrending: true
        }));

        // Inject exploratory reels (20%) with error handling
        const exploratoryLimit = Math.ceil(limit * 0.2);
        let exploratoryReels = [];
        try {
            exploratoryReels = await Reel.aggregate([
                { $match: { _id: { $nin: reels.map(r => r._id).concat(lastSeenReelIds, userPrefs.disliked_videos || []) } } },
                { $sample: { size: exploratoryLimit } },
                { $lookup: { from: 'sources', localField: 'source', foreignField: '_id', as: 'source' } },
                { $unwind: { path: '$source', preserveNullAndEmptyArrays: true } }
            ]);
            console.log(`✅ Fetched ${exploratoryReels.length} exploratory reels`);
        } catch (exploratoryError) {
            console.error('⚠️ Error fetching exploratory reels:', exploratoryError.message);
            exploratoryReels = [];
        }

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
// Helper: Initialize storage client (R2 or S3)
let s3;
let storageConfig = {};

try {
    if (isUsingAWS) {
        // Configure for AWS S3 (primary storage)
        s3 = new S3Client({
            region: AWS_S3_REGION || 'me-central-1',
            credentials: {
                accessKeyId: AWS_ACCESS_KEY_ID,
                secretAccessKey: AWS_SECRET_ACCESS_KEY,
            },
        });
        storageConfig = {
            bucket: AWS_S3_BUCKET,
            region: AWS_S3_REGION,
            type: 'S3'
        };
        console.log('✅ S3 Client initialized successfully');
    } else if (isUsingR2) {
        // Configure for Cloudflare R2 (fallback for old reels)
        s3 = new S3Client({
            region: 'auto',
            endpoint: R2_ENDPOINT,
            credentials: {
                accessKeyId: R2_ACCESS_KEY,
                secretAccessKey: R2_SECRET_KEY,
            },
        });
        storageConfig = {
            bucket: R2_BUCKET,
            publicUrl: R2_PUBLIC_URL,
            type: 'R2'
        };
        console.log('✅ R2 Client initialized successfully');
    } else {
        throw new Error('No storage configuration found. Please configure either AWS S3 or R2.');
    }
} catch (error) {
    console.error('❌ Failed to initialize Storage Client:', error);
    throw new Error(`Storage Client initialization failed: ${error.message}`);
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

        if (!storageConfig.bucket) {
            throw new Error(`${storageConfig.type} bucket environment variable is not set`);
        }

        const command = new PutObjectCommand({
            Bucket: storageConfig.bucket,
            Key: filename,
            Body: buffer,
            ContentType: 'video/mp4',
        });

        console.log(`🚀 Uploading to ${storageConfig.type} bucket: ${storageConfig.bucket}`);
        await s3.send(command);
        console.log(`✅ ${storageConfig.type} upload successful: ${filename}`);

        // Generate signed URL (valid for 7 days)
        const signedUrl = await getSignedUrl(
            s3,
            new GetObjectCommand({
                Bucket: storageConfig.bucket,
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

const extractKeyFromUrl = (u, bucket = null, region = null) => {
    try {
        const url = new URL(u);
        const host = url.hostname.toLowerCase();
        const path = decodeURIComponent(url.pathname || '/');

        // AWS S3 URLs - Handle both virtual-hosted and path-style
        // Virtual-hosted style: https://bucket.s3.region.amazonaws.com/key
        // Path style: https://s3.region.amazonaws.com/bucket/key

        // Check if it's an S3 URL by looking for amazonaws.com
        if (host.includes('amazonaws.com')) {
            // Virtual-hosted style (bucket.s3.region.amazonaws.com)
            if (host.includes('.s3.') && host.includes('.amazonaws.com')) {
                return path.replace(/^\/+/, '');
            }

            // Path style (s3.region.amazonaws.com/bucket/key)
            if (host.startsWith('s3.') && host.includes('.amazonaws.com')) {
                const parts = path.split('/').filter(Boolean);
                if (parts.length >= 2) {
                    // First part is bucket, rest is the key
                    return parts.slice(1).join('/');
                }
            }

            // Generic S3 URL - use path as key
            return path.replace(/^\/+/, '');
        }

        // Cloudflare R2 URLs (pub-xxxxx.r2.dev or custom domain)
        if (host.includes('.r2.dev') || host.includes('r2.dev')) {
            // For R2, the path is the key (remove leading slash)
            return path.replace(/^\/+/, '');
        }

        // Fallback: try to use the path as the key
        return path.replace(/^\/+/, '') || null;
    } catch (error) {
        console.warn('Error extracting key from URL:', error.message);
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

// ===================== NEW: OPTIMIZED CURSOR-BASED FEED =====================
/**
 * GET /reels/feed
 * New optimized cursor-based infinite scroll feed
 * Features:
 * - Cursor-based pagination (no skip/offset - faster & more reliable)
 * - Redis caching for user embeddings and viewed reels
 * - Single optimized Atlas Search compound query
 * - Field projection (only send needed data)
 * - Backward compatible with existing /reels route
 * 
 * Query params:
 * - cursor: Base64 encoded cursor from previous response (optional)
 * - limit: Number of reels to return (default: 20, max: 50)
 * - strategy: 'personalized' | 'trending' | 'mixed' (default: personalized for logged users)
 */
router.get('/reels/feed', async (req, res) => {
    console.log('🎯🎯🎯 /reels/feed HIT - REQUEST RECEIVED');
    console.log('📋 Headers:', JSON.stringify({
        authorization: req.headers.authorization ? 'present' : 'none',
        'x-api-key': req.headers['x-api-key'] ? 'present' : 'none'
    }));

    try {
        const {
            cursor,
            limit: requestedLimit = 20,
            strategy = 'personalized'
        } = req.query;

        const limit = Math.min(parseInt(requestedLimit) || 20, 50); // Cap at 50

        console.log(`🔄 New feed request:`, { cursor: cursor ? 'present' : 'none', limit, strategy });

        // Extract user ID from token
        const authToken = req.headers.authorization?.replace('Bearer ', '');
        let userId = null;

        if (authToken) {
            try {
                const jwt = require('jsonwebtoken');
                const decoded = jwt.decode(authToken);
                userId = decoded?.sub || decoded?.user_id || decoded?.id;
                console.log(`👤 Feed for user: ${userId?.substring(0, 8)}...`);
            } catch (err) {
                console.warn('⚠️ Token decode failed:', err.message);
            }
        }

        // Decode cursor if provided
        const decodedCursor = cursor ? decodeCursor(cursor) : null;

        // Get feed based on strategy
        const feed = await buildOptimizedFeed({
            userId,
            cursor: decodedCursor,
            limit,
            strategy: userId ? strategy : 'trending' // Force trending for anonymous
        });

        res.json(feed);
    } catch (err) {
        console.error('❌ Error in /reels/feed:', err.message);
        res.status(500).json({ error: 'Failed to fetch feed' });
    }
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

        // If user is logged in, provide personalized content with PHASE 3.1 hybrid scoring
        if (userId && (sort === 'personalized' || sort === 'mixed')) {
            console.log(`🎯 Using Phase 3.1 hybrid personalization for user ${userId.substring(0, 8)}`);

            try {
                // Get user preferences for hybrid scoring
                const userPrefs = await getUserPreferences(userId);
                const userEmbedding = userPrefs.averageEmbedding;

                if (!userEmbedding || userEmbedding.length === 0) {
                    console.log(`⚠️ No user embedding, falling back to trending`);
                    // Fallback to trending for users with no interaction history
                    const trendingFeed = await getTrendingFeedOptimized(null, limit, 'trending');
                    return res.json(trendingFeed.reels || trendingFeed);
                }

                // Use Phase 3.1 optimized feed with hybrid scoring
                const feed = await getPersonalizedFeedOptimized(userId, userEmbedding, null, limit, userPrefs);
                return res.json(feed.reels || feed);
            } catch (error) {
                console.error(`❌ Phase 3.1 personalization failed:`, error.message);
                // Fallback to trending on error
                const trendingFeed = await getTrendingFeedOptimized(null, limit, 'trending');
                return res.json(trendingFeed.reels || trendingFeed);
            }
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
                    .select('source reelId videoUrl thumbnailUrl caption likes dislikes viewCount saves scrapedAt publishedAt embedding originalKey engagement_score')
                    .populate('source', 'name icon favicon')
                    .sort({ scrapedAt: -1 })
                    .limit(recentLimit * 2) // Get more to allow for filtering
                    .lean(),
                Reel.find()
                    .select('source reelId videoUrl thumbnailUrl caption likes dislikes viewCount saves scrapedAt publishedAt embedding originalKey engagement_score')
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
                    .select('source reelId videoUrl thumbnailUrl caption likes dislikes viewCount saves scrapedAt publishedAt embedding originalKey engagement_score')
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

            // Map engagement_score to engagementScore for frontend compatibility
            const mappedShuffledReels = shuffledReels.map(reel => ({
                ...reel,
                engagementScore: reel.engagement_score // Map snake_case to camelCase
            }));

            return res.json(req.query.simple === 'true' ? mappedShuffledReels : {
                reels: mappedShuffledReels,
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
                    .select('source reelId videoUrl thumbnailUrl caption likes dislikes viewCount saves scrapedAt publishedAt embedding originalKey engagement_score') // Only select needed fields including engagement_score
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

        // Map engagement_score to engagementScore for frontend compatibility
        const mappedReels = reels.map(reel => ({
            ...reel,
            engagementScore: reel.engagement_score // Map snake_case to camelCase
        }));

        const totalPages = Math.ceil(totalCount / limit);

        // Return direct array if no pagination metadata needed (for mobile apps)
        if (req.query.simple === 'true') {
            return res.json(mappedReels);
        }

        res.json({
            reels: mappedReels,
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

// ===================== VIDEO ANALYTICS ROUTE =====================
/**
 * POST /analytics/videos
 * Batch video analytics tracking
 * Tracks watch time, completion rate, interactions, and engagement metrics
 */
router.post('/analytics/videos', async (req, res) => {
    try {
        console.log('📊 ====== RECEIVED VIDEO ANALYTICS BATCH ======');
        console.log('📊 Request body keys:', Object.keys(req.body));
        console.log('📊 Batch size:', req.body.batch?.length);
        console.log('📊 Session data:', req.body.session);

        const { batch, session } = req.body;

        if (!batch || !Array.isArray(batch) || batch.length === 0) {
            console.error('❌ Invalid batch data:', { batch: typeof batch, isArray: Array.isArray(batch), length: batch?.length });
            return res.status(400).json({ error: 'Invalid batch data' });
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
                console.warn('⚠️ Could not decode user token for analytics:', err.message);
            }
        }

        // Use session userId if available, fallback to token userId
        const effectiveUserId = session?.userId || userId;

        console.log('📊 Received video analytics batch:', {
            batchSize: batch.length,
            userId: effectiveUserId,
            sessionId: session?.sessionId,
            avgCompletion: (batch.reduce((sum, a) => sum + (a.completionRate || 0), 0) / batch.length).toFixed(2) + '%'
        });

        // Process each video analytics entry
        const analyticsPromises = batch.map(async (analytics) => {
            try {
                const {
                    videoId,
                    watchDuration,
                    completionRate,
                    interactions,
                    engagement,
                    metadata
                } = analytics;

                if (!videoId) {
                    console.warn('⚠️ Skipping analytics entry without videoId');
                    return null;
                }

                // Create UserActivity record for view tracking
                if (effectiveUserId && watchDuration > 0) {
                    await UserActivity.create({
                        userId: effectiveUserId,
                        eventType: 'view',
                        articleId: videoId,
                        duration: Math.round(watchDuration / 1000), // Convert ms to seconds
                        timestamp: new Date(analytics.startTime || Date.now())
                    }).catch(err => console.warn('Failed to create view activity:', err.message));

                    // Also track in Redis cache for fast lookups
                    await trackViewInCache(effectiveUserId, videoId);
                }

                // Track interactions as separate activities
                if (effectiveUserId && interactions) {
                    const interactionPromises = [];

                    if (interactions.liked) {
                        interactionPromises.push(
                            UserActivity.create({
                                userId: effectiveUserId,
                                eventType: 'like',
                                articleId: videoId,
                                timestamp: new Date()
                            }).catch(err => console.warn('Failed to track like:', err.message))
                        );
                    }

                    if (interactions.saved) {
                        interactionPromises.push(
                            UserActivity.create({
                                userId: effectiveUserId,
                                eventType: 'save',
                                articleId: videoId,
                                timestamp: new Date()
                            }).catch(err => console.warn('Failed to track save:', err.message))
                        );
                    }

                    if (interactions.disliked) {
                        interactionPromises.push(
                            UserActivity.create({
                                userId: effectiveUserId,
                                eventType: 'dislike',
                                articleId: videoId,
                                timestamp: new Date()
                            }).catch(err => console.warn('Failed to track dislike:', err.message))
                        );
                    }

                    await Promise.all(interactionPromises);
                }

                // Update reel completion rate and watch time if video exists
                if (completionRate > 0 || watchDuration > 0) {
                    try {
                        // Get current reel data to calculate averages
                        const reel = await Reel.findById(videoId).select('completionRates totalWatchTime viewCount likes dislikes');

                        if (reel) {
                            const updates = {
                                updatedAt: new Date(),
                                $inc: { viewCount: 1 }, // INCREMENT VIEW COUNT
                                $set: {} // Initialize $set
                            };

                            // Add user to viewedBy if authenticated (ALWAYS, not just for completion)
                            if (effectiveUserId) {
                                updates.$addToSet = { viewedBy: effectiveUserId };
                            }

                            // Update completion rate
                            if (completionRate > 0) {
                                const newCompletionRates = [...(reel.completionRates || []), completionRate];
                                const avgCompletionRate = newCompletionRates.reduce((sum, rate) => sum + rate, 0) / newCompletionRates.length;

                                updates.$push = { completionRates: completionRate };
                                updates.$set.completionRate = avgCompletionRate;
                            }

                            // Update watch time
                            if (watchDuration > 0) {
                                const newTotalWatchTime = (reel.totalWatchTime || 0) + watchDuration;
                                // Use the NEW viewCount for average calculation (after increment)
                                const newViewCount = (reel.viewCount || 0) + 1;
                                const avgWatchTime = newTotalWatchTime / newViewCount;

                                updates.$set.totalWatchTime = newTotalWatchTime;
                                updates.$set.avgWatchTime = avgWatchTime;
                            }

                            // First update the reel with new metrics
                            await Reel.findByIdAndUpdate(videoId, updates);

                            // UPDATE USER'S VIEWED REELS (sync User.viewed_reels with Reel.viewedBy)
                            if (effectiveUserId) {
                                try {
                                    const User = require('../models/User');
                                    await User.findOneAndUpdate(
                                        { supabase_id: effectiveUserId },
                                        { $addToSet: { viewed_reels: videoId } }
                                    );
                                    console.log(`✅ Added reel ${videoId} to user ${effectiveUserId.substring(0, 8)}... viewed_reels`);
                                } catch (userUpdateErr) {
                                    console.warn('⚠️ Failed to update user viewed_reels:', userUpdateErr.message);
                                }
                            }

                            // RECALCULATE ENGAGEMENT SCORE after metrics update
                            // Note: viewCount is already incremented, completionRate is updated above
                            const newViewCount = (reel.viewCount || 0) + 1;
                            const newCompletionRate = completionRate > 0
                                ? ([...(reel.completionRates || []), completionRate].reduce((s, r) => s + r, 0) / (reel.completionRates?.length + 1 || 1))
                                : (reel.completionRate || 0);

                            const engagementScore = (
                                newViewCount * 0.3 +
                                (reel.likes || 0) * 0.5 +
                                newCompletionRate * 0.2
                            );

                            // Update engagement_score separately
                            await Reel.findByIdAndUpdate(videoId, { engagement_score: engagementScore });

                            console.log(`✅ Updated reel ${videoId}: viewCount +1 (${newViewCount}), completion ${completionRate}%, engagement ${engagementScore.toFixed(2)}`);
                        } else {
                            console.warn(`⚠️ Reel ${videoId} not found in database`);
                        }
                    } catch (err) {
                        console.warn('Failed to update reel analytics:', err.message);
                    }
                }

                return {
                    videoId,
                    processed: true,
                    completionRate: completionRate || 0,
                    watchDuration: watchDuration || 0
                };

            } catch (err) {
                console.error('❌ Error processing analytics entry:', err.message);
                return { videoId: analytics.videoId, processed: false, error: err.message };
            }
        });

        const results = await Promise.all(analyticsPromises);
        const successful = results.filter(r => r && r.processed).length;
        const failed = results.filter(r => r && !r.processed).length;

        console.log(`✅ Video analytics batch processed: ${successful} successful, ${failed} failed`);

        res.json({
            success: true,
            processed: successful,
            failed,
            batchSize: batch.length,
            sessionId: session?.sessionId,
            userId: effectiveUserId ? effectiveUserId.substring(0, 8) + '...' : 'anonymous'
        });

    } catch (err) {
        console.error('❌ Error processing video analytics:', err.message);
        res.status(500).json({ error: 'Failed to process video analytics' });
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
            { new: true, select: 'likes dislikes likedBy dislikedBy viewCount completionRate' }
        );

        // Recalculate engagement_score after like change
        const engagementScore = (
            (updatedReel.viewCount || 0) * 0.3 +
            (updatedReel.likes || 0) * 0.5 +
            (updatedReel.completionRate || 0) * 0.2
        );

        await Reel.findByIdAndUpdate(reelId, { engagement_score: engagementScore });

        // ⚡ PHASE 1: Invalidate user embedding cache on interaction
        try {
            await redis.del(`user:emb:${userId}`);
            console.log(`🗑️ Invalidated embedding cache for user ${userId.substring(0, 8)}...`);
        } catch (cacheErr) {
            console.warn('⚠️ Failed to invalidate cache:', cacheErr.message);
        }

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
            isDisliked: isDisliked && !isLiked ? false : !updatedReel.dislikedBy.includes(userId),
            engagementScore
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
            { new: true, select: 'likes dislikes likedBy dislikedBy viewCount completionRate' }
        );

        // Recalculate engagement_score after dislike change
        const engagementScore = (
            (updatedReel.viewCount || 0) * 0.3 +
            (updatedReel.likes || 0) * 0.5 +
            (updatedReel.completionRate || 0) * 0.2
        );

        await Reel.findByIdAndUpdate(reelId, { engagement_score: engagementScore });

        // ⚡ PHASE 1: Invalidate user embedding cache on interaction
        try {
            await redis.del(`user:emb:${userId}`);
            console.log(`🗑️ Invalidated embedding cache for user ${userId.substring(0, 8)}...`);
        } catch (cacheErr) {
            console.warn('⚠️ Failed to invalidate cache:', cacheErr.message);
        }

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
            isDisliked: !isDisliked,
            engagementScore
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

        // ⚡ PHASE 1: Invalidate user embedding cache on interaction
        try {
            await redis.del(`user:emb:${userId}`);
            console.log(`🗑️ Invalidated embedding cache for user ${userId.substring(0, 8)}...`);
        } catch (cacheErr) {
            console.warn('⚠️ Failed to invalidate cache:', cacheErr.message);
        }

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

        // 1. Get direct video URL from Instagram (with timeout)
        console.log('🔍 Extracting direct video URL...');
        let directVideoUrl;
        try {
            const extractPromise = getInstagramVideoUrl(reelUrl);
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Instagram extraction timeout after 30s')), 30000)
            );

            directVideoUrl = await Promise.race([extractPromise, timeoutPromise]);
            console.log(`🎯 Extracted video URL: ${directVideoUrl}`);
        } catch (error) {
            console.error('❌ Failed to extract Instagram video URL:', error);
            return res.status(400).json({
                message: 'Failed to extract video from Instagram URL',
                error: error.message
            });
        }

        // 2. Upload to S3 and get signed URL (with timeout)
        const filename = `gulfio-${Date.now()}.mp4`;
        let uploadResult;
        try {
            const uploadPromise = uploadToR2(directVideoUrl, filename);
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Upload timeout after 60s')), 60000)
            );

            uploadResult = await Promise.race([uploadPromise, timeoutPromise]);
            console.log(`🎬 Upload completed: ${filename}`);
        } catch (error) {
            console.error('❌ Failed to upload video:', error);
            return res.status(500).json({
                message: 'Failed to upload video to storage',
                error: error.message
            });
        }

        const { signedUrl, key } = uploadResult;

        // 3. Save to MongoDB first (fast response), then generate embeddings in background
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
                // Will add embeddings in background
                embedding: null,
                embedding_pca: null
            });

            savedReel = await newReel.save();
            console.log(`💾 Saved to MongoDB: ${savedReel._id}`);
        } catch (error) {
            console.error('❌ Failed to save to database:', error);
            return res.status(500).json({
                message: 'Failed to save video to database',
                error: error.message
            });
        }

        // 4. Generate embeddings and thumbnail in background (non-blocking)
        setTimeout(async () => {
            try {
                console.log('🧠 Starting background embedding generation...');
                const embedInput = `${caption}\n\n${reelUrl}`;

                let embedding = null;
                let embedding_pca = null;

                try {
                    console.log('🔄 Calling getDeepSeekEmbedding...');
                    embedding = await getDeepSeekEmbedding(embedInput);
                    console.log(`🧠 Generated embedding: ${embedding?.length} dimensions`);

                    // Generate PCA embedding if the main embedding was successful
                    if (embedding && embedding.length === 1536) {
                        console.log('🔄 Converting to PCA embedding...');
                        embedding_pca = await convertToPCAEmbedding(embedding);
                        if (embedding_pca) {
                            console.log(`🧠 Generated PCA embedding: ${embedding_pca.length} dimensions`);
                        } else {
                            console.warn('⚠️ Failed to generate PCA embedding - will save without PCA');
                        }
                    } else {
                        console.warn(`⚠️ Embedding size unexpected: ${embedding?.length} (expected 1536)`);
                    }
                } catch (embeddingError) {
                    console.error('❌ Failed to generate embedding:', {
                        error: embeddingError.message,
                        stack: embeddingError.stack,
                        input: embedInput.substring(0, 100) + '...'
                    });
                }

                // Update reel with embeddings (even if only one is successful)
                if (embedding || embedding_pca) {
                    const updateData = { updatedAt: new Date() };
                    if (embedding) updateData.embedding = embedding;
                    if (embedding_pca) updateData.embedding_pca = embedding_pca;

                    await Reel.findByIdAndUpdate(savedReel._id, updateData);
                    console.log(`✅ Updated reel ${savedReel._id} with embeddings - full: ${!!embedding}, PCA: ${!!embedding_pca}`);
                } else {
                    console.error(`❌ No embeddings generated for reel ${savedReel._id}`);
                }
            } catch (error) {
                console.error('❌ Background embedding generation failed:', {
                    error: error.message,
                    stack: error.stack,
                    reelId: savedReel._id
                });
            }
        }, 100); // Start after 100ms

        // 5. Generate thumbnail in background (don't wait for it)
        setTimeout(async () => {
            try {
                const { thumbnailGenerator } = require('../services/ThumbnailGenerator');
                console.log('🎬 Starting background thumbnail generation...');

                // Use the new method that fetches video URL from database by reel ID
                const thumbnailUrl = await thumbnailGenerator.generateThumbnailById(savedReel._id);

                if (thumbnailUrl) {
                    // Update the reel with thumbnail URL
                    await Reel.findByIdAndUpdate(savedReel._id, {
                        thumbnailUrl,
                        updatedAt: new Date()
                    });
                    console.log(`✅ Thumbnail generated and saved for ${savedReel._id}: ${thumbnailUrl}`);
                } else {
                    console.warn(`⚠️ Thumbnail generation returned null for ${savedReel._id}`);
                }
            } catch (err) {
                console.error(`❌ Thumbnail generation failed for ${savedReel._id}:`, {
                    error: err.message,
                    stack: err.stack,
                    reelId: savedReel._id,
                    videoUrl: signedUrl
                });

                // Optional: Set a flag in the database that thumbnail generation failed
                try {
                    await Reel.findByIdAndUpdate(savedReel._id, {
                        thumbnailGenerationFailed: true,
                        thumbnailError: err.message,
                        updatedAt: new Date()
                    });
                } catch (updateErr) {
                    console.error(`Failed to update thumbnail error status: ${updateErr.message}`);
                }
            }
        }, 1000); // Start after 1 second to let DB save complete

        res.json({
            message: '✅ Reel uploaded and saved!',
            reel: {
                _id: savedReel._id,
                videoUrl: savedReel.videoUrl,
                caption: savedReel.caption,
                source: savedReel.source,
                scrapedAt: savedReel.scrapedAt
            }
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
            .select('source reelId videoUrl thumbnailUrl caption likes dislikes viewCount saves scrapedAt publishedAt engagement_score')
            .populate('source', 'name icon favicon') // Populate source info
            .sort({ viewCount: -1, likes: -1 })
            .limit(20)
            .lean();

        // Map engagement_score to engagementScore for frontend compatibility
        const mappedTrending = trending.map(reel => ({
            ...reel,
            engagementScore: reel.engagement_score
        }));

        reelCache.set(cacheKey, mappedTrending);
        res.json(mappedTrending);
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
        const selectFields = `source reelId videoUrl thumbnailUrl caption likes dislikes viewCount saves scrapedAt publishedAt engagement_score ${embeddingField}`;

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

        // Map engagement_score to engagementScore for frontend compatibility
        const mappedFinalReels = finalReels.map(reel => ({
            ...reel,
            engagementScore: reel.engagement_score
        }));

        res.json(mappedFinalReels);
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
// Helper function to check if a signed URL is expired
const isUrlExpired = (url) => {
    if (!url) return true;

    try {
        const urlObj = new URL(url);
        const expires = urlObj.searchParams.get('X-Amz-Expires');
        const xAmzDate = urlObj.searchParams.get('X-Amz-Date');

        if (!expires || !xAmzDate) {
            return true; // No expiration info = treat as expired
        }

        // Parse the X-Amz-Date (format: 20251004T203338Z)
        const signTime = new Date(xAmzDate.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/, '$1-$2-$3T$4:$5:$6Z'));
        const expiryTime = new Date(signTime.getTime() + parseInt(expires) * 1000);
        const now = new Date();

        // Add 1 hour buffer before expiry to ensure URLs don't expire while in use
        const bufferTime = new Date(expiryTime.getTime() - (60 * 60 * 1000)); // 1 hour before expiry

        return now > bufferTime;
    } catch (error) {
        console.warn('Error checking URL expiration:', error.message);
        return true; // If we can't parse, treat as expired
    }
};

// Refresh signed S3 URLs for all Reels — for Google Cloud Scheduler
router.post('/reels/refresh-urls', async (req, res) => {
    try {
        const secret = req.headers['x-api-key'];
        if (secret !== ADMIN_API_KEY) {
            return res.status(403).json({ error: 'Forbidden' });
        }

        const force = String(req.query.force || '').toLowerCase() === 'true';
        const limit = parseInt(req.query.limit) || 1000; // Process in batches
        const skip = parseInt(req.query.skip) || 0;

        console.log(`🔄 Starting URL refresh - Force: ${force}, Limit: ${limit}, Skip: ${skip}`);

        const reels = await Reel.find({}, '_id originalKey videoUrl updatedAt')
            .limit(limit)
            .skip(skip)
            .lean();

        let refreshed = 0;
        let backfilledOriginalKey = 0;
        let skipped = 0;
        let failed = 0;
        let alreadyFresh = 0;

        console.log(`📊 Processing ${reels.length} reels`);

        for (const reel of reels) {
            try {
                // Skip R2 URLs as they are public and don't need refreshing
                if (reel.videoUrl && reel.videoUrl.includes('.r2.dev')) {
                    console.log(`🔄 Skipping R2 reel ${reel._id} - public URL doesn't need refresh`);
                    skipped++;
                    continue;
                }

                // Only process S3 URLs (signed URLs that expire)
                if (!reel.videoUrl || !reel.videoUrl.includes('amazonaws.com')) {
                    console.warn(`⚠️ Skipping reel ${reel._id} - not an S3 URL`);
                    skipped++;
                    continue;
                }

                let key = reel.originalKey;

                // Try to extract key from URL if originalKey is missing
                if (!key && reel.videoUrl) {
                    key = extractKeyFromUrl(reel.videoUrl);
                }

                if (!key) {
                    console.warn(`⚠️ No key found for S3 reel ${reel._id}`);
                    skipped++;
                    continue;
                }

                // Check if URL is expired or force refresh
                const urlExpired = isUrlExpired(reel.videoUrl);

                if (!force && !urlExpired) {
                    alreadyFresh++;
                    continue;
                }

                // Determine which bucket to use based on URL
                let bucketToUse = storageConfig.bucket;

                // If the URL is from a different storage system, extract the correct bucket
                if (reel.videoUrl) {
                    const urlHost = new URL(reel.videoUrl).hostname.toLowerCase();

                    // Extract bucket from S3 URL if different from config
                    if (urlHost.includes('amazonaws.com') && urlHost.includes('.s3.')) {
                        const bucketFromUrl = urlHost.split('.s3.')[0];
                        if (bucketFromUrl && bucketFromUrl !== bucketToUse) {
                            bucketToUse = bucketFromUrl;
                            console.log(`🔄 Using bucket from URL: ${bucketToUse} for reel ${reel._id}`);
                        }
                    }
                }

                // Verify the object exists in storage
                try {
                    await s3.send(new HeadObjectCommand({ Bucket: bucketToUse, Key: key }));
                } catch (storageError) {
                    console.warn(`⚠️ Object not found for key ${key} in bucket ${bucketToUse}, reel ${reel._id}: ${storageError.message}`);
                    failed++;
                    continue;
                }

                // Generate new signed URL (valid for 7 days)
                const cmd = new GetObjectCommand({ Bucket: bucketToUse, Key: key });
                const signed = await getSignedUrl(s3, cmd, { expiresIn: 60 * 60 * 24 * 7 });

                const update = { videoUrl: signed, updatedAt: new Date() };

                // Backfill originalKey if missing
                if (!reel.originalKey) {
                    update.originalKey = key;
                    backfilledOriginalKey++;
                }

                await Reel.updateOne({ _id: reel._id }, { $set: update });
                refreshed++;

                if (refreshed % 100 === 0) {
                    console.log(`✅ Refreshed ${refreshed} URLs so far...`);
                }

            } catch (err) {
                failed++;
                console.error(`❌ Failed to refresh reel ${reel._id}: ${err.message}`);
            }
        }

        const totalReels = await Reel.countDocuments();
        const hasMore = skip + limit < totalReels;

        console.log(`🎯 S3 URL refresh complete: ${refreshed} S3 URLs refreshed, ${skipped} skipped (R2 + invalid), ${failed} failed, ${alreadyFresh} already fresh`);

        res.json({
            message: '✅ S3 reel video URLs processed (R2 URLs skipped - no refresh needed)',
            statistics: {
                s3UrlsRefreshed: refreshed,
                backfilledOriginalKey,
                skipped: `${skipped} (includes R2 reels which don't need refresh)`,
                failed,
                alreadyFresh,
                processed: reels.length,
                totalReels,
                hasMore,
                nextSkip: hasMore ? skip + limit : null
            },
            config: {
                bucket: storageConfig.bucket,
                region: storageConfig.region || AWS_S3_REGION,
                type: storageConfig.type,
                force,
                limit,
                skip
            }
        });
    } catch (err) {
        console.error('❌ Failed to refresh reel URLs:', err);
        res.status(500).json({ error: err.message, stack: err.stack });
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
