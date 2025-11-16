/**
 * Fix MongoDB Atlas Vector Search Index
 * Add scrapedAt to the filter fields so it can be used in $vectorSearch filter
 */

require('dotenv').config();
const mongoose = require('mongoose');

async function fixVectorSearchIndex() {
    try {
        console.log('🔌 Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGO_URI);

        const db = mongoose.connection.db;
        const collection = db.collection('reels');

        console.log('\n📊 Current indexes on reels collection:');
        const indexes = await collection.indexes();
        indexes.forEach(idx => {
            console.log(`  - ${idx.name}:`, JSON.stringify(idx.key, null, 2));
        });

        console.log('\n⚠️  CRITICAL ISSUE IDENTIFIED:');
        console.log('Atlas Vector Search requires scrapedAt to be in a filter index.');
        console.log('Current error: "Path \'scrapedAt\' needs to be indexed as filter"');

        console.log('\n📝 SOLUTION:');
        console.log('You need to update the Atlas Search index via MongoDB Atlas UI:');
        console.log('\n1. Go to: https://cloud.mongodb.com/');
        console.log('2. Select your cluster → Search tab');
        console.log('3. Find the "default" index on "reels" collection');
        console.log('4. Click "Edit"');
        console.log('5. Update the index definition to:');

        const indexDefinition = {
            "fields": [
                {
                    "type": "vector",
                    "path": "embedding_pca",
                    "numDimensions": 128,
                    "similarity": "cosine"
                },
                {
                    "type": "date",
                    "path": "scrapedAt"
                },
                {
                    "type": "objectId",
                    "path": "_id"
                },
                {
                    "type": "string",
                    "path": "videoUrl"
                }
            ]
        };

        console.log(JSON.stringify(indexDefinition, null, 2));

        console.log('\n6. Click "Save Changes"');
        console.log('7. Wait for index to rebuild (takes a few minutes)');

        console.log('\n✅ After the index is updated, Phase 3.1 will work!');

        await mongoose.disconnect();
    } catch (error) {
        console.error('❌ Error:', error);
        process.exit(1);
    }
}

fixVectorSearchIndex();
