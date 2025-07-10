// scrape/youtubeScraper.js
const axios = require('axios');
const Video = require('../models/Video');
const { getDeepSeekEmbedding } = require('../utils/deepseek');
const API_KEY = process.env.YOUTUBE_API_KEY;

async function fetchYouTubeVideos(channelId) {
    const url = `https://www.googleapis.com/youtube/v3/search?key=${API_KEY}&channelId=${channelId}&part=snippet&type=video&order=date&maxResults=10`;
    const { data } = await axios.get(url);

    return data.items.map(video => ({
        videoId: video.id.videoId,
        title: video.snippet.title,
        description: video.snippet.description,
        publishedAt: video.snippet.publishedAt,
        thumbnailUrl: video.snippet.thumbnails.default.url
    }));
}

async function scrapeYouTubeForSource(sourceId, channelId) {
    const videos = await fetchYouTubeVideos(channelId);
    const results = [];

    for (const video of videos) {
        const inputText = `${video.title}\n\n${video.description}`;
        console.log(`   🤖 Generating embedding for: ${video.title}`);
        const embedding = await getDeepSeekEmbedding(inputText);

        const storedVideo = await Video.findOneAndUpdate(
            { source: sourceId, videoId: video.videoId },
            {
                ...video,
                scrapedAt: new Date(),
                embedding // make sure the Video schema supports an 'embedding' field (Array of numbers)
            },
            { upsert: true, new: true }
        );
        results.push(storedVideo);
    }

    return results;
}

module.exports = { scrapeYouTubeForSource };
