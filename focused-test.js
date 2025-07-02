// Quick focused test for S3 upload fix
require('dotenv').config();
const mongoose = require('mongoose');
const { scrapeYouTubeShortsViaRSS } = require('./scraper/youtubeRSSShortsScraper');

async function focusedTest() {
    console.log('🎯 Focused S3 upload test...\n');
    
    try {
        // Connect to MongoDB
        console.log('📡 Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGO_URI);
        console.log('✅ Connected to MongoDB');
        
        // Test source - use a channel with short videos
        const testSource = {
            _id: new mongoose.Types.ObjectId(),
            name: 'Test Channel (Short Content)',
            youtubeChannelId: 'UCqwUrj10mAEsqezcItqvwEw',
        };
        
        console.log('\n🎬 Testing RSS scraper with S3 upload fix...');
        
        // Modified to test only 1 video for speed
        const originalLimit = 5;
        const results = await scrapeYouTubeShortsViaRSS(testSource);
        
        console.log('\n🎉 Test completed!');
        console.log(`📊 Results: ${results.length} reels processed`);
        
        if (results.length > 0) {
            console.log('\n✅ SUCCESS! RSS-based scraper is working!');
            const sample = results[0];
            console.log(`📝 Sample result:`);
            console.log(`   📹 Reel ID: ${sample.reelId}`);
            console.log(`   📝 Caption: ${sample.caption.substring(0, 80)}...`);
            console.log(`   🔗 Video URL: ${sample.videoUrl}`);
            console.log(`   📅 Published: ${sample.publishedAt}`);
            console.log(`   ☁️ S3 Upload: ${sample.videoUrl.includes('amazonaws.com') ? '✅ Success' : '❌ Failed'}`);
        } else {
            console.log('\n❌ No reels processed. Checking S3 logs above...');
        }
        
    } catch (error) {
        console.error('\n❌ Test failed:', error.message);
    } finally {
        await mongoose.disconnect();
        console.log('\n📡 Disconnected from MongoDB');
        process.exit(0);
    }
}

focusedTest();
