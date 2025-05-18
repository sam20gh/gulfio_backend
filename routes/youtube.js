// routes/youtube.js
const express = require('express');
const ytdl = require('ytdl-core');
const router = express.Router();

router.get('/stream/:videoId', async (req, res) => {
    const { videoId } = req.params;
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

    try {
        if (!ytdl.validateURL(videoUrl)) {
            console.error(`❌ Invalid Video URL: ${videoUrl}`);
            return res.status(400).json({ error: 'Invalid Video ID or URL' });
        }

        console.log(`🎥 Streaming YouTube video for ${videoId}`);

        // Set headers for streaming
        res.setHeader('Content-Disposition', `inline; filename="${videoId}.mp4"`);
        res.setHeader('Content-Type', 'video/mp4');

        // Stream the video - try lower quality for compatibility
        const stream = ytdl(videoUrl, {
            quality: 'lowest',
            filter: (format) => format.container === 'mp4',
        });

        stream.on('error', (err) => {
            console.error('❌ Stream Error:', err.message);
            res.status(500).json({ error: 'Failed to stream video' });
        });

        stream.pipe(res);
    } catch (err) {
        console.error('❌ Error fetching video stream:', err.message);
        res.status(500).json({ error: 'Failed to fetch video stream' });
    }
});

module.exports = router;
