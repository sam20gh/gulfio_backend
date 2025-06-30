const puppeteer = require('puppeteer');
const Reel = require('../models/Reel');
const { igdl } = require('btch-downloader');
const axios = require('axios');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const {
    R2_ENDPOINT,
    R2_ACCESS_KEY,
    R2_SECRET_KEY,
    R2_PUBLIC_URL,
    R2_BUCKET
} = process.env;

const s3 = new S3Client({
    region: 'auto',
    endpoint: R2_ENDPOINT,
    credentials: {
        accessKeyId: R2_ACCESS_KEY,
        secretAccessKey: R2_SECRET_KEY,
    }
});

async function getInstagramVideoUrl(reelUrl) {
    try {
        const result = await igdl(reelUrl);
        if (Array.isArray(result) && result.length > 0 && result[0].url?.startsWith('http')) {
            return result[0].url;
        }
        throw new Error('No valid MP4 URL found in btch-downloader result');
    } catch (err) {
        console.error('btch-downloader igdl error:', err);
        throw new Error('Failed to extract video URL using btch-downloader');
    }
}

async function uploadToR2(videoUrl, filename) {
    try {
        const response = await axios.get(videoUrl, { responseType: 'arraybuffer' });
        const buffer = Buffer.from(response.data);
        const command = new PutObjectCommand({
            Bucket: R2_BUCKET,
            Key: filename,
            Body: buffer,
            ContentType: 'video/mp4'
        });
        await s3.send(command);
        return `${R2_PUBLIC_URL}/${filename}`;
    } catch (error) {
        console.error('Error in uploadToR2:', error);
        throw new Error(`Failed to upload to R2: ${error.message}`);
    }
}

async function scrapeReelsForSource(sourceId, username) {
    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const page = await browser.newPage();
    try {
        console.log(`🚀 Navigating to https://www.instagram.com/${username}/reels`);
        await page.goto(`https://www.instagram.com/${username}/reels`, {
            waitUntil: 'networkidle2',
            timeout: 60000,
        });

        await page.waitForSelector('main', { timeout: 10000 });

        // Scroll to load more reels
        console.log('📜 Scrolling to load more reels...');
        for (let i = 0; i < 3; i++) {
            await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
            await new Promise(resolve => setTimeout(resolve, 2000));
        }

        // Extract reel links by clicking on _aajz elements
        console.log('🔍 Extracting reel links from _aajz elements...');
        const reelData = await page.evaluate(() => {
            const reelElements = document.querySelectorAll('._aajz');
            const reels = [];

            reelElements.forEach(element => {
                // Find the parent link element
                const linkElement = element.closest('a');
                if (linkElement && linkElement.href && linkElement.href.includes('/reel/')) {
                    // Try to extract caption from nearby elements
                    let caption = '';

                    // Look for caption in various possible locations
                    const captionSelectors = [
                        'img[alt]', // Alt text often contains caption
                        '[aria-label]', // Aria labels might contain caption
                        'span', // Generic span elements
                    ];

                    for (const selector of captionSelectors) {
                        const captionElement = element.querySelector(selector) ||
                            linkElement.querySelector(selector);
                        if (captionElement) {
                            const text = captionElement.alt ||
                                captionElement.getAttribute('aria-label') ||
                                captionElement.innerText;
                            if (text && text.trim().length > 5) {
                                caption = text.trim();
                                break;
                            }
                        }
                    }

                    reels.push({
                        url: linkElement.href,
                        caption: caption
                    });
                }
            });

            return reels;
        });

        console.log(`🎯 Found ${reelData.length} reel links`);
        const inserted = [];

        for (const reelInfo of reelData) {
            const reelId = reelInfo.url.split('/').filter(Boolean).pop().split('?')[0];
            const existingById = await Reel.findOne({ reelId });
            if (existingById) {
                console.log(`⚠️ Skipping ${reelId} – already exists`);
                continue;
            }

            try {
                // Append utm_source parameter as you requested
                const safeLink = `${reelInfo.url.split('?')[0]}?utm_source=ig_web_copy_link`;
                console.log(`📥 Processing reel: ${safeLink}`);

                const rawUrl = await getInstagramVideoUrl(safeLink);

                const existingByUrl = await Reel.findOne({ videoUrl: rawUrl });
                if (existingByUrl) {
                    console.log(`⚠️ Skipping ${reelId} – duplicate videoUrl`);
                    continue;
                }

                // If no caption was found from the listing page, try to get it from the individual reel page
                let finalCaption = reelInfo.caption;
                if (!finalCaption || finalCaption.length < 10) {
                    console.log(`🔍 Fetching detailed caption for ${reelId}`);
                    try {
                        await page.goto(reelInfo.url, { waitUntil: 'networkidle2', timeout: 30000 });
                        await new Promise(resolve => setTimeout(resolve, 2000));

                        finalCaption = await page.evaluate(() => {
                            const spanTags = document.querySelectorAll('main article span');
                            for (let span of spanTags) {
                                const text = span.innerText?.trim();
                                if (text && text.length > 5) return text;
                            }
                            return '';
                        });
                    } catch (captionError) {
                        console.warn(`⚠️ Could not fetch detailed caption for ${reelId}: ${captionError.message}`);
                    }
                }

                const filename = `gulfio-${Date.now()}-${reelId}.mp4`;
                const finalUrl = await uploadToR2(rawUrl, filename);

                const reel = await Reel.create({
                    source: sourceId,
                    reelId,
                    videoUrl: finalUrl,
                    caption: finalCaption,
                    scrapedAt: new Date(),
                });

                inserted.push(reel);
                console.log(`✅ Inserted: ${reelId} with caption: ${finalCaption.substring(0, 50)}...`);

                // Add small delay between processing reels to avoid rate limiting
                await new Promise(resolve => setTimeout(resolve, 1000));

            } catch (err) {
                console.warn(`⚠️ Skipping ${reelInfo.url} due to error: ${err.message}`);
            }
        }

        console.log(`✅ Successfully processed ${inserted.length} reels`);
        return inserted;
    } catch (err) {
        console.error('❌ Puppeteer scraping failed:', err.message);
        return [];
    } finally {
        await browser.close();
    }
}

module.exports = { scrapeReelsForSource };