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
    console.log(`Attempting to extract video from Instagram reel: ${reelUrl}`);

    // Launch puppeteer with additional settings to avoid detection
    const browser = await puppeteer.launch({
        headless: 'new',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-gpu',
            '--window-size=1920,1080',
        ],
        defaultViewport: { width: 1080, height: 1920 }
    });

    const page = await browser.newPage();

    // Set a realistic user agent
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.110 Safari/537.36');

    try {
        console.log('Navigating to page...');
        await page.goto(reelUrl, { waitUntil: 'networkidle2', timeout: 40000 });

        console.log('Page loaded, scrolling to ensure content appears...');
        // Scroll down a bit to trigger lazy loading
        await page.evaluate(() => {
            window.scrollBy(0, 300);
        });

        // Wait a moment after scrolling
        await page.waitForTimeout(2000);

        // Try multiple extraction methods
        console.log('Attempting extraction method 1: JSON-LD data');
        // Method 1: Try to get the video URL from JSON-LD data
        const jsonLdData = await page.evaluate(() => {
            const elements = document.querySelectorAll('script[type="application/ld+json"]');
            for (const element of elements) {
                try {
                    const data = JSON.parse(element.textContent);
                    if (data && data.contentUrl) {
                        return data.contentUrl;
                    }
                } catch (e) {
                    // Ignore parsing errors
                }
            }
            return null;
        });

        if (jsonLdData) {
            await browser.close();
            console.log('Successfully extracted video URL using JSON-LD');
            return jsonLdData;
        }

        console.log('Attempting extraction method 2: Regex pattern');
        // Method 2: Try to extract from page source using regex
        const html = await page.content();
        const videoRegex = /"video_url":"([^"]+)"/;
        const matches = html.match(videoRegex);

        if (matches && matches[1]) {
            const videoUrl = matches[1].replace(/\\u0026/g, '&').replace(/\\/g, '');
            if (videoUrl && videoUrl.startsWith('http')) {
                await browser.close();
                console.log('Successfully extracted video URL using regex');
                return videoUrl;
            }
        }

        console.log('Attempting extraction method 3: Direct video element');
        // Method 3: Try to extract directly from video element
        const videoElementUrl = await page.evaluate(() => {
            const videoElement = document.querySelector('video');
            return videoElement ? videoElement.src : null;
        });

        if (videoElementUrl) {
            await browser.close();
            console.log('Successfully extracted video URL from video element');
            return videoElementUrl;
        }

        console.log('Attempting extraction method 4: Network requests');
        // Method 4: Try to intercept network requests for mp4 files
        const videoUrls = await page.evaluate(() => {
            return performance.getEntriesByType('resource')
                .filter(resource => resource.name.includes('.mp4'))
                .map(resource => resource.name);
        });

        if (videoUrls.length > 0) {
            await browser.close();
            console.log('Successfully extracted video URL from network requests');
            return videoUrls[0];
        }

        // If we reach here, all extraction methods failed
        console.log('All extraction methods failed');
        await browser.close();
        throw new Error('Unable to extract Instagram mp4 video URL. Instagram may have changed their markup or the reel might be private.');

    } catch (error) {
        console.error('Error during Instagram video extraction:', error);
        await browser.close();
        throw new Error(`Failed to extract Instagram video: ${error.message}`);
    }
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
        // Use axios instead of fetch
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
        return `https://${R2_BUCKET}.${R2_ENDPOINT.replace('https://', '')}/${filename}`;
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
