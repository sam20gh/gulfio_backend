// Simple batch thumbnail generation
require('dotenv').config();
const mongoose = require('mongoose');
const { thumbnailGenerator } = require('./services/ThumbnailGenerator');
const Reel = require('./models/Reel');

async function generateThumbnailsBatch(batchSize = 5) {
    try {
        console.log('🎬 Starting Batch Thumbnail Generation...');
        
        // Connect to MongoDB
        await mongoose.connect(process.env.MONGO_URI);
        console.log('✅ Connected to MongoDB');

        // Health check
        const health = await thumbnailGenerator.healthCheck();
        if (health.status !== 'healthy') {
            console.error('❌ Health check failed:', health);
            process.exit(1);
        }
        console.log('✅ System health check passed');

        // Get statistics
        const [totalVideos, videosWithThumbnails] = await Promise.all([
            Reel.countDocuments(),
            Reel.countDocuments({ thumbnailUrl: { $exists: true, $ne: null, $ne: '' } })
        ]);

        const videosWithoutThumbnails = totalVideos - videosWithThumbnails;
        console.log(`📊 Statistics: ${videosWithThumbnails}/${totalVideos} videos have thumbnails (${videosWithoutThumbnails} remaining)`);

        if (videosWithoutThumbnails === 0) {
            console.log('🎉 All videos already have thumbnails!');
            process.exit(0);
        }

        // Process batch
        const videosToProcess = await Reel.find({
            $or: [
                { thumbnailUrl: { $exists: false } },
                { thumbnailUrl: null },
                { thumbnailUrl: '' }
            ]
        }).limit(batchSize);

        console.log(`🔄 Processing ${videosToProcess.length} videos...`);

        let successful = 0;
        let failed = 0;

        for (let i = 0; i < videosToProcess.length; i++) {
            const video = videosToProcess[i];
            try {
                console.log(`\n📹 Video ${i + 1}/${videosToProcess.length}: ${video._id}`);
                console.log(`   URL: ${video.videoUrl}`);
                
                const thumbnailUrl = await thumbnailGenerator.generateThumbnail(video.videoUrl, video._id);
                
                // Update database
                await Reel.findByIdAndUpdate(video._id, { thumbnailUrl });
                
                successful++;
                console.log(`✅ Success: ${thumbnailUrl}`);
                
                // Delay between videos
                if (i < videosToProcess.length - 1) {
                    console.log('⏳ Waiting 3 seconds...');
                    await new Promise(resolve => setTimeout(resolve, 3000));
                }
                
            } catch (error) {
                failed++;
                console.error(`❌ Failed for ${video._id}: ${error.message}`);
            }
        }

        console.log(`\n🎉 Batch Complete!`);
        console.log(`   Successful: ${successful}`);
        console.log(`   Failed: ${failed}`);
        console.log(`   Success Rate: ${((successful / videosToProcess.length) * 100).toFixed(1)}%`);

        process.exit(0);

    } catch (error) {
        console.error('❌ Fatal Error:', error.message);
        process.exit(1);
    }
}

// Get batch size from command line or default to 5
const batchSize = parseInt(process.argv[2]) || 5;
generateThumbnailsBatch(batchSize);
