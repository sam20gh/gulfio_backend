/**
 * 📺 Video Recommendation API Routes
 * 
 * Provides personalized video recommendations using embedding similarity,
 * trending content, and diverse fallback strategies.
 */

const express = require('express');
const User = require('../models/User');
const Reel = require('../models/Reel');
const { recommendationIndex } = require('../recommendation/fastIndex');
const auth = require('../middleware/auth');
const router = express.Router();

/**
 * GET /recommend
 * Get personalized video recommendations for a user
 * Query params: userId (required), limit (optional), refresh (optional)
 */
router.get('/recommend', async (req, res) => {
    try {
        const { userId, limit = 20, refresh = 'false' } = req.query;

        if (!userId) {
            return res.status(400).json({
                error: 'userId is required'
            });
        }

        const forceRefresh = refresh === 'true';

        // Check cache first (unless force refresh)
        if (!forceRefresh) {
            const cachedRecommendations = recommendationIndex.getCachedUserRecommendations(userId);
            if (cachedRecommendations) {
                console.log(`🎯 Serving cached recommendations for user ${userId}`);
                return res.json({
                    success: true,
                    source: 'cache',
                    data: cachedRecommendations.slice(0, parseInt(limit)),
                    timestamp: new Date().toISOString()
                });
            }
        }

        console.log(`🔍 Generating fresh recommendations for user ${userId}`);

        // Get user data
        const user = await User.findOne({ supabase_id: userId })
            .select('embedding embedding_pca disliked_reels viewed_reels')
            .lean();

        let excludeIds = [];
        let userEmbedding = null;

        if (user) {
            excludeIds = [
                ...(user.disliked_reels || []).map(id => id.toString()),
                ...(user.viewed_reels || []).map(id => id.toString())
            ];
            userEmbedding = user.embedding_pca;
        } else {
            // New user - no exclusions, no personalization
            console.log(`👤 New user ${userId} - providing trending content`);
        }

        // Ensure recommendation index is built
        if (!recommendationIndex.isIndexBuilt) {
            console.log('🏗️ Building recommendation index...');
            await recommendationIndex.buildIndex();
        }

        let recommendations = [];

        // Strategy 1: Use user embedding for personalized recommendations
        if (userEmbedding && userEmbedding.length > 0) {
            console.log('🎯 Using PCA user embedding for personalized recommendations');

            const similarVideos = await recommendationIndex.findSimilar(
                userEmbedding,
                {
                    limit: Math.floor(parseInt(limit) * 0.7), // 70% personalized
                    excludeIds,
                    minSimilarity: 0.1
                }
            );

            recommendations.push(...similarVideos);

        } else if (user && user.embedding && user.embedding.length > 0) {
            console.log('⚠️ User has original embedding but no PCA - using fallback');
            // Fallback to trending if no PCA embedding available
        } else {
            console.log('👤 New user - using trending content');
        }

        // Strategy 2: Add trending videos
        const trendingLimit = Math.max(1, Math.floor(parseInt(limit) * 0.2)); // 20% trending
        const trendingVideos = await recommendationIndex.getTrendingVideos({
            limit: trendingLimit,
            excludeIds: [...excludeIds, ...recommendations.map(r => r._id.toString())]
        });

        recommendations.push(...trendingVideos);

        // Strategy 3: Add diverse/exploratory content
        const diverseLimit = Math.max(1, parseInt(limit) - recommendations.length); // Fill remaining
        if (diverseLimit > 0) {
            const diverseVideos = await recommendationIndex.getDiverseVideos({
                limit: diverseLimit,
                excludeIds: [...excludeIds, ...recommendations.map(r => r._id.toString())]
            });

            recommendations.push(...diverseVideos);
        }

        // Shuffle to mix personalized + trending + diverse
        recommendations = recommendations
            .sort(() => Math.random() - 0.5)
            .slice(0, parseInt(limit));

        // Cache the results
        recommendationIndex.cacheUserRecommendations(userId, recommendations);

        console.log(`✅ Generated ${recommendations.length} recommendations for user ${userId}`);

        res.json({
            success: true,
            source: 'fresh',
            data: recommendations,
            stats: {
                total: recommendations.length,
                personalized: userEmbedding ? Math.floor(parseInt(limit) * 0.7) : 0,
                trending: trendingLimit,
                diverse: diverseLimit
            },
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('❌ Error generating recommendations:', error);
        res.status(500).json({
            error: 'Failed to generate recommendations',
            details: error.message
        });
    }
});

/**
 * POST /recommend/feedback
 * Record user feedback (not interested) to improve future recommendations
 */
router.post('/recommend/feedback', auth, async (req, res) => {
    try {
        const { videoId, feedback, categories } = req.body;
        const userId = req.user.supabase_id;

        if (!videoId || !feedback) {
            return res.status(400).json({
                error: 'videoId and feedback are required'
            });
        }

        // Update user preferences based on feedback
        const updateData = {};

        if (feedback === 'not_interested') {
            updateData.$addToSet = {
                disliked_reels: videoId
            };

            // If categories provided, add them to disliked categories
            if (categories && Array.isArray(categories)) {
                updateData.$addToSet.disliked_categories = { $each: categories };
            }
        }

        if (Object.keys(updateData).length > 0) {
            await User.updateOne(
                { supabase_id: userId },
                updateData
            );

            // Clear user cache to force fresh recommendations
            recommendationIndex.clearUserCache(userId);

            console.log(`📝 Recorded ${feedback} feedback for user ${userId} on video ${videoId}`);
        }

        res.json({
            success: true,
            message: 'Feedback recorded successfully'
        });

    } catch (error) {
        console.error('❌ Error recording feedback:', error);
        res.status(500).json({
            error: 'Failed to record feedback',
            details: error.message
        });
    }
});

/**
 * POST /recommend/rebuild-index
 * Manually rebuild the recommendation index (admin only)
 */
router.post('/recommend/rebuild-index', async (req, res) => {
    try {
        console.log('🔄 Manual index rebuild requested');

        const success = await recommendationIndex.forceRebuild();

        if (success) {
            res.json({
                success: true,
                message: 'Index rebuilt successfully',
                stats: recommendationIndex.getStats()
            });
        } else {
            res.status(500).json({
                success: false,
                error: 'Failed to rebuild index'
            });
        }

    } catch (error) {
        console.error('❌ Error rebuilding index:', error);
        res.status(500).json({
            error: 'Failed to rebuild index',
            details: error.message
        });
    }
});

/**
 * GET /recommend/stats
 * Get recommendation system statistics
 */
router.get('/recommend/stats', async (req, res) => {
    try {
        const stats = recommendationIndex.getStats();

        // Add database stats
        const totalReels = await Reel.countDocuments();
        const reelsWithEmbeddings = await Reel.countDocuments({
            embedding: { $exists: true, $not: { $size: 0 } }
        });
        const reelsWithPcaEmbeddings = await Reel.countDocuments({
            embedding_pca: { $exists: true, $not: { $size: 0 } }
        });

        res.json({
            success: true,
            indexStats: stats,
            databaseStats: {
                totalReels,
                reelsWithEmbeddings,
                reelsWithPcaEmbeddings,
                pcaProgress: totalReels > 0 ? (reelsWithPcaEmbeddings / totalReels * 100).toFixed(1) + '%' : '0%'
            },
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('❌ Error getting stats:', error);
        res.status(500).json({
            error: 'Failed to get stats',
            details: error.message
        });
    }
});

module.exports = router;
