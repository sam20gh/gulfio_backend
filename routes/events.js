const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const ensureMongoUser = require('../middleware/ensureMongoUser');
const { logUserActivity } = require('../utils/logEvent');

// Post event
router.post('/', auth, ensureMongoUser, async (req, res) => {
    try {
        const { eventType, articleId, duration } = req.body;

        if (!eventType || !articleId) {
            return res.status(400).json({ message: 'eventType and articleId are required' });
        }

        await logUserActivity({
            userId: req.mongoUser._id,
            eventType,
            articleId,
            duration
        });

        res.status(200).json({ success: true });
    } catch (error) {
        console.error('Error logging event:', error);
        res.status(500).json({ message: 'Failed to log event' });
    }
});

module.exports = router;
