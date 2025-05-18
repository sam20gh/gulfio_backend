// scrape/instagramReels.js
const axios = require('axios');
const Reel = require('../models/Reel');

/**
 * Attempts to fetch Reels via Instagram's private web_profile_info API,
 * falling back to parsing the public HTML __NEXT_DATA__ payload if needed.
 */
async function fetchReels(username) {
    // 1) Try private API
    try {
        const apiUrl = `https://i.instagram.com/api/v1/users/web_profile_info/?username=${username}`;
        const { data } = await axios.get(apiUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0',
                'x-ig-app-id': '936619743392459'
            }
        });
        const edges = data?.data?.user?.edge_owner_to_timeline_media?.edges;
        if (edges?.length) {
            return edges
                .filter(e => e.node?.__typename === 'GraphVideo')
                .map(e => ({ reelId: e.node.id, videoUrl: e.node.video_url }));
        }
        console.warn(`API returned no reels for ${username}, falling back to HTML scrape`);
    } catch (apiErr) {
        console.warn(`Private API failed for ${username}: ${apiErr.message}`);
    }

    // 2) Fallback: scrape __NEXT_DATA__ from public HTML
    const profileUrl = `https://www.instagram.com/${username}/`;
    const resp = await axios.get(profileUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const html = resp.data;
    const m = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) {
        throw new Error('Could not extract __NEXT_DATA__ payload');
    }
    let payload;
    try {
        payload = JSON.parse(m[1]);
    } catch (parseErr) {
        throw new Error('Failed to parse __NEXT_DATA__ JSON');
    }
    const edges = payload.props?.pageProps?.graphql?.user?.edge_owner_to_timeline_media?.edges;
    if (!edges?.length) {
        throw new Error('No reel edges found in HTML payload');
    }
    return edges
        .filter(e => e.node?.__typename === 'GraphVideo')
        .map(e => ({ reelId: e.node.id, videoUrl: e.node.video_url }));
}

/**
 * Scrapes reels for a given source and upserts them to MongoDB.
 */
async function scrapeReelsForSource(sourceId, username) {
    const scraped = await fetchReels(username);
    const results = [];
    for (const { reelId, videoUrl } of scraped) {
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
