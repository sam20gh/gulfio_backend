const express = require('express');
const Video = require('../models/Video');
const Reel = require('../models/Reel');
const Source = require('../models/Source');
const puppeteer = require('puppeteer');
const axios = require('axios'); // Replace fetch with axios
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getDeepSeekEmbedding } = require('../utils/deepseek');
const { igdl } = require('btch-downloader');// Adjust the path as needed
const router = express.Router();

// You should have dotenv.config() in your main entrypoint (not needed here if already loaded)
const {
    AWS_S3_REGION,
    AWS_S3_BUCKET,
    AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY,
} = process.env;
function cosineSimilarity(vec1, vec2) {
    const dotProduct = vec1.reduce((sum, val, i) => sum + val * vec2[i], 0);
    const magnitudeA = Math.sqrt(vec1.reduce((sum, val) => sum + val * val, 0));
    const magnitudeB = Math.sqrt(vec2.reduce((sum, val) => sum + val * val, 0));
    return dotProduct / (magnitudeA * magnitudeB);
}
// Helper: Get the real Instagram video URL with multiple extraction strategies


async function getInstagramVideoUrl(reelUrl) {
    try {
        const result = await igdl(reelUrl);

        // The result is usually an array of objects with a `url` key for the direct mp4
        // For example: [ { url: "https://...mp4", ... }, ... ]
        if (Array.isArray(result) && result.length > 0 && result[0].url && result[0].url.startsWith('http')) {
            return result[0].url;
        }

        throw new Error('No valid MP4 URL found in btch-downloader result');
    } catch (err) {
        console.error('btch-downloader igdl error:', err);
        throw new Error('Failed to extract video URL using btch-downloader');
    }
}
// Helper: Upload to R2
const s3 = new S3Client({
    region: AWS_S3_REGION,
    credentials: {
        accessKeyId: AWS_ACCESS_KEY_ID,
        secretAccessKey: AWS_SECRET_ACCESS_KEY,
    },
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
            Bucket: AWS_S3_BUCKET,
            Key: filename,
            Body: buffer,
            ContentType: 'video/mp4',
        });

        await s3.send(command);
        console.log(`     ✅ S3 upload successful`);
        const r2Url = `https://${AWS_S3_BUCKET}.s3.${AWS_S3_REGION}.amazonaws.com/${filename}`;
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
router.post('/related', async (req, res) => {
    const { embedding, sourceId } = req.body;
    if (!embedding || !sourceId) return res.status(400).json({ error: 'Missing embedding or sourceId' });

    const videos = await Video.find({ source: sourceId, embedding: { $exists: true, $type: 'array' } });
    let bestMatch = null;
    let bestScore = -Infinity;

    for (const video of videos) {
        const sim = cosineSimilarity(embedding, video.embedding);
        if (sim > bestScore) {
            bestScore = sim;
            bestMatch = video;
        }
    }

    if (bestMatch) return res.json(bestMatch);
    return res.status(404).json({ message: 'No related video found' });
});

router.get('/reels', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 10;
        const skip = parseInt(req.query.skip) || 0;

        const reels = await Reel.find()
            .sort({ scrapedAt: -1 })
            .skip(skip)
            .limit(limit);

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
        const filename = `gulfio-${Date.now()}.mp4`;
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
