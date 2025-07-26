// Simple thumbnail generation test
require('dotenv').config();
const mongoose = require('mongoose');
const { thumbnailGenerator } = require('./services/ThumbnailGenerator');
const Reel = require('./models/Reel');

async function testThumbnailGeneration() {
    try {
        console.log('🔗 Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGO_URI);
        console.log('✅ Connected to MongoDB');

        // Test health check
        console.log('🏥 Testing health check...');
        const health = await thumbnailGenerator.healthCheck();
        console.log('Health result:', health);

        if (health.status !== 'healthy') {
            console.error('❌ Health check failed, aborting');
            process.exit(1);
        }

        // Get one video without thumbnail
        console.log('🔍 Finding a video without thumbnail...');
        const testVideo = await Reel.findOne({
            $or: [
                { thumbnailUrl: { $exists: false } },
                { thumbnailUrl: null },
                { thumbnailUrl: '' }
            ]
        });

        if (!testVideo) {
            console.log('No videos found without thumbnails');
            process.exit(0);
        }

        console.log('🎬 Found test video:');
        console.log('   ID:', testVideo._id);
        console.log('   Video URL:', testVideo.videoUrl);
        console.log('   Caption:', testVideo.caption || 'No caption');

        // Generate thumbnail
        console.log('🎯 Generating thumbnail...');
        const thumbnailUrl = await thumbnailGenerator.generateThumbnail(testVideo.videoUrl, testVideo._id);

        // Update the video record
        await Reel.findByIdAndUpdate(testVideo._id, { thumbnailUrl });

        console.log('🎉 SUCCESS! Thumbnail generated and saved:');
        console.log('   Thumbnail URL:', thumbnailUrl);

        process.exit(0);
    } catch (error) {
        console.error('❌ Error:', error.message);
        console.error('Stack:', error.stack);
        process.exit(1);
    }
}

testThumbnailGeneration();
