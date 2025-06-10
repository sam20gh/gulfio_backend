const express = require('express');
const Video = require('../models/Video');
const Reel = require('../models/Reel'); // 👈 Make sure this model exists
const router = express.Router();

// GET /api/videos
router.get('/', async (req, res) => {
    try {
        const videos = await Video.find().sort({ publishedAt: -1 }).limit(20);
        res.json(videos);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Failed to fetch videos' });
    }
});

// ✅ NEW: GET /api/videos/reels
router.get('/reels', async (req, res) => {
    try {
        const reels = await Reel.find().sort({ scrapedAt: -1 }).limit(20);
        res.json(reels);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Failed to fetch reels' });
    }
});

module.exports = router;
