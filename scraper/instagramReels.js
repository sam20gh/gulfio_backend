
// scrape/instagramReels.js
const axios = require('axios');
const cheerio = require('cheerio');
const Reel = require('../models/Reel');

/**
 * Fetches the raw list of reels for a given Instagram username
 * by parsing the window._sharedData blob.
 *
 * @param {string} username
 * @returns {Promise<Array<{ reelId: string, videoUrl: string }>>}
 */
async function fetchReels(username) {
    const profileUrl = `https://www.instagram.com/${username}/`;
    const { data: html } = await axios.get(profileUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    const m = html.match(
        /<script type="text\/javascript">window\._sharedData = (.+?);<\/script>/
    );
    if (!m) throw new Error('Could not find sharedData on profile page');

    const sharedData = JSON.parse(m[1]);
    const edges = sharedData
        .entry_data.ProfilePage[0]
        .graphql.user
        .edge_owner_to_timeline_media.edges;

    return edges
        .filter(e => e.node.__typename === 'GraphVideo')
        .map(e => ({ reelId: e.node.id, videoUrl: e.node.video_url }));
}

/**
 * Scrapes reels for one Source, upserting into the DB.
 *
 * @param {ObjectId} sourceId
 * @param {string} username
 * @returns {Promise<Array<Reel>>}  the newly-upserted Reel docs
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
