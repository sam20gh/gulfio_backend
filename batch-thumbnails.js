// Batch thumbnail generation for reels.
//
// Fills in thumbnailUrl for every reel that is missing one. Delegates the heavy
// lifting to services/ThumbnailGenerator, which:
//   - re-signs S3 URLs from originalKey before handing them to ffmpeg (so
//     expired signatures and unsigned scraper `publicUrl`s still work), and
//   - keeps going until ALL missing thumbnails are filled (not just one batch).
//
// Requires the ffmpeg binary (installed in the backend Dockerfile).
//
// Usage:
//   node batch-thumbnails.js [batchSize] [maxTotal]
//     batchSize  reels per DB page         (default 5)
//     maxTotal   stop after this many      (default: all)
require('dotenv').config();
const mongoose = require('mongoose');
const { thumbnailGenerator } = require('./services/ThumbnailGenerator');
const Reel = require('./models/Reel');

async function generateThumbnailsBatch(batchSize, maxTotal) {
    try {
        console.log('🎬 Starting Batch Thumbnail Generation for Reels...');

        await mongoose.connect(process.env.MONGO_URI);
        console.log('✅ Connected to MongoDB');

        // Fail fast with a clear message if ffmpeg/S3 aren't available.
        const health = await thumbnailGenerator.healthCheck();
        if (health.status !== 'healthy') {
            console.error('❌ Health check failed:', health);
            console.error('   → Ensure the ffmpeg binary is installed (see Dockerfile) and AWS creds are set.');
            process.exit(1);
        }
        console.log('✅ System health check passed (ffmpeg + S3 reachable)');

        const totalReels = await Reel.countDocuments();
        const missing = await Reel.countDocuments(thumbnailGenerator.constructor.MISSING_THUMBNAIL_QUERY);
        console.log(`📊 ${missing} of ${totalReels} reels need thumbnails`);

        if (missing === 0) {
            console.log('🎉 All reels already have valid thumbnails!');
            process.exit(0);
        }

        const results = await thumbnailGenerator.processExistingVideos(batchSize, maxTotal);

        const remaining = await Reel.countDocuments(thumbnailGenerator.constructor.MISSING_THUMBNAIL_QUERY);
        console.log(`\n🎉 Batch Complete!`);
        console.log(`   Processed:  ${results.processed}`);
        console.log(`   Successful: ${results.successful}`);
        console.log(`   Failed:     ${results.failed}`);
        if (results.processed > 0) {
            console.log(`   Success Rate: ${((results.successful / results.processed) * 100).toFixed(1)}%`);
        }
        console.log(`   Remaining without thumbnails: ${remaining}`);

        process.exit(0);
    } catch (error) {
        console.error('❌ Fatal Error:', error.message);
        console.error('Stack trace:', error.stack);
        process.exit(1);
    }
}

const batchSize = parseInt(process.argv[2]) || 5;
// Default to "all". Anything non-numeric (e.g. a stray shell `#` comment) → all.
const parsedMax = parseInt(process.argv[3], 10);
const maxTotal = Number.isFinite(parsedMax) && parsedMax > 0 ? parsedMax : Infinity;
console.log(`🚀 Starting thumbnail generation — batchSize: ${batchSize}, maxTotal: ${maxTotal}`);
generateThumbnailsBatch(batchSize, maxTotal);
