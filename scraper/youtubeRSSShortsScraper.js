// Alternative YouTube Shorts scraper using RSS feeds (no API quota limits)
const axios = require('axios');
const { https } = require('follow-redirects');
const { youtube } = require('btch-downloader');
const xml2js = require('xml2js'); // You'll need to install this: npm install xml2js
const Reel = require('../models/Reel');
const { getDeepSeekEmbedding } = require('../utils/deepseek');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

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
    console.log(`     🔗 Source video URL: ${videoUrl}`);
    
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
            
            if (res.statusCode !== 200) {
                return reject(new Error(`Download failed: Status code ${res.statusCode}`));
            }

            const chunks = [];
            let totalBytes = 0;
            
            res.on('data', (chunk) => {
                chunks.push(chunk);
                totalBytes += chunk.length;
                if (chunks.length % 100 === 0) {
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

                try {
                    const result = await s3.send(command);
                    console.log(`     ✅ S3 upload successful`);
                    
                    const url = `https://${AWS_S3_BUCKET}.s3.${AWS_S3_REGION}.amazonaws.com/${filename}`;
                    console.log(`     🔗 Final S3 URL: ${url}`);
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

            try {
                // Check if this video is likely a short by trying to extract it
                const youtubeUrl = `https://youtube.com/watch?v=${videoId}`;
                console.log(`   🔗 YouTube URL: ${youtubeUrl}`);
                
                console.log(`   ⬇️ Attempting to extract download URL using btch-downloader...`);
                const downloadResult = await youtube(youtubeUrl);
                console.log(`   📦 btch-downloader result type:`, typeof downloadResult);
                
                const rawUrl = (typeof downloadResult === 'object' && downloadResult.mp4);
                console.log(`   🎥 Extracted raw URL: ${rawUrl ? rawUrl.substring(0, 100) + '...' : 'Not found'}`);

                if (!rawUrl || !rawUrl.startsWith('http')) {
                    console.warn(`   ❌ No valid video URL found for ${youtubeUrl}`);
                    continue;
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
                
            } catch (err) {
                console.error(`   ❌ Failed processing ${videoId}:`);
                console.error(`   ❌ Error name: ${err.name}`);
                console.error(`   ❌ Error message: ${err.message}`);
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
