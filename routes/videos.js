const express = require('express');
const Video = require('../models/Video');
const Reel = require('../models/Reel');
const Source = require('../models/Source');
const puppeteer = require('puppeteer');
const axios = require('axios'); // Replace fetch with axios
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const getDeepSeekEmbedding = require('../utils/deepseek'); // Adjust the path as needed
const router = express.Router();

// You should have dotenv.config() in your main entrypoint (not needed here if already loaded)
const {
    R2_ENDPOINT,
    R2_ACCESS_KEY,
    R2_SECRET_KEY,
    R2_BUCKET
} = process.env;

// Helper: Get the real Instagram video URL with multiple extraction strategies
async function getInstagramVideoUrl(reelUrl) {
    const browser = await puppeteer.launch({ headless: 'new' });
    const page = await browser.newPage();
    await page.goto(reelUrl, { waitUntil: 'networkidle2', timeout: 30000 });

    // Get all <script> tag contents as one string
    const html = await page.content();

    // Try to extract video_url from embedded JSON
    const matches = html.match(/"video_url":"([^"]+)"/);
    let videoUrl = null;
    if (matches && matches[1]) {
        videoUrl = matches[1].replace(/\\u0026/g, '&').replace(/\\/g, '');
    }

    await browser.close();

    if (!videoUrl || !videoUrl.startsWith('http')) {
        throw new Error('Unable to extract Instagram mp4 video URL. Maybe the reel is private or Instagram changed its markup.');
    }
    return videoUrl;
}

// Helper: Upload to R2
const s3 = new S3Client({
    region: 'auto',
    endpoint: R2_ENDPOINT,
    credentials: {
        accessKeyId: R2_ACCESS_KEY,
        secretAccessKey: R2_SECRET_KEY,
    }
});

async function uploadToR2(videoUrl, filename) {
    try {
        const response = await axios({
            method: 'get',
            url: videoUrl,
            responseType: 'arraybuffer'
        });

        const buffer = Buffer.from(response.data);
        const command = new PutObjectCommand({
            Bucket: R2_BUCKET,
            Key: filename,
            Body: buffer,
            ContentType: 'video/mp4'
        });

        await s3.send(command);

        // The public URL should use the r2.dev address, not the S3 API URL
        const r2Url = `${process.env.R2_PUBLIC_URL}/${filename}`;
        // If R2_PUBLIC_URL is 'https://pub-055f53ce13db4571bdeacb9e6ea6ba9a.r2.dev'
        // then the file will be accessible at:
        // https://pub-055f53ce13db4571bdeacb9e6ea6ba9a.r2.dev/filename

        console.log('Generated R2 Public URL:', r2Url);

        return r2Url;
    } catch (error) {
        console.error('Error in uploadToR2:', error);
        throw new Error(`Failed to upload to R2: ${error.message}`);
    }
}


// ===================== EXISTING ROUTES =====================
router.get('/', async (req, res) => {
    try {
        const videos = await Video.find().sort({ publishedAt: -1 }).limit(20);
        res.json(videos);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Failed to fetch videos' });
    }
});

router.get('/reels', async (req, res) => {
    try {
        const reels = await Reel.find().sort({ scrapedAt: -1 }).limit(20);
        res.json(reels);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Failed to fetch reels' });
    }
});

// ===================== NEW: UPLOAD REEL ROUTE =====================
router.post('/reels/upload', async (req, res) => {
    try {
        const { reelUrl, caption, sourceId } = req.body;
        console.log(`Received upload request: ${JSON.stringify({ reelUrl, caption, sourceId })}`);

        if (!reelUrl || !caption || !sourceId) {
            return res.status(400).json({ message: 'Missing required fields.' });
        }

        // 1. Get direct video URL from Instagram
        console.log('Starting Instagram video extraction...');
        const videoUrl = await getInstagramVideoUrl(reelUrl);
        console.log(`Extracted video URL: ${videoUrl}`);

        // 2. Upload to R2
        const filename = `reel-${Date.now()}.mp4`;
        const r2Url = await uploadToR2(videoUrl, filename);

        // 3. Get embedding
        const embedInput = `${caption}\n\n${reelUrl}`;
        const embedding = await getDeepSeekEmbedding(embedInput);

        // 4. Save in MongoDB
        const newReel = new Reel({
            videoUrl: r2Url,
            caption,
            source: sourceId,
            reelId: filename,
            scrapedAt: new Date(),
            updatedAt: new Date(),
            embedding
        });
        await newReel.save();

        res.json({ message: 'Reel uploaded and saved!', reel: newReel });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Upload failed', error: err.message });
    }
});

// ============= Instagram refresh route remains unchanged =============
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
