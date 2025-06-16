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

const puppeteer = require('puppeteer');

async function getInstagramVideoUrl(reelUrl) {
    let browser;
    try {
        browser = await puppeteer.launch({ headless: 'new' });
        const page = await browser.newPage();

        // Set user agent to mimic a real browser
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');

        await page.goto(reelUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

        // 1. Try to auto-accept the cookie banner
        try {
            await page.waitForSelector('button._a9--', { timeout: 4000 });
            await page.click('button._a9--');
            console.log('Clicked Allow all cookies');
            await page.waitForTimeout(500); // brief pause
        } catch {
            console.log('No cookie banner detected');
        }

        // 2. Try to auto-close the login modal (if present)
        try {
            // Instagram sometimes uses a [aria-label="Close"] button or SVG
            await page.waitForSelector('svg[aria-label="Close"], button[aria-label="Close"]', { timeout: 4000 });
            await page.click('svg[aria-label="Close"], button[aria-label="Close"]');
            console.log('Closed login modal');
            await page.waitForTimeout(500);
        } catch {
            console.log('No login modal detected');
        }

        let videoUrl = null;

        // Method 1: Try extracting from og:video meta tag
        try {
            await page.waitForSelector('meta[property="og:video"]', { timeout: 5000 });
            videoUrl = await page.$eval('meta[property="og:video"]', el => el.content);
            if (videoUrl && videoUrl.startsWith('https://')) {
                console.log('Extracted video URL from og:video:', videoUrl);
                return videoUrl;
            }
        } catch (e) {
            console.log('Method 1 failed: og:video not found');
        }

        // Method 2: Try getting video element source
        if (!videoUrl) {
            try {
                await page.waitForSelector('video', { timeout: 7000 });
                videoUrl = await page.$eval('video', video => video.src);
                // Sometimes this will be a blob, so only use if HTTPS
                if (videoUrl && videoUrl.startsWith('https://')) {
                    console.log('Extracted video URL from video element:', videoUrl);
                    return videoUrl;
                } else {
                    console.log('Video src is a blob or invalid, skipping');
                }
            } catch (e) {
                console.log('Method 2 failed: video element not found');
            }
        }

        // Method 3: Search for JSON data in script tags
        if (!videoUrl) {
            try {
                const scriptContent = await page.$$eval('script', scripts =>
                    scripts.map(script => script.innerHTML).join('\n')
                );

                // First pattern: Look for video_url in standard JSON structure
                const jsonMatch = scriptContent.match(/"video_url":"(https:[^"]+\.mp4[^"]*)"/);
                if (jsonMatch && jsonMatch[1]) {
                    videoUrl = jsonMatch[1].replace(/\\u0026/g, '&');
                    console.log('Extracted video_url from JSON:', videoUrl);
                    return videoUrl;
                }

                // Second pattern: Look for video resources in GraphQL data
                if (!videoUrl) {
                    const graphqlMatch = scriptContent.match(/"video_versions":\s*\[\s*\{[^\}]*"url":"(https:[^"]+\.mp4[^"]*)"/);
                    if (graphqlMatch && graphqlMatch[1]) {
                        videoUrl = graphqlMatch[1].replace(/\\u0026/g, '&');
                        console.log('Extracted video_versions url from JSON:', videoUrl);
                        return videoUrl;
                    }
                }
            } catch (e) {
                console.log('Method 3 failed: JSON extraction error');
            }
        }

        // Final validation
        if (!videoUrl || !videoUrl.startsWith('https://')) {
            throw new Error('Unable to extract video URL. Possible reasons:\n' +
                '- Reel is private or removed\n' +
                '- Instagram changed their page structure\n' +
                '- Slow network connection (try increasing timeout)');
        }

        return videoUrl;
    } finally {
        if (browser) await browser.close();
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
