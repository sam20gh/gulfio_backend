// Simple batch thumbnail generation for reels
require('dotenv').config();
const mongoose = require('mongoose');
const { thumbnailGenerator } = require('./services/ThumbnailGenerator');
const Reel = require('./models/Reel');

async function generateThumbnailsBatch(batchSize = 5) {
    try {
        console.log('🎬 Starting Batch Thumbnail Generation for Reels...');

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

        // Get statistics - check for null thumbnails specifically
        const [totalReels, reelsWithValidThumbnails, reelsWithNullThumbnails] = await Promise.all([
            Reel.countDocuments(),
            Reel.countDocuments({ 
                thumbnailUrl: { 
                    $exists: true, 
                    $ne: null, 
                    $ne: '', 
                    $regex: /^https?:\/\/.+/ // Must be a valid URL
                } 
            }),
            Reel.countDocuments({ thumbnailUrl: null })
        ]);

        const reelsWithoutThumbnails = totalReels - reelsWithValidThumbnails;
        console.log(`📊 Statistics:`);
        console.log(`   Total reels: ${totalReels}`);
        console.log(`   Reels with valid thumbnails: ${reelsWithValidThumbnails}`);
        console.log(`   Reels with null thumbnails: ${reelsWithNullThumbnails}`);
        console.log(`   Reels needing thumbnails: ${reelsWithoutThumbnails}`);

        if (reelsWithoutThumbnails === 0) {
            console.log('🎉 All reels already have valid thumbnails!');
            process.exit(0);
        }

        // Process batch - find reels without thumbnails or with null/invalid thumbnails
        const reelsToProcess = await Reel.find({
            $or: [
                { thumbnailUrl: { $exists: false } },
                { thumbnailUrl: null },
                { thumbnailUrl: '' },
                { thumbnailUrl: { $not: /^https?:\/\/.+/ } } // Invalid URL format
            ],
            // Ensure we only process reels that have a valid video URL
            videoUrl: { $exists: true, $ne: null, $ne: '' }
        }).limit(batchSize);

        console.log(`🔄 Processing ${reelsToProcess.length} reels...`);

        if (reelsToProcess.length === 0) {
            console.log('📭 No reels found that need thumbnail generation');
            process.exit(0);
        }

        let successful = 0;
        let failed = 0;

        for (let i = 0; i < reelsToProcess.length; i++) {
            const reel = reelsToProcess[i];
            try {
                console.log(`\n🎥 Reel ${i + 1}/${reelsToProcess.length}: ${reel._id}`);
                console.log(`   Title: ${reel.title || 'Untitled'}`);
                console.log(`   URL: ${reel.videoUrl}`);

                const thumbnailUrl = await thumbnailGenerator.generateThumbnail(reel.videoUrl, reel._id);

                // Update database
                await Reel.findByIdAndUpdate(reel._id, { 
                    thumbnailUrl,
                    updatedAt: new Date() // Update timestamp if your schema has this field
                });

                successful++;
                console.log(`✅ Success: ${thumbnailUrl}`);

                // Delay between reels to avoid overwhelming the service
                if (i < reelsToProcess.length - 1) {
                    console.log('⏳ Waiting 3 seconds...');
                    await new Promise(resolve => setTimeout(resolve, 3000));
                }

            } catch (error) {
                failed++;
                console.error(`❌ Failed for reel ${reel._id}: ${error.message}`);
                
                // Log additional context for debugging
                if (error.message.includes('invalid') || error.message.includes('format')) {
                    console.error(`   Video URL format issue: ${reel.videoUrl}`);
                }
            }
        }

        // Final statistics
        const updatedStats = await Reel.countDocuments({ thumbnailUrl: { $exists: true, $ne: null, $ne: '' } });
        const remainingWithoutThumbnails = totalReels - updatedStats;

        console.log(`\n🎉 Batch Complete!`);
        console.log(`   Successful: ${successful}`);
        console.log(`   Failed: ${failed}`);
        console.log(`   Success Rate: ${((successful / reelsToProcess.length) * 100).toFixed(1)}%`);
        console.log(`   Total reels with thumbnails: ${updatedStats}/${totalReels}`);
        console.log(`   Remaining without thumbnails: ${remainingWithoutThumbnails}`);

        process.exit(0);

    } catch (error) {
        console.error('❌ Fatal Error:', error.message);
        console.error('Stack trace:', error.stack);
        process.exit(1);
    }
}

// Get batch size from command line or default to 5
const batchSize = parseInt(process.argv[2]) || 5;
console.log(`🚀 Starting thumbnail generation with batch size: ${batchSize}`);
generateThumbnailsBatch(batchSize);
