// routes/youtube.js
const express = require('express');
const puppeteer = require('puppeteer');
const router = express.Router();

router.get('/stream/:videoId', async (req, res) => {
    const { videoId } = req.params;
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

    console.log(`🎥 Attempting to stream video via Puppeteer Proxy: ${videoUrl}`);

    try {
        // Launch Puppeteer
        const browser = await puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
            ],
        });

        const page = await browser.newPage();
        await page.goto(videoUrl, { waitUntil: 'networkidle2' });

        // Extract the video stream URL
        const videoSrc = await page.evaluate(() => {
            const video = document.querySelector('video');
            return video ? video.src : null;
        });

        await browser.close();

        if (!videoSrc) {
            console.error('❌ Could not extract video source');
            return res.status(404).json({ error: 'Video stream not available' });
        }

        console.log(`✅ Video stream found: ${videoSrc}`);
        res.json({ url: videoSrc });

    } catch (err) {
        console.error('❌ Error fetching video stream via Puppeteer:', err.message);
        res.status(500).json({ error: 'Failed to fetch video stream' });
    }
});

module.exports = router;
