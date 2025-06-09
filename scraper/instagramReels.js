const axios = require('axios');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');
const Reel = require('../models/Reel'); // Adjust path if needed

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
        console.warn('⚠️ API fetch failed, falling back to sharedData:', err.message);
        return [];
    }
}

async function fetchReelsFromSharedData(username) {
    try {
        const html = await axios.get(`https://www.instagram.com/${username}/reels/`);
        const $ = cheerio.load(html.data);
        const scriptTag = $('script[type="application/ld+json"]').html() || '';
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

async function fetchReelsViaPuppeteer(username) {
    try {
        const browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        });

        const page = await browser.newPage();
        await page.goto(`https://www.instagram.com/${username}/reels/`, { waitUntil: 'networkidle2' });

        const reels = await page.evaluate(() => {
            const vids = [];
            document.querySelectorAll('video').forEach(vid => {
                if (vid.src) {
                    vids.push({ reelId: Math.random().toString(36).substring(2, 12), videoUrl: vid.src });
                }
            });
            return vids;
        });

        await browser.close();
        return reels;
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

    const allReels = sources.flat();

    if (!allReels.length) {
        console.log('🔍 No reels from API or HTML — using Puppeteer...');
        const puppeteerReels = await fetchReelsViaPuppeteer(username);
        allReels.push(...puppeteerReels);
    }

    // Save or update each reel
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
