// Alternative YouTube Shorts scraper using RSS feeds (no API quota limits)
const axios = require('axios');
const { https } = require('follow-redirects');
const { youtube } = require('btch-downloader');
const xml2js = require('xml2js'); // You'll need to install this: npm install xml2js
const Reel = require('../models/Reel');
const { getDeepSeekEmbedding } = require('../utils/deepseek');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const {
    AWS_S3_REGION,
    AWS_S3_BUCKET,
    AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY,
} = process.env;

// AWS S3 client
const s3 = new S3Client({
    region: AWS_S3_REGION,
    credentials: {
        accessKeyId: AWS_ACCESS_KEY_ID,
        secretAccessKey: AWS_SECRET_ACCESS_KEY,
    },
});

// Validation function
function validateEnvironment() {
    const requiredVars = {
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

async function uploadToS3(videoUrl, filename) {
    console.log(`     📤 Starting S3 upload for file: ${filename}`);
    console.log(`     🔗 Source video URL: ${videoUrl.substring(0, 100)}...`);

    return new Promise((resolve, reject) => {
        console.log(`     ⬇️ Downloading video from URL...`);

        https.get(videoUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                'Accept': 'video/webm,video/ogg,video/*;q=0.9,application/ogg;q=0.7,audio/*;q=0.6,*/*;q=0.5',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'identity',
                'Referer': 'https://www.youtube.com/',
                'Origin': 'https://www.youtube.com',
                'Sec-Fetch-Dest': 'video',
                'Sec-Fetch-Mode': 'no-cors',
                'Sec-Fetch-Site': 'cross-site',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive'
            },
            maxRedirects: 10,
            timeout: 30000, // 30 second timeout
        }, async (res) => {
            console.log(`     📊 Download response status: ${res.statusCode}`);
            console.log(`     📋 Response headers: Content-Length: ${res.headers['content-length'] || 'unknown'}, Content-Type: ${res.headers['content-type'] || 'unknown'}`);

            if (res.statusCode === 403) {
                return reject(new Error(`Download failed: Status code 403 - Video URL may be expired or geo-blocked. Try refreshing the URL.`));
            }

            if (res.statusCode === 429) {
                return reject(new Error(`Download failed: Status code 429 - Rate limited. Please try again later.`));
            }

            if (res.statusCode !== 200) {
                return reject(new Error(`Download failed: Status code ${res.statusCode} - ${res.statusMessage || 'Unknown error'}`));
            }

            const chunks = [];
            let totalBytes = 0;
            const expectedBytes = parseInt(res.headers['content-length'] || '0');

            res.on('data', (chunk) => {
                chunks.push(chunk);
                totalBytes += chunk.length;
                if (chunks.length % 200 === 0) { // Reduced logging frequency
                    const progress = expectedBytes > 0 ? `(${Math.round((totalBytes / expectedBytes) * 100)}%)` : '';
                    console.log(`     📥 Downloaded ${Math.round(totalBytes / 1024 / 1024 * 100) / 100}MB ${progress}...`);
                }
            });

            res.on('end', async () => {
                console.log(`     ✅ Download completed. Total size: ${Math.round(totalBytes / 1024 / 1024 * 100) / 100}MB`);

                if (totalBytes === 0) {
                    return reject(new Error('Download failed: Received 0 bytes'));
                }

                const buffer = Buffer.concat(chunks);
                console.log(`     📦 Buffer created, size: ${Math.round(buffer.length / 1024 / 1024 * 100) / 100}MB`);

                const command = new PutObjectCommand({
                    Bucket: AWS_S3_BUCKET,
                    Key: filename,
                    Body: buffer,
                    ContentType: 'video/mp4',
                    // Removed ACL - not supported by this bucket
                });

                console.log(`     ☁️ Uploading to S3 bucket: ${AWS_S3_BUCKET}`);

                try {
                    const result = await s3.send(command);
                    console.log(`     ✅ S3 upload successful`);

                    // Bucket is private — return a 7-day SIGNED URL (a plain
                    // virtual-hosted URL returns 403). Callers persist `filename`
                    // as originalKey so the refresh cron can re-sign it.
                    const url = await getSignedUrl(
                        s3,
                        new GetObjectCommand({ Bucket: AWS_S3_BUCKET, Key: filename }),
                        { expiresIn: 60 * 60 * 24 * 7 }
                    );
                    console.log(`     🔗 Signed S3 URL generated`);
                    resolve(url);
                } catch (uploadErr) {
                    console.error(`     ❌ S3 upload failed:`, uploadErr.message);
                    reject(uploadErr);
                }
            });

            res.on('error', (err) => {
                console.error(`     ❌ Download stream error:`, err.message);
                reject(err);
            });

        }).on('error', (downloadErr) => {
            console.error(`     ❌ Download request failed:`, downloadErr.message);
            reject(downloadErr);
        }).on('timeout', () => {
            console.error(`     ❌ Download timeout after 30 seconds`);
            reject(new Error('Download timeout'));
        });
    });
}

