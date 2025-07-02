// Test script for YouTube Shorts scraper
require('dotenv').config();
const mongoose = require('mongoose');
const { scrapeYouTubeShortsForSource } = require('./scraper/youtubeShortsScraper');

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/gulfio', {
    useNewUrlParser: true,
    useUnifiedTopology: true,
});

// Test source with a known YouTube channel
const testSource = {
    _id: new mongoose.Types.ObjectId(),
    name: 'Test YouTube Channel',
    youtubeChannelId: 'UCqwUrj10mAEsqezcItqvwEw', // Example: replace with a real channel ID that has shorts
};

async function testYouTubeShortsScraper() {
    console.log('🧪 Testing YouTube Shorts Scraper...\n');

    try {
        const results = await scrapeYouTubeShortsForSource(testSource);
        console.log('\n🎉 Test completed successfully!');
        console.log(`📊 Results: ${results.length} reels processed`);

        if (results.length > 0) {
            console.log('\n📝 Sample result:', {
                reelId: results[0].reelId,
                caption: results[0].caption.substring(0, 100),
                videoUrl: results[0].videoUrl,
                publishedAt: results[0].publishedAt
            });
        }

    } catch (error) {
        console.error('❌ Test failed:', error);
    } finally {
        await mongoose.disconnect();
        console.log('\n📡 Disconnected from MongoDB');
        process.exit(0);
    }
}

// Run the test
testYouTubeShortsScraper();
