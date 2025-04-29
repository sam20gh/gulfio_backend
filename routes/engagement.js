const express = require('express');
const router = express.Router();
const UserActivity = require('../models/UserActivity');

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

        res.status(201).json({ message: 'Activity logged' });
    } catch (error) {
        console.error('Error logging activity:', error);
        res.status(500).json({ message: 'Error logging activity', error: error.message });
    }
});

module.exports = router;