// Check if a video is likely a YouTube Short based on duration
async function isLikelyShort(videoId) {
    try {
        console.log(`   🕒 Checking if video ${videoId} is a short...`);
        const result = await youtube(`https://youtube.com/watch?v=${videoId}`);

        // If btch-downloader can extract it successfully, assume it's accessible
        // Note: You might want to add additional checks here based on video metadata
        return result && (result.mp4 || (Array.isArray(result) && result[0]?.url));
    } catch (error) {
        console.log(`   ⚠️ Could not verify if ${videoId} is a short: ${error.message}`);
        return false;
    }
}

async function scrapeYouTubeShortsViaRSS(source) {
    console.log(`🎬 Starting RSS-based YouTube Shorts scraping for source: ${source.name}`);

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

    // Use RSS feed instead of API
    const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
    console.log(`📡 RSS URL: ${rssUrl}`);

    try {
        const { data: xmlData } = await axios.get(rssUrl);
        console.log(`✅ RSS feed fetched successfully`);

        // Parse XML
        const parser = new xml2js.Parser();
        const result = await parser.parseStringPromise(xmlData);

        const entries = result.feed?.entry || [];
        console.log(`📋 Found ${entries.length} total videos in RSS feed`);

        if (entries.length === 0) {
            console.log(`⚠️ No videos found in RSS feed for channel: ${channelId}`);
            return [];
        }

        // Limit to recent videos (last 10) to check for shorts
        const recentEntries = entries.slice(0, 10);
        console.log(`🔍 Checking ${recentEntries.length} recent videos for shorts...`);

        const upsertedReels = [];

        for (let i = 0; i < recentEntries.length; i++) {
            const entry = recentEntries[i];
            const videoId = entry['yt:videoId']?.[0];
            const title = entry.title?.[0];
            const publishedAt = entry.published?.[0];

            if (!videoId || !title) {
                console.log(`   ⚠️ Skipping entry ${i + 1}: missing videoId or title`);
                continue;
            }

            console.log(`\n🎯 Processing video ${i + 1}/${recentEntries.length}`);
            console.log(`   📹 Video ID: ${videoId}`);
            console.log(`   📝 Title: ${title}`);
            console.log(`   📅 Published: ${publishedAt}`);

            // Add delay between videos to avoid rate limiting
            if (i > 0) {
                console.log(`   ⏱️ Waiting 3 seconds to avoid rate limiting...`);
                await new Promise(resolve => setTimeout(resolve, 3000));
            }

            try {
                // Check if this video is likely a short by trying to extract it
                const youtubeUrl = `https://youtube.com/watch?v=${videoId}`;
                console.log(`   🔗 YouTube URL: ${youtubeUrl}`);

                console.log(`   ⬇️ Attempting to extract download URL using btch-downloader...`);

                let downloadResult;
                let retryCount = 0;
                const maxRetries = 2;

                // Retry logic for URL extraction
                while (retryCount <= maxRetries) {
                    try {
                        downloadResult = await youtube(youtubeUrl);
                        break; // Success, exit retry loop
                    } catch (extractError) {
                        retryCount++;
                        console.log(`   ⚠️ Extraction attempt ${retryCount} failed: ${extractError.message}`);
                        if (retryCount <= maxRetries) {
                            console.log(`   � Retrying in 2 seconds...`);
                            await new Promise(resolve => setTimeout(resolve, 2000));
                        } else {
                            throw extractError; // Give up after max retries
                        }
                    }
                }

                console.log(`   �📦 btch-downloader result type:`, typeof downloadResult);

                const rawUrl = (typeof downloadResult === 'object' && downloadResult.mp4);
                console.log(`   🎥 Extracted raw URL: ${rawUrl ? rawUrl.substring(0, 100) + '...' : 'Not found'}`);

                if (!rawUrl || !rawUrl.startsWith('http')) {
                    console.warn(`   ❌ No valid video URL found for ${youtubeUrl}`);
                    continue;
                }

                // Check video duration from metadata (if available)
                const duration = downloadResult?.duration || downloadResult?.dur;
                if (duration) {
                    const durationSeconds = parseFloat(duration);
                    console.log(`   ⏱️ Video duration: ${Math.round(durationSeconds)}s`);

                    // Skip very long videos (likely not shorts)
                    if (durationSeconds > 60) { // 2 minutes
                        console.log(`   ⏭️ Skipping long video (${Math.round(durationSeconds)}s) - likely not a short`);
                        continue;
                    }
                }

                // Check for duplicates
                console.log(`   🔍 Checking for duplicate videoUrl in database...`);
                const exists = await Reel.findOne({ videoUrl: rawUrl });
                if (exists) {
                    console.log(`   ⚠️ Skipping ${videoId} – duplicate videoUrl found`);
                    continue;
                }

                console.log(`   ☁️ Uploading to S3...`);
                const filename = `gulfio-rss-${Date.now()}-${videoId}.mp4`;
                console.log(`   📁 S3 filename: ${filename}`);

                try {
                    const finalUrl = await uploadToS3(rawUrl, filename);
                    console.log(`   ✅ S3 upload successful: ${finalUrl}`);

                    console.log(`   🤖 Generating embedding for caption...`);
                    const embedding = await getDeepSeekEmbedding(title);
                    console.log(`   ✅ Embedding generated, length: ${embedding?.length || 'undefined'}`);

                    console.log(`   💾 Saving to database...`);
                    const reel = await Reel.create({
                        source: source._id,
                        reelId: videoId,
                        videoUrl: finalUrl,
                        originalKey: filename,
                        caption: title,
                        publishedAt: publishedAt ? new Date(publishedAt) : new Date(),
                        scrapedAt: new Date(),
                        embedding
                    });

                    upsertedReels.push(reel);
                    console.log(`   ✅ Successfully processed: ${videoId} – ${title.substring(0, 50)}...`);

                    // Limit to 5 shorts maximum to avoid overwhelming the system
                    if (upsertedReels.length >= 5) {
                        console.log(`   🛑 Reached maximum of 5 shorts, stopping...`);
                        break;
                    }

                } catch (uploadError) {
                    if (uploadError.message.includes('403')) {
                        console.log(`   ⚠️ Video URL expired or blocked (403), skipping ${videoId}`);
                        console.log(`   💡 This is normal - YouTube URLs expire after some time`);
                    } else if (uploadError.message.includes('429')) {
                        console.log(`   ⚠️ Rate limited (429), waiting before next video...`);
                        await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds
                    } else {
                        console.error(`   ❌ Upload failed: ${uploadError.message}`);
                    }
                }

            } catch (err) {
                console.error(`   ❌ Failed processing ${videoId}:`);
                console.error(`   ❌ Error name: ${err.name}`);
                console.error(`   ❌ Error message: ${err.message}`);

                if (err.message.includes('403') || err.message.includes('Forbidden')) {
                    console.log(`   💡 This video may be geo-blocked or have restricted access`);
                } else if (err.message.includes('Private video')) {
                    console.log(`   💡 This video is private and cannot be accessed`);
                } else if (err.message.includes('timeout')) {
                    console.log(`   💡 Request timed out - the video server may be slow`);
                }

                // Continue with next video instead of stopping
            }
        }

        console.log(`\n🎉 RSS-based YouTube Shorts scraping completed for ${source.name}`);
        console.log(`📊 Successfully processed: ${upsertedReels.length} shorts`);
        return upsertedReels;

    } catch (err) {
        console.error(`❌ Fatal error in RSS-based YouTube Shorts scraping for ${source.name}:`);
        console.error(`❌ Error name: ${err.name}`);
        console.error(`❌ Error message: ${err.message}`);

        if (err.response) {
            console.error(`❌ HTTP Status: ${err.response.status}`);
            console.error(`❌ HTTP Status Text: ${err.response.statusText}`);
        } else {
            console.error(`❌ Error stack: ${err.stack}`);
        }
        return [];
    }
}

module.exports = { scrapeYouTubeShortsViaRSS };
