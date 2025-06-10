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
        await page.setViewport({ width: 1200, height: 800 });

        console.log(`🌐 Visiting https://www.instagram.com/${username}/reels/`);
        await page.goto(`https://www.instagram.com/${username}/reels/`, { waitUntil: 'networkidle2' });

        // Scroll to load
        await page.evaluate(async () => {
            await new Promise(resolve => {
                let totalHeight = 0;
                const distance = 500;
                const timer = setInterval(() => {
                    window.scrollBy(0, distance);
                    totalHeight += distance;
                    if (totalHeight >= 3000) {
                        clearInterval(timer);
                        resolve();
                    }
                }, 300);
            });
        });

        await page.waitForTimeout(3000);

        // DEBUG: Screenshot
        const screenshotPath = path.join(__dirname, '../debug/instagram_reels.png');
        await page.screenshot({ path: screenshotPath });
        console.log(`📸 Screenshot saved to ${screenshotPath}`);

        // DEBUG: Count video tags
        const debug = await page.evaluate(() => {
            const allVideos = Array.from(document.querySelectorAll('video'));
            const htmlSamples = allVideos.map(v => v.outerHTML);
            return {
                count: allVideos.length,
                samples: htmlSamples.slice(0, 2),
                reels: allVideos.map(v => ({
                    reelId: Math.random().toString(36).substring(2, 12),
                    videoUrl: v.src,
                })).filter(r => r.videoUrl),
            };
        });

        console.log(`🎞 Found ${debug.count} <video> elements`);
        console.log(`🔍 Sample HTML:\n`, debug.samples.join('\n\n'));

        await browser.close();
        return debug.reels;
    } catch (err) {
        console.warn('⚠️ Puppeteer fallback failed:', err.message);
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
