// scraper/youtubeShortsScraper.js
const axios = require('axios');
const https = require('https');
const { https } = require('follow-redirects');
const { youtube } = require('btch-downloader');
const Reel = require('../models/Reel');
const { getDeepSeekEmbedding } = require('../utils/deepseek');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const {
    AWS_S3_REGION,
    AWS_S3_BUCKET,
    AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY,
    AWS_S3_PUBLIC_URL,
    YOUTUBE_API_KEY
} = process.env;

// AWS S3 client
const s3 = new S3Client({
    region: process.env.AWS_S3_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

async function uploadToS3(videoUrl, filename) {
    return new Promise((resolve, reject) => {
        https.get(videoUrl, {
            headers: {
                'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
                'Accept': '*/*',
                'Accept-Language': 'en-US,en;q=0.9',
                'Referer': 'https://www.youtube.com/',
            },
            maxRedirects: 5,
        }, async (res) => {
            if (res.statusCode !== 200) {
                return reject(new Error(`Download failed: Status code ${res.statusCode}`));
            }

            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', async () => {
                const buffer = Buffer.concat(chunks);
                const command = new PutObjectCommand({
                    Bucket: process.env.AWS_S3_BUCKET,
                    Key: filename,
                    Body: buffer,
                    ContentType: 'video/mp4',
                    ACL: 'public-read',
                });

                try {
                    await s3.send(command);
                    const url = `https://${process.env.AWS_S3_BUCKET}.s3.${process.env.AWS_S3_REGION}.amazonaws.com/${filename}`;
                    resolve(url);
                } catch (uploadErr) {
                    reject(uploadErr);
                }
            });
        }).on('error', reject);
    });
}
async function scrapeYouTubeShortsForSource(source) {
    const channelId = source.youtubeChannelId;
    if (!channelId) return [];

    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelId}&type=video&videoDuration=short&q=%23Shorts&maxResults=5&key=${YOUTUBE_API_KEY}`;
    const { data } = await axios.get(url);
    const upsertedReels = [];

    for (const item of data.items) {
        const videoId = item.id.videoId;
        const caption = item.snippet.title;
        const publishedAt = item.snippet.publishedAt;

        const youtubeUrl = `https://youtube.com/watch?v=${videoId}`;

        try {
            const result = await youtube(youtubeUrl);

            const rawUrl =
                (Array.isArray(result) && result[0]?.url) ||
                (typeof result === 'object' && result.mp4);

            if (!rawUrl || !rawUrl.startsWith('http')) {
                console.warn(`❌ No video URL found for ${youtubeUrl}`);
                continue;
            }

            const exists = await Reel.findOne({ videoUrl: rawUrl });
            if (exists) {
                console.log(`⚠️ Skipping ${videoId} – duplicate videoUrl`);
                continue;
            }

            const filename = `gulfio-${Date.now()}-${videoId}.mp4`;
            const finalUrl = await uploadToS3(rawUrl, filename);

            const embedding = await getDeepSeekEmbedding(caption);

            const reel = await Reel.create({
                source: source._id,
                reelId: videoId,
                videoUrl: finalUrl,
                caption,
                publishedAt,
                scrapedAt: new Date(),
                embedding
            });

            upsertedReels.push(reel);
            console.log(`✅ Inserted: ${videoId} – ${caption.substring(0, 50)}...`);
        } catch (err) {
            console.error(`❌ Failed for ${youtubeUrl}:`, err.message);
        }
    }

    return upsertedReels;
}

module.exports = { scrapeYouTubeShortsForSource };
