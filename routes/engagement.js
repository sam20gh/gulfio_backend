const express = require('express');
const router = express.Router();
const UserActivity = require('../models/UserActivity');
const { updateUserProfileEmbedding } = require('../utils/userEmbedding');

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

        // Update user embedding after logging activity
        try {
            await updateUserProfileEmbedding(userId);
        } catch (embeddingError) {
            console.error('Error updating user embedding:', embeddingError);
            // Don't fail the request if embedding update fails
        }

        res.status(201).json({ message: 'Activity logged' });
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
