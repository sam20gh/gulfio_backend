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
        await page.goto(`https://www.instagram.com/${username}/reels`, {
            waitUntil: 'networkidle2',
            timeout: 60000,
        });

        await page.waitForSelector('main', { timeout: 10000 });

        for (let i = 0; i < 3; i++) {
            await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
            await new Promise(resolve => setTimeout(resolve, 2000));
        }

        const reelLinks = await page.$$eval('._aajz', nodes =>
            nodes.map(node => node.closest('a')?.href).filter(href => href?.includes('/reel/'))
        );

        console.log(`🎯 Found ${reelLinks.length} reel links`);
        const inserted = [];

        for (const link of reelLinks) {
            const reelId = link.split('/').filter(Boolean).pop();
            const existingById = await Reel.findOne({ reelId });
            if (existingById) continue;

            try {
                const safeLink = `${link}?utm_source=ig_web_copy_link`;
                const rawUrl = await getInstagramVideoUrl(safeLink);

                const existingByUrl = await Reel.findOne({ videoUrl: rawUrl });
                if (existingByUrl) {
                    console.log(`⚠️ Skipping ${reelId} – duplicate videoUrl`);
                    continue;
                }

                await page.goto(link, { waitUntil: 'networkidle2', timeout: 30000 });
                await new Promise(resolve => setTimeout(resolve, 2000));

                // Extract caption
                const caption = await page.evaluate(() => {
                    const spanTags = document.querySelectorAll('main article span');
                    for (let span of spanTags) {
                        const text = span.innerText?.trim();
                        if (text && text.length > 5) return text;
                    }
                    return '';
                });

                const filename = `gulfio-${Date.now()}.mp4`;
                const finalUrl = await uploadToR2(rawUrl, filename);

                const reel = await Reel.create({
                    source: sourceId,
                    reelId,
                    videoUrl: finalUrl,
                    caption, // ✅ caption field as per your schema
                    scrapedAt: new Date(),
                });

                inserted.push(reel);
                console.log(`✅ Inserted: ${reelId}`);
            } catch (err) {
                console.warn(`⚠️ Skipping ${link} due to error: ${err.message}`);
            }
        }

        console.log(`✅ Upserted ${inserted.length} reels`);
        return inserted;
    } catch (err) {
        console.error('❌ Puppeteer scraping failed:', err.message);
        return [];
    } finally {
        await browser.close();
    }
}

module.exports = { scrapeReelsForSource };
