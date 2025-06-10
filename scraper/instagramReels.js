const axios = require('axios');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');
const Reel = require('../models/Reel'); // Adjust path as needed

async function fetchReelsViaPuppeteer(username) {
    try {
        const browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        });

        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 900 });
        await page.goto(`https://www.instagram.com/${username}/reels/`, { waitUntil: 'networkidle2' });

        await page.waitForSelector('._aajy', { timeout: 10000 });

        const reelSelectors = await page.$$eval('._aajy', nodes =>
            nodes.map((_, i) => `._aajy:nth-of-type(${i + 1})`)
        );

        const results = [];

        for (let i = 0; i < Math.min(20, reelSelectors.length); i++) {
            const selector = reelSelectors[i];

            try {
                await page.click(selector);
                await page.waitForTimeout(2000);

                await page.waitForSelector('video[src]', { timeout: 7000 });

                const videoUrl = await page.$eval('video[src]', vid => vid.src);

                if (videoUrl && !results.find(r => r.videoUrl === videoUrl)) {
                    results.push({
                        reelId: `modal_${Date.now()}_${i}`,
                        videoUrl,
                    });
                }
            } catch (e) {
                console.warn(`⚠️ Failed to process ${selector}: ${e.message}`);
            }

            await page.keyboard.press('Escape');
            await page.waitForTimeout(1500);
        }

        await browser.close();
        return results;
    } catch (err) {
        console.error('❌ Puppeteer scraping failed:', err.message);
        return [];
    }
}

async function scrapeReelsForSource(sourceId, username) {
    const allReels = await fetchReelsViaPuppeteer(username);

    for (const reel of allReels) {
        const existing = await Reel.findOne({
            $or: [{ reelId: reel.reelId }, { videoUrl: reel.videoUrl }],
        });

        if (!existing) {
            await Reel.create({
                source: sourceId,
                reelId: reel.reelId,
                videoUrl: reel.videoUrl,
                scrapedAt: new Date(),
            });
        }
    }

    return allReels;
}

module.exports = { scrapeReelsForSource };
