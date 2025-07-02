// Quick test for RSS-based YouTube Shorts scraper with database
require('dotenv').config();
const mongoose = require('mongoose');
const { scrapeYouTubeShortsViaRSS } = require('./scraper/youtubeRSSShortsScraper');

async function quickTest() {
    console.log('🚀 Quick test of RSS-based YouTube Shorts scraper...\n');
    
    try {
        // Connect to MongoDB
        console.log('📡 Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGO_URI, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
        });
        console.log('✅ Connected to MongoDB');
        
        // Test source - use a channel that definitely has recent videos
        const testSource = {
            _id: new mongoose.Types.ObjectId(),
            name: 'Test Channel (BB Ki Vines)',
            youtubeChannelId: 'UCqwUrj10mAEsqezcItqvwEw', // BB Ki Vines - has recent content
        };
        
        console.log(`\n🎬 Testing with channel: ${testSource.name}`);
        console.log(`📺 Channel ID: ${testSource.youtubeChannelId}`);
        
        const results = await scrapeYouTubeShortsViaRSS(testSource);
        
        console.log('\n🎉 Test completed!');
        console.log(`📊 Results: ${results.length} reels processed`);
        
        if (results.length > 0) {
            console.log('\n📝 Sample result:');
            const sample = results[0];
            console.log(`   Reel ID: ${sample.reelId}`);
            console.log(`   Caption: ${sample.caption.substring(0, 100)}${sample.caption.length > 100 ? '...' : ''}`);
            console.log(`   Video URL: ${sample.videoUrl}`);
            console.log(`   Published: ${sample.publishedAt}`);
            console.log(`   S3 Upload: ${sample.videoUrl.includes('amazonaws.com') ? '✅ Success' : '❌ Failed'}`);
        } else {
            console.log('\n💡 No reels processed. Checking why:');
            console.log('   This could mean:');
            console.log('   - All videos found were long-form (not shorts)');
            console.log('   - btch-downloader couldn\'t extract URLs');
            console.log('   - Videos were duplicates in database');
            console.log('   - Network issues with downloads');
        }
        
    } catch (error) {
        console.error('\n❌ Test failed:', error.message);
        if (error.stack) {
            console.error('Stack trace:', error.stack);
        }
    } finally {
        await mongoose.disconnect();
        console.log('\n📡 Disconnected from MongoDB');
        process.exit(0);
    }
}

quickTest();
