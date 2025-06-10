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

module.exports = router;
