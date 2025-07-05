// Test RSS-based YouTube Shorts scraper (no API quota required)
require('dotenv').config();
const { scrapeYouTubeShortsViaRSS } = require('./scraper/youtubeRSSShortsScraper');

// Test source with a known YouTube channel that posts shorts
const testSource = {
    _id: 'test-rss-123',
    name: 'Test RSS Channel',
    youtubeChannelId: 'UCqwUrj10mAEsqezcItqvwEw', // Replace with a real channel ID
};

async function testRSSYouTubeShortsScraper() {
    console.log('🧪 Testing RSS-based YouTube Shorts Scraper...\n');

    try {
        const results = await scrapeYouTubeShortsViaRSS(testSource);
        console.log('\n🎉 RSS test completed successfully!');
        console.log(`📊 Results: ${results.length} reels processed`);

        if (results.length > 0) {
            console.log('\n📝 Sample result:', {
                reelId: results[0].reelId,
                caption: results[0].caption.substring(0, 100),
                videoUrl: results[0].videoUrl,
                publishedAt: results[0].publishedAt
            });
        } else {
            console.log('\n💡 No reels were processed. This could mean:');
            console.log('   - Channel has no recent videos');
            console.log('   - Videos are not in a format btch-downloader can handle');
            console.log('   - AWS S3 credentials are missing');
            console.log('   - All videos were duplicates');
        }

    } catch (error) {
        console.error('❌ RSS test failed:', error);
    } finally {
        console.log('\n📡 Test completed');
        process.exit(0);
    }
}

// Run the test
testRSSYouTubeShortsScraper();
