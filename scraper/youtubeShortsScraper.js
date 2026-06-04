// scraper/youtubeShortsScraper.js
const axios = require('axios');
const { https } = require('follow-redirects');
const { youtube } = require('btch-downloader');
const Reel = require('../models/Reel');
const { getDeepSeekEmbedding } = require('../utils/deepseek');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const {
    AWS_S3_REGION,
    AWS_S3_BUCKET,
    AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY,
    AWS_S3_PUBLIC_URL,
    YOUTUBE_API_KEY
} = process.env;

// Validation function
function validateEnvironment() {
    const requiredVars = {
        'YOUTUBE_API_KEY': YOUTUBE_API_KEY,
        'AWS_S3_REGION': AWS_S3_REGION,
        'AWS_S3_BUCKET': AWS_S3_BUCKET,
        'AWS_ACCESS_KEY_ID': AWS_ACCESS_KEY_ID,
        'AWS_SECRET_ACCESS_KEY': AWS_SECRET_ACCESS_KEY
    };

    const missing = Object.entries(requiredVars)
        .filter(([key, value]) => !value)
        .map(([key]) => key);

    if (missing.length > 0) {
        console.error(`❌ Missing required environment variables: ${missing.join(', ')}`);
        return false;
    }

    console.log(`✅ All required environment variables are set`);
    return true;
}

// AWS S3 client
const s3 = new S3Client({
    region: AWS_S3_REGION,
    credentials: {
        accessKeyId: AWS_ACCESS_KEY_ID,
        secretAccessKey: AWS_SECRET_ACCESS_KEY,
    },
});

