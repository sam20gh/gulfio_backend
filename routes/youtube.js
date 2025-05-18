// routes/youtube.js
const express = require('express');
const ytdl = require('ytdl-core');
const router = express.Router();

router.get('/stream/:videoId', async (req, res) => {
    const { videoId } = req.params;
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

    console.log(`🎥 Attempting to stream video: ${videoUrl}`);

    try {
        // Check if the video URL is valid
        if (!ytdl.validateURL(videoUrl)) {
            console.error(`❌ Invalid Video URL: ${videoUrl}`);
            return res.status(400).json({ error: 'Invalid Video URL' });
        }

        // Fetch information to get the direct stream URL
        console.log(`🌐 Fetching video info for ${videoId}`);
        const info = await ytdl.getInfo(videoUrl);

        console.log(`✅ Video Info Fetched for ${videoId}`);

        // Choose the best format available
        const format = ytdl.chooseFormat(info.formats, {
            quality: 'highest',
            filter: (format) => format.container === 'mp4',
        });

        if (!format || !format.url) {
            console.error(`❌ No playable video found for ${videoId}`);
            console.log(`⚠️ Available Formats:`, info.formats.map(f => f.container));
            return res.status(404).json({ error: 'No playable video found' });
        }

        console.log(`✅ Found stream URL: ${format.url}`);
        res.json({ url: format.url });

    } catch (err) {
        console.error('❌ Error fetching video stream:', err.message);
        res.status(500).json({ error: 'Failed to fetch video stream' });
    }
});

module.exports = router;
