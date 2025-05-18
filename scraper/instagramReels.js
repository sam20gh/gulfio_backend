// scrape/instagramReels.js
const axios = require('axios');
const Reel = require('../models/Reel');

/**
 * Fetches reels by hitting Instagram’s JSON endpoint.
 */
async function fetchReels(username) {
    // This endpoint returns JSON with the same data we need.
    const jsonUrl = `https://www.instagram.com/${username}/?__a=1&__d=dis`;
    const { data } = await axios.get(jsonUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    // Dive into the JSON:
    const edges = data.graphql.user.edge_owner_to_timeline_media.edges;
    return edges
        .filter(e => e.node.__typename === 'GraphVideo')
        .map(e => ({
            reelId: e.node.id,
            videoUrl: e.node.video_url
        }));
}

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
