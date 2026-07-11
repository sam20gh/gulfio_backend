const express = require('express');
const router = express.Router();
const UserActivity = require('../models/UserActivity');
const PointsService = require('../services/pointsService'); // 🎮 Gamification
const Article = require('../models/Article'); // For category lookup
// Removed updateUserProfileEmbedding - now handled by daily cron job

router.post('/log', async (req, res) => {
    const { userId, eventType, articleId, duration, timestamp } = req.body;

    if (!userId || !eventType) {
        return res.status(400).json({ message: 'Missing required fields' });
    }

    try {
        const newLog = new UserActivity({
            userId,
            eventType,
            articleId,
            duration,
            timestamp: timestamp || new Date(),
        });

        await newLog.save();

        // 🎮 Award points for article reads. Awaited so the app can show the
        // "+5" floating-points feedback from this response; anti-abuse
        // (cooldowns, daily caps) returns null and the app shows nothing.
        let award = null;
        if (eventType === 'view' && articleId) {
            try {
                const art = await Article.findById(articleId).select('category').lean().catch(() => null);
                award = await PointsService.awardPoints(userId, 'ARTICLE_READ', {
                    articleId,
                    category: art?.category
                });
            } catch (err) {
                console.error('⚠️ Failed to award read points:', err.message);
            }
        }

        // Embedding updates now handled by daily cron job for better performance
        // This allows instant response while still tracking all activities

        res.status(201).json({
            message: 'Activity logged',
            pointsAwarded: award?.pointsAwarded ?? 0,
            action: award ? 'article_read' : undefined,
            leveledUp: award?.leveledUp || false,
            newLevel: award?.newLevel ?? null,
        });
    } catch (error) {
        console.error('Error logging activity:', error);
        res.status(500).json({ message: 'Error logging activity', error: error.message });
    }
});
// GET /analytics/summary
router.get('/analytics/summary', async (req, res) => {
    try {
        const now = new Date();
        const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

        const summary = await UserActivity.aggregate([
            {
                $match: {
                    timestamp: { $gte: sevenDaysAgo }
                }
            },
            {
                $group: {
                    _id: "$eventType",
                    count: { $sum: 1 }
                }
            }
        ]);

        const formatted = summary.reduce((acc, item) => {
            acc[item._id] = item.count;
            return acc;
        }, {});

        res.json({ last7Days: formatted });
    } catch (error) {
        console.error("Error generating analytics summary:", error);
        res.status(500).json({ message: "Error generating analytics", error: error.message });
    }
});


module.exports = router;
