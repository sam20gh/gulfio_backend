const puppeteer = require('puppeteer');
const Reel = require('../models/Reel');

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

        // Wait for the container to load
        await page.waitForSelector('main', { timeout: 10000 });

        // Scroll a few times to trigger lazy loading
        for (let i = 0; i < 3; i++) {
            await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
            await page.waitForTimeout(2000);
        }

        // Now try to find all ._aajy elements with parent anchor tags
        const reelLinks = await page.$$eval('._aajy', nodes =>
            nodes
                .map(node => {
                    const anchor = node.closest('a');
                    return anchor ? anchor.href : null;
                })
                .filter(Boolean)
        );

        console.log(`🎯 Found ${reelLinks.length} reel links`);

        const inserted = [];

        for (const link of reelLinks) {
            await page.goto(link, { waitUntil: 'networkidle2', timeout: 30000 });

            await page.waitForTimeout(1000);

            const videoUrl = await page.evaluate(() => {
                const video = document.querySelector('video');
                return video ? video.src : null;
            });

            if (!videoUrl) continue;

            const reelId = link.split('/').filter(Boolean).pop();
            const existing = await Reel.findOne({ reelId });

            if (!existing) {
                const reel = await Reel.create({
                    source: sourceId,
                    reelId,
                    videoUrl,
                    scrapedAt: new Date(),
                });
                inserted.push(reel);
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