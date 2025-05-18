// scrape/instagramReels.js
const axios = require('axios');
const Reel = require('../models/Reel');

async function fetchReels(username) {
    // Fetch the raw HTML
    const profileUrl = `https://www.instagram.com/${username}/`;
    const resp = await axios.get(profileUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const html = resp.data;

    // Extract the JSON blob inside <script id="__NEXT_DATA__" ...>
    const m = html.match(
        /<script id="__NEXT_DATA__" type="application\/json">(.+?)<\/script>/
    );
    if (!m) {
        throw new Error('Could not locate Instagram JSON payload');
    }

    const payload = JSON.parse(m[1]);
    // Drill into the user’s timeline media
    const mediaEdges =
        payload.props
            .pageProps
            .graphql
            .user
            .edge_owner_to_timeline_media
            .edges;

    return mediaEdges
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
