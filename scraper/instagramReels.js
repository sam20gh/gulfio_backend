// scrape/instagramReels.js
const axios = require('axios');
const Reel = require('../models/Reel');

/**
 * Fetches Reels using Instagram's private web_profile_info API.
 * Throws if the API call fails or returns no reels.
 */
async function fetchReels(username) {
    const apiUrl = `https://i.instagram.com/api/v1/users/web_profile_info/?username=${username}`;
    const { data } = await axios.get(apiUrl, {
        headers: {
            'User-Agent': 'Mozilla/5.0',
            'x-ig-app-id': '936619743392459'
        }
    });

    const edges = data?.data?.user?.edge_owner_to_timeline_media?.edges;
    if (!edges) {
        throw new Error('Instagram API did not return reel edges');
    }

    return edges
        .filter(e => e.node?.__typename === 'GraphVideo')
        .map(e => ({ reelId: e.node.id, videoUrl: e.node.video_url }));
}

/**
 * Upserts scraped reels into the database.
 */
async function scrapeReelsForSource(sourceId, username) {
    try {
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
    } catch (err) {
        // Log the error for debugging and rethrow
        console.error(`Failed to fetch reels for ${username}:`, err.message);
        throw new Error('Failed to scrape Instagram reels via API');
    }
}

module.exports = { scrapeReelsForSource };
