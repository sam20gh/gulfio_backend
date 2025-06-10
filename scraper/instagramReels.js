const axios = require('axios');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');
const Reel = require('../models/Reel'); // Adjust if path differs

async function fetchReelsFromApi(username) {
    try {
        const url = `https://i.instagram.com/api/v1/users/web_profile_info/?username=${username}`;
        const headers = {
            'User-Agent': 'Mozilla/5.0',
            'x-ig-app-id': '936619743392459',
        };

        const response = await axios.get(url, { headers });
        const edges = response?.data?.data?.user?.edge_owner_to_timeline_media?.edges || [];

        return edges
            .filter(edge => edge.node.__typename === 'GraphVideo')
            .map(edge => ({
                reelId: edge.node.id,
                videoUrl: edge.node.video_url,
            }))
            .filter(r => !!r.videoUrl);
    } catch (err) {
        console.warn('⚠️ API fetch failed:', err.message);
        return [];
    }
}

async function fetchReelsFromSharedData(username) {
    try {
        const html = await axios.get(`https://www.instagram.com/${username}/reels/`);
        const $ = cheerio.load(html.data);
        const sharedData = html.data.match(/<script type="text\/javascript">window\._sharedData = (.*?);<\/script>/s);
        if (!sharedData || !sharedData[1]) throw new Error('Could not extract sharedData payload');

        const json = JSON.parse(sharedData[1]);
        const edges = json?.entry_data?.ProfilePage?.[0]?.graphql?.user?.edge_owner_to_timeline_media?.edges;

        if (!edges) throw new Error('No edges found in sharedData');

        return edges
            .filter(edge => edge.node.__typename === 'GraphVideo')
            .map(edge => ({
                reelId: edge.node.id,
                videoUrl: edge.node.video_url,
            }))
            .filter(r => !!r.videoUrl);
    } catch (err) {
        console.warn('⚠️ SharedData fallback failed:', err.message);
        return [];
    }
}

const fs = require('fs');
const path = require('path');

async function fetchReelsViaPuppeteer(username) {
    try {
        const browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        });

        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 900 });
        await page.goto(`https://www.instagram.com/${username}/reels/`, { waitUntil: 'networkidle2' });

        // Wait for reel tiles
        await page.waitForSelector('._aajy', { timeout: 10000 });

        const reelSelectors = await page.$$eval('._aajy', nodes =>
            nodes.map((_, i) => `._aajy:nth-of-type(${i + 1})`)
        );

        const results = [];

        for (let i = 0; i < Math.min(5, reelSelectors.length); i++) {
            const selector = reelSelectors[i];

            // Click reel item
            await page.click(selector);
            await page.waitForTimeout(2000); // let modal load

            // Wait for <video> tag in modal
            try {
                await page.waitForSelector('video[src]', { timeout: 7000 });

                const videoUrl = await page.$eval('video[src]', vid => vid.src);

                if (videoUrl) {
                    results.push({
                        reelId: `modal_${Date.now()}_${i}`,
                        videoUrl,
                    });
                }
            } catch (e) {
                console.warn(`❌ Could not find video for ${selector}`);
            }

            // Press ESC to close modal
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
    const sources = [
        await fetchReelsFromApi(username),
        await fetchReelsFromSharedData(username),
    ];

    let allReels = sources.flat();

    if (!allReels.length) {
        console.log('📦 No reels from API or HTML — using Puppeteer...');
        const puppeteerReels = await fetchReelsViaPuppeteer(username);
        allReels = puppeteerReels;
    }

    for (const reel of allReels) {
        await Reel.findOneAndUpdate(
            { reelId: reel.reelId },
            {
                source: sourceId,
                reelId: reel.reelId,
                videoUrl: reel.videoUrl,
                scrapedAt: new Date(),
            },
            { upsert: true }
        );
    }

    return allReels;
}

module.exports = { scrapeReelsForSource };
