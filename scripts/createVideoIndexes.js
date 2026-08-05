/**
 * MongoDB Index Creation Script for Video Recommendation Optimization
 * 
 * This script creates optimized indexes for video/reel queries to improve performance
 * of the Atlas Search enhanced recommendation system.
 */

const mongoose = require('mongoose');
require('dotenv').config();

async function createIndexes() {
    try {
        console.log('🔄 Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGO_URI || process.env.DATABASE_URL);
        console.log('✅ Connected to MongoDB');

        const db = mongoose.connection.db;

        // Create indexes for reels collection
        console.log('🔧 Creating indexes for reels collection...');

        // ViewCount index for popular content queries
        await db.collection('reels').createIndex({ "viewCount": -1 });
        console.log('✅ Created viewCount descending index');

        // ScrapedAt index for fresh content queries
        await db.collection('reels').createIndex({ "scrapedAt": -1 });
        console.log('✅ Created scrapedAt descending index');

        // Categories index for category-based filtering
        await db.collection('reels').createIndex({ "categories": 1 });
        console.log('✅ Created categories index');

        // CompletionRate index for engagement scoring
        await db.collection('reels').createIndex({ "completionRate": -1 });
        console.log('✅ Created completionRate descending index');

        // Compound index for trending content (viewCount + scrapedAt)
        await db.collection('reels').createIndex({
            "viewCount": -1,
            "scrapedAt": -1
        });
        console.log('✅ Created compound viewCount + scrapedAt index');

        // Compound index for engagement scoring (likes + viewCount + completionRate)
        await db.collection('reels').createIndex({
            "likes": -1,
            "viewCount": -1,
            "completionRate": -1
        });
        console.log('✅ Created compound engagement index');

        // Create indexes for user activities collection
        console.log('🔧 Creating indexes for useractivities collection...');

        // UserId index for user preference queries
        await db.collection('useractivities').createIndex({ "userId": 1 });
        console.log('✅ Created userId index');

        // Compound index for user activity queries (userId + eventType + timestamp)
        await db.collection('useractivities').createIndex({
            "userId": 1,
            "eventType": 1,
            "timestamp": -1
        });
        console.log('✅ Created compound user activity index');

        // Timestamp index for cleanup operations
        await db.collection('useractivities').createIndex({ "timestamp": -1 });
        console.log('✅ Created timestamp descending index');

        // Create indexes for source filtering
        console.log('🔧 Creating indexes for sources collection...');

        // Source name index for preference matching
        await db.collection('sources').createIndex({ "name": 1 });
        console.log('✅ Created source name index');

        // Verify Atlas Search vector index exists
        console.log('🔍 Checking for Atlas Search vector index...');
        try {
            // listSearchIndexes, not listIndexes — search indexes live in mongot and
            // never appear in the btree index list, so the old check could never pass.
            const indexes = await db.collection('reels').listSearchIndexes().toArray();
            const vectorIndex = indexes.find(idx => idx.name === 'default');

            if (vectorIndex) {
                console.log('✅ Atlas vector search index "default" found');
                console.log(`📊 Vector index details:`, {
                    name: vectorIndex.name,
                    type: vectorIndex.type || 'search',
                    status: vectorIndex.status,
                    queryable: vectorIndex.queryable
                });
            } else {
                console.log('⚠️ Atlas vector search index "default" not found');
                console.log('📝 Please create the vector index manually in MongoDB Atlas:');
                console.log(`
{
  "fields": [
    {
      "numDimensions": 128,
      "path": "embedding_pca",
      "similarity": "cosine",
      "type": "vector"
    }
  ]
}
                `);
            }
        } catch (err) {
            console.log('ℹ️ Could not check vector index (this is normal for non-Atlas clusters)');
        }

        console.log('🎉 All indexes created successfully!');
        console.log('📊 Index Summary:');
        console.log('- Reels: viewCount, scrapedAt, categories, completionRate, compound indexes');
        console.log('- UserActivities: userId, timestamp, compound user activity index');
        console.log('- Sources: name index');
        console.log('- Vector Search: embedding_pca (Atlas Search)');

    } catch (error) {
        console.error('❌ Error creating indexes:', error);
        process.exit(1);
    } finally {
        await mongoose.disconnect();
        console.log('👋 Disconnected from MongoDB');
        process.exit(0);
    }
}

// Run the script
if (require.main === module) {
    createIndexes();
}

module.exports = { createIndexes };
