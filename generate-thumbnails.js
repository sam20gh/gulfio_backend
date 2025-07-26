#!/usr/bin/env node

/**
 * Batch Thumbnail Generation Script
 * 
 * This script generates thumbnails for all existing videos that don't have them yet.
 * Run this script to process your existing video library.
 * 
 * Usage:
 *   node generate-thumbnails.js [batch-size]
 * 
 * Example:
 *   node generate-thumbnails.js 5    # Process 5 videos at a time
 *   node generate-thumbnails.js      # Default: Process 10 videos at a time
 */

require('dotenv').config(); // Load environment variables first
const mongoose = require('mongoose');
const { thumbnailGenerator } = require('./services/ThumbnailGenerator');

async function main() {
    console.log('🎬 Starting Thumbnail Generation Process...\n');

    try {
        // Connect to MongoDB
        console.log('🔗 Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGO_URI, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
        });
        console.log('✅ Connected to MongoDB\n');

        // Get batch size from command line argument or default to 10
        const batchSize = parseInt(process.argv[2]) || 10;
        console.log(`📊 Processing batch size: ${batchSize} videos\n`);

        // Check system health first
        console.log('🏥 Checking system health...');
        const health = await thumbnailGenerator.healthCheck();
        
        if (health.status !== 'healthy') {
            console.error('❌ System health check failed:', health);
            console.error('Please ensure FFmpeg is installed and AWS credentials are configured.');
            process.exit(1);
        }
        console.log('✅ System health check passed\n');

        // Get current statistics
        const Reel = require('./models/Reel');
        const [totalVideos, videosWithThumbnails] = await Promise.all([
            Reel.countDocuments(),
            Reel.countDocuments({ thumbnailUrl: { $exists: true, $ne: null, $ne: '' } })
        ]);

        const videosWithoutThumbnails = totalVideos - videosWithThumbnails;
        const coveragePercentage = totalVideos > 0 ? ((videosWithThumbnails / totalVideos) * 100).toFixed(2) : 0;

        console.log('📈 Current Statistics:');
        console.log(`   Total Videos: ${totalVideos}`);
        console.log(`   With Thumbnails: ${videosWithThumbnails}`);
        console.log(`   Without Thumbnails: ${videosWithoutThumbnails}`);
        console.log(`   Coverage: ${coveragePercentage}%\n`);

        if (videosWithoutThumbnails === 0) {
            console.log('🎉 All videos already have thumbnails! Nothing to process.');
            process.exit(0);
        }

        // Start batch processing
        console.log('🚀 Starting batch thumbnail generation...\n');
        const startTime = Date.now();
        
        let totalProcessed = 0;
        let totalSuccessful = 0;
        let totalFailed = 0;
        let batchNumber = 1;

        while (true) {
            console.log(`\n📦 Processing Batch ${batchNumber}...`);
            console.log(`⏰ ${new Date().toLocaleTimeString()}`);
            
            const results = await thumbnailGenerator.processExistingVideos(batchSize);
            
            totalProcessed += results.processed;
            totalSuccessful += results.successful;
            totalFailed += results.failed;

            console.log(`✅ Batch ${batchNumber} completed:`);
            console.log(`   Processed: ${results.processed}`);
            console.log(`   Successful: ${results.successful}`);
            console.log(`   Failed: ${results.failed}`);

            // Break if no more videos to process
            if (results.processed < batchSize) {
                console.log('\n🏁 No more videos to process');
                break;
            }

            batchNumber++;
            
            // Add a longer delay between batches to be gentle on resources
            console.log('⏳ Waiting 10 seconds before next batch...');
            await new Promise(resolve => setTimeout(resolve, 10000));
        }

        const endTime = Date.now();
        const duration = ((endTime - startTime) / 1000).toFixed(2);

        console.log('\n🎉 Thumbnail Generation Complete!');
        console.log('═'.repeat(50));
        console.log(`📊 Final Results:`);
        console.log(`   Total Videos Processed: ${totalProcessed}`);
        console.log(`   Successfully Generated: ${totalSuccessful}`);
        console.log(`   Failed: ${totalFailed}`);
        console.log(`   Success Rate: ${totalProcessed > 0 ? ((totalSuccessful / totalProcessed) * 100).toFixed(2) : 0}%`);
        console.log(`   Total Duration: ${duration} seconds`);
        console.log(`   Average Time per Video: ${totalProcessed > 0 ? (duration / totalProcessed).toFixed(2) : 0} seconds`);

        if (totalFailed > 0) {
            console.log('\n⚠️  Some thumbnails failed to generate. This could be due to:');
            console.log('   • Corrupted video files');
            console.log('   • Network issues accessing video URLs');
            console.log('   • AWS S3 upload issues');
            console.log('   • FFmpeg processing errors');
            console.log('\n💡 You can re-run this script to retry failed videos.');
        }

        process.exit(0);

    } catch (error) {
        console.error('\n❌ Fatal Error:', error);
        console.error('\nStack trace:', error.stack);
        process.exit(1);
    } finally {
        try {
            await mongoose.connection.close();
            console.log('\n🔒 Database connection closed');
        } catch (closeError) {
            console.error('Error closing database connection:', closeError);
        }
    }
}

// Handle process termination gracefully
process.on('SIGINT', async () => {
    console.log('\n\n⚠️  Process interrupted by user (Ctrl+C)');
    console.log('🔒 Closing database connection...');
    try {
        await mongoose.connection.close();
        console.log('✅ Database connection closed');
        process.exit(0);
    } catch (error) {
        console.error('❌ Error during cleanup:', error);
        process.exit(1);
    }
});

process.on('uncaughtException', (error) => {
    console.error('\n❌ Uncaught Exception:', error);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('\n❌ Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
});

// Show help if requested
if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('🎬 Thumbnail Generation Script');
    console.log('');
    console.log('Usage:');
    console.log('  node generate-thumbnails.js [batch-size]');
    console.log('');
    console.log('Examples:');
    console.log('  node generate-thumbnails.js     # Process 10 videos at a time (default)');
    console.log('  node generate-thumbnails.js 5   # Process 5 videos at a time');
    console.log('  node generate-thumbnails.js 20  # Process 20 videos at a time');
    console.log('');
    console.log('Options:');
    console.log('  --help, -h    Show this help message');
    console.log('');
    console.log('Environment Variables Required:');
    console.log('  MONGO_URI                MongoDB connection string');
    console.log('  AWS_ACCESS_KEY_ID        AWS access key');
    console.log('  AWS_SECRET_ACCESS_KEY    AWS secret key');
    console.log('  AWS_REGION              AWS region (default: me-central-1)');
    console.log('  AWS_BUCKET_NAME         S3 bucket name (default: blipsbucket)');
    process.exit(0);
}

// Run only if executed directly
if (require.main === module) {
    main();
}
