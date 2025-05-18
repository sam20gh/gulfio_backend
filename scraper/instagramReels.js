// scrape/instagramReels.js
const axios = require('axios');
const Reel = require('../models/Reel');

/**
 * Attempts to fetch Reels via Instagram's private API,
 * then falls back to multiple HTML parsing strategies if needed.
 */
async function fetchReels(username) {
    // 1) Try private API
    try {
        const apiUrl = `https://i.instagram.com/api/v1/users/web_profile_info/?username=${username}`;
        const { data } = await axios.get(apiUrl, {
            headers: {
                'User-Agent': 'Instagram 155.0.0.37.107',
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
    } catch (err) {
        console.warn(`API fetch failed for ${username}: ${err.message}`);
    }

    // 2) Fallback: scrape HTML for JSON payloads
    const profileUrl = `https://www.instagram.com/${username}/`;
    const resp = await axios.get(profileUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const html = resp.data;

    // 2a) Try __NEXT_DATA__
    let jsonPayload;
    let match = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (match) {
        try {
            jsonPayload = JSON.parse(match[1]);
        } catch (e) {
            console.warn('Failed to parse __NEXT_DATA__ JSON');
        }
    }

    // 2b) If no NEXT_DATA, try window._sharedData
    if (!jsonPayload) {
        match = html.match(/window\._sharedData\s*=\s*(\{[\s\S]*?\});<\/script>/);
        if (match) {
            try {
                jsonPayload = JSON.parse(match[1]);
            } catch (e) {
                console.warn('Failed to parse window._sharedData JSON');
            }
        }
    }

    if (jsonPayload) {
        // navigate to edges
        const edges = jsonPayload.props?.pageProps?.graphql?.user?.edge_owner_to_timeline_media?.edges
            || jsonPayload.entry_data?.ProfilePage?.[0]?.graphql?.user?.edge_owner_to_timeline_media?.edges;
        if (edges?.length) {
            return edges
                .filter(e => e.node?.__typename === 'GraphVideo')
                .map(e => ({ reelId: e.node.id, videoUrl: e.node.video_url }));
        }
        console.warn('No reel edges found in parsed JSON');
    }

    throw new Error('Unable to extract reels via API or HTML parsing');
}

/**
 * Scrapes reels for a given source and upserts them to MongoDB.
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
