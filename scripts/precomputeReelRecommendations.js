/**
 * Precompute Video Recommendations Script
 * 
 * This script precomputes personalized video recommendations for active users
 * using Atlas Search and caches them in Redis for faster API responses.
 */

const mongoose = require('mongoose');
const redis = require('../utils/redis');
const UserActivity = require('../models/UserActivity');
const Reel = require('../models/Reel');
const crypto = require('crypto');
require('dotenv').config();

// Import helper functions from videos route
const { cosineSimilarity } = require('../routes/videos');

// Helper function to get user preferences (simplified version)
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

        const likedReels = await Reel.find({
            likedBy: userId
        }).select('source categories embedding embedding_pca').populate('source', 'name').lean();

        const savedReels = await Reel.find({
            savedBy: userId
        }).select('source categories embedding embedding_pca').populate('source', 'name').lean();

        // Calculate average embedding for content-based recommendations
        let averageEmbedding = null;
        const validEmbeddings = [...likedReels, ...savedReels]
            .filter(reel => reel.embedding_pca && reel.embedding_pca.length === 128)
            .map(reel => reel.embedding_pca);

        if (validEmbeddings.length > 0) {
            averageEmbedding = new Array(128).fill(0);
            validEmbeddings.forEach(embedding => {
                embedding.forEach((val, idx) => {
                    averageEmbedding[idx] += val;
                });
            });
            averageEmbedding = averageEmbedding.map(val => val / validEmbeddings.length);
        }

        return {
            averageEmbedding,
            totalInteractions: recentActivity.length + likedReels.length + savedReels.length,
            disliked_videos: []
        };
    } catch (error) {
        console.error('Error getting user preferences:', error);
        return {
            averageEmbedding: null,
            totalInteractions: 0,
            disliked_videos: []
        };
    }
}

// Helper function for intelligent shuffle
function intelligentShuffle(reels, seed = Date.now()) {
    const result = [...reels];
    let rng = () => {
        const x = Math.sin(seed++) * 10000;
        return x - Math.floor(x);
    };

    for (let i = result.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [result[i], result[j]] = [result[j], result[i]];
    }

    return result;
}

async function precomputeRecommendations() {
    try {
        console.log('🔄 Starting precomputation of video recommendations...');

        // Connect to MongoDB
        await mongoose.connect(process.env.MONGO_URI);
        console.log('✅ Connected to MongoDB');

        // Get list of active users (users with recent activity)
        const activeUsers = await UserActivity.distinct('userId', {
            timestamp: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } // Last 7 days
        });

        console.log(`👥 Found ${activeUsers.length} active users`);

        let processed = 0;
        const batchSize = 10;

        for (let i = 0; i < activeUsers.length; i += batchSize) {
            const batch = activeUsers.slice(i, i + batchSize);

            await Promise.all(batch.map(async (userId) => {
                try {
                    const sessionId = crypto.randomUUID();
                    const cacheKey = `reels_personalized_${userId}_page_0_limit_20_session_${sessionId}`;

                    // Get user preferences
                    const userPrefs = await getUserPreferences(userId);
                    const userEmbedding = userPrefs.averageEmbedding;

                    if (!userEmbedding || !Array.isArray(userEmbedding) || userEmbedding.length !== 128) {
                        console.log(`⚠️ Skipping user ${userId} - no valid embedding`);
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
                    await redis.set(cacheKey, JSON.stringify(finalReels), 'EX', 3600);

                    processed++;
                    if (processed % 50 === 0) {
                        console.log(`📊 Processed ${processed}/${activeUsers.length} users`);
                    }

                } catch (error) {
                    console.error(`❌ Error processing user ${userId}:`, error.message);
                }
            }));
        }

        console.log(`🎉 Precomputation completed! Processed ${processed} users`);

    } catch (error) {
        console.error('❌ Precomputation failed:', error);
        process.exit(1);
    } finally {
        await mongoose.disconnect();
        console.log('👋 Disconnected from MongoDB');
        process.exit(0);
    }
}

// Run the script
if (require.main === module) {
    precomputeRecommendations();
}

module.exports = { precomputeRecommendations };