async function uploadToS3(videoUrl, filename) {
    console.log(`     📤 Starting S3 upload for file: ${filename}`);
    console.log(`     🔗 Source video URL: ${videoUrl}`);

    // Validate S3 configuration
    if (!AWS_S3_BUCKET || !AWS_S3_REGION || !AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY) {
        const missingVars = [];
        if (!AWS_S3_BUCKET) missingVars.push('AWS_S3_BUCKET');
        if (!AWS_S3_REGION) missingVars.push('AWS_S3_REGION');
        if (!AWS_ACCESS_KEY_ID) missingVars.push('AWS_ACCESS_KEY_ID');
        if (!AWS_SECRET_ACCESS_KEY) missingVars.push('AWS_SECRET_ACCESS_KEY');
        throw new Error(`Missing required S3 environment variables: ${missingVars.join(', ')}`);
    }

    return new Promise((resolve, reject) => {
        console.log(`     ⬇️ Downloading video from: ${videoUrl}`);

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
            console.log(`     📊 Download response status: ${res.statusCode}`);
            console.log(`     📋 Response headers:`, res.headers);

            if (res.statusCode !== 200) {
                return reject(new Error(`Download failed: Status code ${res.statusCode}`));
            }

            const chunks = [];
            let totalBytes = 0;

            res.on('data', (chunk) => {
                chunks.push(chunk);
                totalBytes += chunk.length;
                if (chunks.length % 100 === 0) { // Log every 100 chunks
                    console.log(`     📥 Downloaded ${totalBytes} bytes so far...`);
                }
            });

            res.on('end', async () => {
                console.log(`     ✅ Download completed. Total size: ${totalBytes} bytes`);

                const buffer = Buffer.concat(chunks);
                console.log(`     📦 Buffer created, size: ${buffer.length} bytes`);

                const command = new PutObjectCommand({
                    Bucket: AWS_S3_BUCKET,
                    Key: filename,
                    Body: buffer,
                    ContentType: 'video/mp4',
                    // Removed ACL - not supported by this bucket
                });

                console.log(`     ☁️ Uploading to S3 bucket: ${AWS_S3_BUCKET}`);
                console.log(`     📁 S3 key: ${filename}`);

                try {
                    const result = await s3.send(command);
                    console.log(`     ✅ S3 upload successful:`, result);

                    // Bucket is private — return a 7-day SIGNED URL (a plain
                    // virtual-hosted URL returns 403). The object key is the
                    // filename; callers persist it as originalKey for refresh.
                    const url = await getSignedUrl(
                        s3,
                        new GetObjectCommand({ Bucket: AWS_S3_BUCKET, Key: filename }),
                        { expiresIn: 60 * 60 * 24 * 7 }
                    );
                    console.log(`     🔗 Signed S3 URL generated`);
                    resolve(url);
                } catch (uploadErr) {
                    console.error(`     ❌ S3 upload failed:`, uploadErr);
                    reject(uploadErr);
                }
            });
        }).on('error', (downloadErr) => {
            console.error(`     ❌ Download failed:`, downloadErr);
            reject(downloadErr);
        });
    });
}
async function scrapeYouTubeShortsForSource(source) {
    console.log(`🎬 Starting YouTube Shorts scraping for source: ${source.name}`);

    // Validate environment first
    if (!validateEnvironment()) {
        console.error(`❌ Environment validation failed for source: ${source.name}`);
        return [];
    }

    const channelId = source.youtubeChannelId;
    if (!channelId) {
        console.log(`❌ No YouTube channel ID found for source: ${source.name}`);
        return [];
    }

    console.log(`📺 Channel ID: ${channelId}`);

    if (!YOUTUBE_API_KEY) {
        console.error(`❌ YOUTUBE_API_KEY is not set in environment variables`);
        return [];
    }

    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelId}&type=video&videoDuration=short&q=%23Shorts&maxResults=5&key=${YOUTUBE_API_KEY}`;
    console.log(`🔍 YouTube API URL: ${url.replace(YOUTUBE_API_KEY, 'API_KEY_HIDDEN')}`); try {
        const { data } = await axios.get(url);
        console.log(`📊 YouTube API Response:`, {
            totalResults: data.pageInfo?.totalResults || 0,
            resultsPerPage: data.pageInfo?.resultsPerPage || 0,
            itemsFound: data.items?.length || 0
        });

        if (!data.items || data.items.length === 0) {
            console.log(`⚠️ No YouTube Shorts found for channel: ${channelId}`);
            return [];
        }

        console.log(`📋 Found ${data.items.length} YouTube Shorts to process`);
        const upsertedReels = [];

        for (const item of data.items) {
            const videoId = item.id.videoId;
            const caption = item.snippet.title;
            const publishedAt = item.snippet.publishedAt;

            console.log(`\n🎯 Processing video ${upsertedReels.length + 1}/${data.items.length}`);
            console.log(`   📹 Video ID: ${videoId}`);
            console.log(`   📝 Title: ${caption}`);
            console.log(`   📅 Published: ${publishedAt}`);

            const youtubeUrl = `https://youtube.com/watch?v=${videoId}`;
            console.log(`   🔗 YouTube URL: ${youtubeUrl}`);

            try {
                console.log(`   ⬇️ Attempting to extract download URL using btch-downloader...`);
                const result = await youtube(youtubeUrl);
                console.log(`   📦 btch-downloader result type:`, typeof result);
                console.log(`   📊 btch-downloader result:`, JSON.stringify(result, null, 2));

                const rawUrl =
                    (Array.isArray(result) && result[0]?.url) ||
                    (typeof result === 'object' && result.mp4);

                console.log(`   🎥 Extracted raw URL: ${rawUrl}`);

                if (!rawUrl || !rawUrl.startsWith('http')) {
                    console.warn(`   ❌ No valid video URL found for ${youtubeUrl}`);
                    console.warn(`   ❌ Raw URL value:`, rawUrl);
                    continue;
                }

                console.log(`   🔍 Checking for duplicate videoUrl in database...`);
                const exists = await Reel.findOne({ videoUrl: rawUrl });
                if (exists) {
                    console.log(`   ⚠️ Skipping ${videoId} – duplicate videoUrl found`);
                    continue;
                }

                console.log(`   ☁️ Uploading to S3...`);
                const filename = `gulfio-${Date.now()}-${videoId}.mp4`;
                console.log(`   📁 S3 filename: ${filename}`);

                const finalUrl = await uploadToS3(rawUrl, filename);
                console.log(`   ✅ S3 upload successful: ${finalUrl}`);

                console.log(`   🤖 Generating embedding for caption...`);
                const embedding = await getDeepSeekEmbedding(caption);
                console.log(`   ✅ Embedding generated, length: ${embedding?.length || 'undefined'}`);

                console.log(`   💾 Saving to database...`);
                const reel = await Reel.create({
                    source: source._id,
                    reelId: videoId,
                    videoUrl: finalUrl,
                    originalKey: filename,
                    caption,
                    publishedAt,
                    scrapedAt: new Date(),
                    embedding
                });

                upsertedReels.push(reel);
                console.log(`   ✅ Successfully processed: ${videoId} – ${caption.substring(0, 50)}...`);

            } catch (err) {
                console.error(`   ❌ Failed processing ${youtubeUrl}:`);
                console.error(`   ❌ Error name: ${err.name}`);
                console.error(`   ❌ Error message: ${err.message}`);
                console.error(`   ❌ Error stack: ${err.stack}`);
            }
        }

        console.log(`\n🎉 YouTube Shorts scraping completed for ${source.name}`);
        console.log(`📊 Successfully processed: ${upsertedReels.length}/${data.items.length} videos`);
        return upsertedReels;

    } catch (err) {
        console.error(`❌ Fatal error in YouTube Shorts scraping for ${source.name}:`);
        console.error(`❌ Error name: ${err.name}`);
        console.error(`❌ Error message: ${err.message}`);

        // Handle specific YouTube API errors
        if (err.response) {
            console.error(`❌ HTTP Status: ${err.response.status}`);
            console.error(`❌ HTTP Status Text: ${err.response.statusText}`);
            console.error(`❌ Response Data:`, JSON.stringify(err.response.data, null, 2));

            if (err.response.status === 403) {
                console.error(`❌ YouTube API quota exceeded! Consider:`);
                console.error(`   1. Wait for quota reset (daily limit)`);
                console.error(`   2. Request quota increase from Google`);
                console.error(`   3. Use multiple API keys with rotation`);
                console.error(`   4. Implement caching to reduce API calls`);
            } else if (err.response.status === 400) {
                console.error(`❌ Bad request - check channel ID: ${source.youtubeChannelId}`);
            } else if (err.response.status === 404) {
                console.error(`❌ Channel not found: ${source.youtubeChannelId}`);
            }
        } else {
            console.error(`❌ Error stack: ${err.stack}`);
        }
        return [];
    }
}

module.exports = { scrapeYouTubeShortsForSource };
