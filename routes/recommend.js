/**
 * 📺 Video Recommendation API Routes
 * Personalized video recommendations with page-aware recency blending.
 */

const express = require('express');
const User = require('../models/User');
const { recommendationIndex } = require('../recommendation/fastIndex');
const auth = require('../middleware/auth');

const router = express.Router();

/**
 * GET /recommend
 * Get personalized video recommendations for a user
 * Query: userId (required), limit, refresh, page
 */
router.get('/recommend', async (req, res) => {
    try {
        const { userId, limit = 20, refresh = 'false', page = 1 } = req.query;

        if (!userId) {
            return res.status(400).json({ error: 'userId is required' });
        }

        const forceRefresh = refresh === 'true';
        const pageNum = Math.max(1, parseInt(page, 10) || 1);

        // Cache unless forced
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

        // Pull user profile
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
            console.log(`👤 New user ${userId} - providing trending content`);
        }

        // Ensure index
        if (!recommendationIndex.isIndexBuilt) {
            console.log('🏗️ Building recommendation index...');
            await recommendationIndex.buildIndex();
        }

        let recommendations = [];

        // 1) Personalized (embedding)
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
            // keep trending fallback
        } else {
            console.log('👤 New user - using trending content');
        }

        // 2) Trending (20%)
        const trendingLimit = Math.max(1, Math.floor(parseInt(limit) * 0.2));
        const trendingVideos = await recommendationIndex.getTrendingVideos({
            limit: trendingLimit,
            excludeIds: [...excludeIds, ...recommendations.map(r => r._id.toString())]
        });
        recommendations.push(...trendingVideos);

        // 3) Diverse fill (remaining)
        const diverseLimit = Math.max(1, parseInt(limit) - recommendations.length);
        if (diverseLimit > 0) {
            const diverseVideos = await recommendationIndex.getDiverseVideos({
                limit: diverseLimit,
                excludeIds: [...excludeIds, ...recommendations.map(r => r._id.toString())]
            });
            recommendations.push(...diverseVideos);
        }

        /** ---- Page-aware re-rank (replaces the old random shuffle) ----
         * Previously: shuffle + slice. :contentReference[oaicite:7]{index=7}
         */
        const freshRatio =
            pageNum === 1 ? 0.70 :
                pageNum === 2 ? 0.55 :
                    pageNum === 3 ? 0.45 :
                        0.35;

        const now = Date.now();
        const recency = (ts) => {
            const t = new Date(ts || Date.now()).getTime();
            const hours = (now - t) / (1000 * 60 * 60);
            if (hours <= 24) return 1.0;
            if (hours <= 48) return 0.8;
            if (hours <= 72) return 0.6;
            if (hours <= 168) return 0.4;
            return Math.max(0, 1 - hours / (24 * 30));
        };

        const withScores = recommendations.map(r => {
            const similarity = typeof r.similarity === 'number'
                ? r.similarity
                : typeof r.score === 'number'
                    ? r.score
                    : 0.5;
            const popularity = (r.views || r.viewCount || 0) * 0.7 + (r.likes || 0) * 0.3;
            const baseScore = 0.6 * similarity + 0.4 * popularity;
            const recencyScore = recency(r.publishedAt || r.createdAt);
            const finalScore = freshRatio * recencyScore + (1 - freshRatio) * baseScore;
            return { ...r, finalScore };
        });

        recommendations = withScores
            .sort((a, b) => (b.finalScore ?? 0) - (a.finalScore ?? 0))
            .slice(0, parseInt(limit));

        // Cache result
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
 * Record user feedback (not interested)
 */
router.post('/recommend/feedback', auth, async (req, res) => {
    try {
        const { videoId, feedback, categories } = req.body;
        const userId = req.user.supabase_id;

        if (!videoId || !feedback) {
            return res.status(400).json({ error: 'videoId and feedback are required' });
        }

        const updateData = {};
        if (feedback === 'not_interested') {
            updateData.$addToSet = { disliked_reels: videoId };
            if (categories && Array.isArray(categories)) {
                updateData.$addToSet.disliked_categories = { $each: categories };
            }
        }

        if (Object.keys(updateData).length > 0) {
            await User.updateOne({ supabase_id: userId }, updateData);
            recommendationIndex.clearUserCache(userId);
            console.log(`📝 Recorded ${feedback} feedback for user ${userId} on video ${videoId}`);
        }

        res.json({ success: true, message: 'Feedback recorded successfully' });
    } catch (error) {
        console.error('❌ Error recording feedback:', error);
        res.status(500).json({ error: 'Failed to record feedback', details: error.message });
    }
});

/**
 * POST /recommend/rebuild-index
 * Rebuild recommendation index (admin)
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
            res.status(500).json({ success: false, error: 'Failed to rebuild index' });
        }
    } catch (error) {
        console.error('❌ Error rebuilding index:', error);
        res.status(500).json({ error: 'Failed to rebuild index', details: error.message });
    }
});

module.exports = router;
