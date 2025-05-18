// scrape/instagramReels.js
const axios = require('axios');
const Reel = require('../models/Reel');

/**
 * Fetches Reels by parsing the __NEXT_DATA__ JSON payload in the profile HTML.
 * Falls back to the public JSON endpoint if needed.
 */
async function fetchReels(username) {
    const profileUrl = `https://www.instagram.com/${username}/`;
    const resp = await axios.get(profileUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const html = resp.data;

    // Try to extract __NEXT_DATA__ payload
    let m = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    let payload;

    if (m) {
        try {
            payload = JSON.parse(m[1]);
        } catch (err) {
            throw new Error('Failed to parse __NEXT_DATA__ JSON');
        }
    } else {
        // Fallback to the public JSON endpoint
        const jsonUrl = `https://www.instagram.com/${username}/?__a=1&__d=dis`;
        const jsonResp = await axios.get(jsonUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        return parseEdges(jsonResp.data);
    }

    // Navigate to media edges
    const edges = payload.props?.pageProps?.graphql?.user?.edge_owner_to_timeline_media?.edges;
    if (!edges) throw new Error('Could not find timeline media edges');

    return edges
        .filter(e => e.node?.__typename === 'GraphVideo')
        .map(e => ({ reelId: e.node.id, videoUrl: e.node.video_url }));
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

// Helper to parse fallback JSON structure
function parseEdges(data) {
    const edges = data.graphql?.user?.edge_owner_to_timeline_media?.edges;
    if (!edges) throw new Error('Fallback JSON missing edges');
    return edges
        .filter(e => e.node?.__typename === 'GraphVideo')
        .map(e => ({ reelId: e.node.id, videoUrl: e.node.video_url }));
}
