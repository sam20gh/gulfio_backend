// scrape/instagramReels.js
const axios = require('axios');
const Reel = require('../models/Reel');

/**
 * Fetches Reels using Instagram's private web_profile_info API.
 * Falls back to a headless-browser scrape if the API fails.
 */
async function fetchReels(username) {
    const apiUrl = `https://i.instagram.com/api/v1/users/web_profile_info/?username=${username}`;
    try {
        const { data } = await axios.get(apiUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0',
                'x-ig-app-id': '936619743392459'
            }
        });
        const edges = data.data.user.edge_owner_to_timeline_media.edges;
        return edges
            .filter(e => e.node?.__typename === 'GraphVideo')
            .map(e => ({ reelId: e.node.id, videoUrl: e.node.video_url }));
    } catch (apiErr) {
        console.warn('API fetch failed, falling back to headless scrape:', apiErr.message);
    }

    // Fallback: headless scrape via Puppeteer
    const puppeteer = require('puppeteer');
    const profileUrl = `https://www.instagram.com/${username}/`;
    const browser = await puppeteer.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0');
        await page.goto(profileUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        // Wait for reels section
        await page.waitForSelector('article', { timeout: 10000 });
        // Evaluate to pull JSON from __NEXT_DATA__ or window._sharedData
        const reels = await page.evaluate(() => {
            let payload;
            // Try __NEXT_DATA__
            const script = document.querySelector('script[id="__NEXT_DATA__"]');
            if (script) payload = JSON.parse(script.textContent);
            // Fallback to sharedData
            if (!payload && window._sharedData) payload = window._sharedData;
            const edges = payload?.props?.pageProps?.graphql?.user?.edge_owner_to_timeline_media?.edges
                || payload?.entry_data?.ProfilePage[0]?.graphql?.user?.edge_owner_to_timeline_media?.edges;
            if (!edges) return [];
            return edges
                .filter(e => e.node?.__typename === 'GraphVideo')
                .map(e => ({ reelId: e.node.id, videoUrl: e.node.video_url }));
        });
        return reels;
    } finally {
        await browser.close();
    }
}

/**
 * Upserts scraped reels into the database.
 */
async function scrapeReelsForSource(sourceId, username) {
    const reels = await fetchReels(username);
    const results = [];
    for (const { reelId, videoUrl } of reels) {
        const reel = await Reel.findOneAndUpdate(
            { source: sourceId, reelId },
            { videoUrl, scrapedAt: new Date() },
            { upsert: true, new: true }
        );
        results.push(reel);
    }
    return results;
}

module.exports = { scrapeReelsForSource };
