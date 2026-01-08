/**
 * Performance Indexes Creation Script
 * 
 * Run this script to create missing indexes that are causing slow queries.
 * Based on MongoDB Query Profiler analysis from Jan 3, 2026.
 * 
 * IDENTIFIED BOTTLENECKS:
 * 1. sourceId $in queries - 3.66s avg (648 docs examined per returned)
 * 2. embedding $exists queries - 4.49s avg (2.88 min total)
 * 3. $vectorSearch aggregations - 1.30s avg
 * 4. _id $in with projection - 1.19s avg
 * 
 * Usage: node scripts/create-performance-indexes.js
 */

const mongoose = require('mongoose');
require('dotenv').config();

// Increase timeout for index creation on large collections
const MONGO_OPTIONS = {
    serverSelectionTimeoutMS: 60000,
    socketTimeoutMS: 300000, // 5 minutes for index creation
    connectTimeoutMS: 60000
};

const INDEXES_TO_CREATE = [
    // 1. Compound index for source group diversity filtering
    // Used by: limitArticlesPerSourceGroup(), personalized-light endpoint
    {
        collection: 'articles',
        name: 'language_sourceGroupName_publishedAt',
        keys: { language: 1, sourceGroupName: 1, publishedAt: -1 },
        options: { background: true }
    },

    // 2. Partial index for embedding existence checks
    // Used by: related-embedding endpoint, AI recommendations
    // This dramatically speeds up: embedding: { $exists: true } queries
    {
        collection: 'articles',
        name: 'embedding_partial',
        keys: { embedding: 1 },
        options: {
            background: true,
            partialFilterExpression: { embedding: { $exists: true, $type: 'array' } }
        }
    },

    // 3. Partial index for PCA embedding existence
    // Used by: $vectorSearch queries, personalized recommendations
    {
        collection: 'articles',
        name: 'embedding_pca_partial',
        keys: { embedding_pca: 1 },
        options: {
            background: true,
            partialFilterExpression: { embedding_pca: { $exists: true, $type: 'array' } }
        }
    },

    // 4. Compound index for sourceGroupName filtering with recency
    {
        collection: 'articles',
        name: 'sourceGroupName_publishedAt',
        keys: { sourceGroupName: 1, publishedAt: -1 },
        options: { background: true }
    },

    // 5. User activities compound index for personalization queries
    {
        collection: 'useractivities',
        name: 'userId_articleId_timestamp',
        keys: { userId: 1, articleId: 1, timestamp: -1 },
        options: { background: true }
    },

    // 6. User activities index for user lookup
    {
        collection: 'useractivities',
        name: 'userId_timestamp',
        keys: { userId: 1, timestamp: -1 },
        options: { background: true }
    },

    // 7. User profiles index for supabase_id lookup
    {
        collection: 'userprofiles',
        name: 'supabase_id_1',
        keys: { supabase_id: 1 },
        options: { background: true, unique: true, sparse: true }
    },

    // 8. Videos/Reels embedding partial index
    {
        collection: 'reels',
        name: 'embedding_pca_partial',
        keys: { embedding_pca: 1 },
        options: {
            background: true,
            partialFilterExpression: { embedding_pca: { $exists: true, $type: 'array' } }
        }
    }
];

async function createIndexes() {
    const uri = process.env.MONGO_URI;
    if (!uri) {
        console.error('❌ MONGO_URI not found in .env');
        process.exit(1);
    }

    console.log('🔗 Connecting to MongoDB (with extended timeout for index creation)...');
    await mongoose.connect(uri, MONGO_OPTIONS);
    const db = mongoose.connection.db;

    console.log('\n📊 CREATING PERFORMANCE INDEXES');
    console.log('='.repeat(60));

    let created = 0;
    let skipped = 0;
    let failed = 0;

    for (const indexDef of INDEXES_TO_CREATE) {
        const { collection, name, keys, options } = indexDef;

        try {
            // Check if collection exists
            const collections = await db.listCollections({ name: collection }).toArray();
            if (collections.length === 0) {
                console.log(`⚠️  Collection '${collection}' does not exist, skipping index '${name}'`);
                skipped++;
                continue;
            }

            // Check if index already exists
            const existingIndexes = await db.collection(collection).indexes();
            const indexExists = existingIndexes.some(idx => idx.name === name);

            if (indexExists) {
                console.log(`✅ Index '${name}' already exists on '${collection}'`);
                skipped++;
                continue;
            }

            // Create the index
            console.log(`🔨 Creating index '${name}' on '${collection}'...`);
            console.log(`   Keys: ${JSON.stringify(keys)}`);

            await db.collection(collection).createIndex(keys, { ...options, name });

            console.log(`✅ Successfully created index '${name}'`);
            created++;

        } catch (error) {
            console.error(`❌ Failed to create index '${name}' on '${collection}':`, error.message);
            failed++;
        }
    }

    console.log('\n' + '='.repeat(60));
    console.log('📊 INDEX CREATION SUMMARY:');
    console.log(`   ✅ Created: ${created}`);
    console.log(`   ⏭️  Skipped (already exist): ${skipped}`);
    console.log(`   ❌ Failed: ${failed}`);

    // Verify all indexes
    console.log('\n📑 VERIFYING ARTICLE INDEXES:');
    const articleIndexes = await db.collection('articles').indexes();
    console.log(`   Total indexes on articles: ${articleIndexes.length}`);

    const criticalIndexes = [
        'language_sourceGroupName_publishedAt',
        'embedding_partial',
        'embedding_pca_partial',
        'sourceGroupName_publishedAt'
    ];

    for (const idx of criticalIndexes) {
        const exists = articleIndexes.some(i => i.name === idx);
        console.log(`   ${idx}: ${exists ? '✅' : '❌'}`);
    }

    await mongoose.disconnect();
    console.log('\n✅ Done');
}

createIndexes().catch(err => {
    console.error('❌ Fatal error:', err);
    process.exit(1);
});
