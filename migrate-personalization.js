/**
 * Migration Script: Add Indexes for Personalized Recommendations
 * 
 * This script adds the necessary database indexes to support
 * efficient personalized recommendations and user interaction tracking.
 */

const mongoose = require('mongoose');
require('dotenv').config();

// Import models to ensure schemas are loaded
const Reel = require('./models/Reel');
const UserActivity = require('./models/UserActivity');

async function addPersonalizationIndexes() {
    try {
        console.log('🔗 Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('✅ Connected to MongoDB');

        console.log('\n📊 Adding Reel indexes for personalization...');
        
        // Indexes for user interaction arrays
        await Reel.collection.createIndex({ "likedBy": 1 });
        console.log('✅ Added index: likedBy');
        
        await Reel.collection.createIndex({ "dislikedBy": 1 });
        console.log('✅ Added index: dislikedBy');
        
        await Reel.collection.createIndex({ "savedBy": 1 });
        console.log('✅ Added index: savedBy');
        
        await Reel.collection.createIndex({ "viewedBy": 1 });
        console.log('✅ Added index: viewedBy');

        // Compound indexes for personalized queries
        await Reel.collection.createIndex({ 
            "scrapedAt": -1, 
            "viewCount": -1 
        });
        console.log('✅ Added compound index: scrapedAt + viewCount');

        await Reel.collection.createIndex({ 
            "likes": -1, 
            "scrapedAt": -1 
        });
        console.log('✅ Added compound index: likes + scrapedAt');

        await Reel.collection.createIndex({ 
            "embedding": 1, 
            "scrapedAt": -1 
        }, { sparse: true });
        console.log('✅ Added sparse index: embedding + scrapedAt');

        await Reel.collection.createIndex({ 
            "embedding_pca": 1, 
            "scrapedAt": -1 
        }, { sparse: true });
        console.log('✅ Added sparse index: embedding_pca + scrapedAt');

        console.log('\n📈 Adding UserActivity indexes...');
        
        // UserActivity indexes for personalization
        await UserActivity.collection.createIndex({ 
            "userId": 1, 
            "eventType": 1, 
            "timestamp": -1 
        });
        console.log('✅ Added compound index: userId + eventType + timestamp');

        await UserActivity.collection.createIndex({ 
            "userId": 1, 
            "timestamp": -1 
        });
        console.log('✅ Added compound index: userId + timestamp');

        await UserActivity.collection.createIndex({ 
            "articleId": 1, 
            "eventType": 1 
        });
        console.log('✅ Added compound index: articleId + eventType');

        console.log('\n📋 Listing all indexes...');
        
        // List all indexes on Reel collection
        const reelIndexes = await Reel.collection.listIndexes().toArray();
        console.log('\n🎬 Reel collection indexes:');
        reelIndexes.forEach(index => {
            console.log(`  - ${index.name}: ${JSON.stringify(index.key)}`);
        });

        // List all indexes on UserActivity collection
        const activityIndexes = await UserActivity.collection.listIndexes().toArray();
        console.log('\n👤 UserActivity collection indexes:');
        activityIndexes.forEach(index => {
            console.log(`  - ${index.name}: ${JSON.stringify(index.key)}`);
        });

        console.log('\n✅ Migration completed successfully!');
        console.log('\n🎯 Performance optimizations added:');
        console.log('  • Fast user interaction lookups (liked, saved, viewed reels)');
        console.log('  • Efficient personalized feed queries');
        console.log('  • Optimized embedding-based similarity searches');
        console.log('  • Quick user activity history retrieval');
        console.log('  • Sparse indexes for optional fields (embeddings)');

    } catch (error) {
        console.error('❌ Migration failed:', error);
        process.exit(1);
    } finally {
        await mongoose.disconnect();
        console.log('\n🔌 Disconnected from MongoDB');
        process.exit(0);
    }
}

// Add some database statistics
async function getDatabaseStats() {
    try {
        const reelCount = await Reel.countDocuments();
        const reelsWithEmbeddings = await Reel.countDocuments({ embedding: { $exists: true, $ne: [] } });
        const reelsWithPCAEmbeddings = await Reel.countDocuments({ embedding_pca: { $exists: true, $ne: [] } });
        const activityCount = await UserActivity.countDocuments();

        console.log('\n📊 Database Statistics:');
        console.log(`  Total Reels: ${reelCount.toLocaleString()}`);
        console.log(`  Reels with full embeddings: ${reelsWithEmbeddings.toLocaleString()} (${((reelsWithEmbeddings/reelCount)*100).toFixed(1)}%)`);
        console.log(`  Reels with PCA embeddings: ${reelsWithPCAEmbeddings.toLocaleString()} (${((reelsWithPCAEmbeddings/reelCount)*100).toFixed(1)}%)`);
        console.log(`  User activities: ${activityCount.toLocaleString()}`);

        // Sample reel with interactions
        const sampleReelWithInteractions = await Reel.findOne({
            $or: [
                { likedBy: { $exists: true, $ne: [] } },
                { savedBy: { $exists: true, $ne: [] } },
                { viewedBy: { $exists: true, $ne: [] } }
            ]
        }).lean();

        if (sampleReelWithInteractions) {
            console.log('\n🔍 Sample reel with interactions:');
            console.log(`  Reel ID: ${sampleReelWithInteractions._id}`);
            console.log(`  Likes: ${sampleReelWithInteractions.likes || 0} (${sampleReelWithInteractions.likedBy?.length || 0} users)`);
            console.log(`  Saves: ${sampleReelWithInteractions.saves || 0} (${sampleReelWithInteractions.savedBy?.length || 0} users)`);
            console.log(`  Views: ${sampleReelWithInteractions.viewCount || 0} (${sampleReelWithInteractions.viewedBy?.length || 0} tracked users)`);
        }

    } catch (error) {
        console.warn('⚠️ Could not get database statistics:', error.message);
    }
}

// Run migration
console.log('🚀 Starting personalization database migration...');
console.log('==============================================');

addPersonalizationIndexes()
    .then(() => getDatabaseStats())
    .catch(console.error);
