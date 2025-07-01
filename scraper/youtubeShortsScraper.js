// scraper/youtubeShorts.js
const axios = require('axios');
const { youtube } = require('btch-downloader');
const Reel = require('../models/Reel');
const { getDeepSeekEmbedding } = require('../utils/deepseek');

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

async function scrapeYouTubeShortsForSource(source) {
    const channelId = source.youtubeChannelId;
    if (!channelId) return [];

    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelId}&type=video&videoDuration=short&q=%23Shorts&maxResults=2&key=${YOUTUBE_API_KEY}`;
    const { data } = await axios.get(url);

    const upsertedReels = [];

    for (const item of data.items) {
        const videoId = item.id.videoId;
        const caption = item.snippet.title;
        const publishedAt = item.snippet.publishedAt;

        const youtubeUrl = `https://youtube.com/watch?v=${videoId}`;

        try {
            const result = await youtube(youtubeUrl);

            // Handle both array and object formats
            const videoUrl =
                (Array.isArray(result) && result[0]?.url) ||
                (typeof result === 'object' && result.mp4);

            if (!videoUrl) {
                console.warn(`❌ No video URL found in result for ${youtubeUrl}`);
                console.dir(result, { depth: 5 });
                continue;
            }

            const exists = await Reel.findOne({ videoUrl });
            if (exists) continue;

            const embedding = await getDeepSeekEmbedding(caption);

            const reel = new Reel({
                source: source._id,
                videoId,
                videoUrl,
                caption,
                publishedAt,
                scrapedAt: new Date(),
                embedding
            });

            await reel.save();
            upsertedReels.push(reel);
        } catch (err) {
            console.error(`❌ Error calling btch-downloader for ${youtubeUrl}`);
            console.error(err);
        }
    }

    return upsertedReels;
}

module.exports = { scrapeYouTubeShortsForSource };
