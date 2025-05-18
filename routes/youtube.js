// routes/youtube.js
const express = require('express');
const ytdl = require('ytdl-core');
const router = express.Router();

router.get('/stream/:videoId', async (req, res) => {
    const { videoId } = req.params;

    try {
        if (!ytdl.validateID(videoId)) {
            return res.status(400).json({ error: 'Invalid Video ID' });
        }

        const info = await ytdl.getInfo(videoId);
        const format = ytdl.chooseFormat(info.formats, { quality: 'highestvideo' });

        if (!format.url) {
            return res.status(404).json({ error: 'No playable video found' });
        }

        res.json({ url: format.url });
    } catch (err) {
        console.error('Error fetching video stream:', err.message);
        res.status(500).json({ error: 'Failed to fetch video stream' });
    }
});

module.exports = router;
