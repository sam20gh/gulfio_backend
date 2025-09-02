#!/usr/bin/env node

/**
 * MongoDB Atlas Index Analysis Script
 * This script checks indexes and query performance for the articles collection
 */

require('dotenv').config();
const mongoose = require('mongoose');

// Connect to MongoDB
async function connectDB() {
    try {
        const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
        if (!mongoUri) {
            console.error('❌ MongoDB URI not found in environment variables');
            console.error('   Make sure MONGO_URI or MONGODB_URI is set in .env file');
            process.exit(1);
        }
        await mongoose.connect(mongoUri);
        console.log('✅ Connected to MongoDB Atlas');
    } catch (error) {
        console.error('❌ MongoDB connection error:', error);
        process.exit(1);
    }
}

async function checkIndexes() {
    console.log('\n📊 CHECKING MONGODB INDEXES AND PERFORMANCE\n');

    const db = mongoose.connection.db;
    const collection = db.collection('articles');

    try {
        // 1. List all indexes on articles collection
        console.log('🔍 1. CURRENT INDEXES ON ARTICLES COLLECTION:');
        console.log('='.repeat(50));

        const indexes = await collection.listIndexes().toArray();
        indexes.forEach((index, i) => {
            console.log(`${i + 1}. ${index.name}:`);
            console.log(`   Keys: ${JSON.stringify(index.key)}`);
            if (index.textIndexVersion) console.log(`   Type: Text Index`);
            if (index.v) console.log(`   Version: ${index.v}`);
            if (index.background) console.log(`   Background: ${index.background}`);
            if (index.sparse) console.log(`   Sparse: ${index.sparse}`);
            console.log();
        });

        // 2. Check for vector search index specifically
        console.log('🤖 2. VECTOR SEARCH INDEX CHECK:');
        console.log('='.repeat(50));

        const vectorIndex = indexes.find(idx =>
            idx.name === 'articles_pca_index' ||
            idx.name.includes('embedding') ||
            idx.type === 'vectorSearch'
        );

        if (vectorIndex) {
            console.log('✅ Vector search index found:', vectorIndex.name);
            console.log('   Configuration:', JSON.stringify(vectorIndex, null, 2));
        } else {
            console.log('⚠️  No vector search index found. This may cause slow personalized queries.');
        }

        // 3. Check index usage stats
        console.log('\n📈 3. INDEX USAGE STATISTICS:');
        console.log('='.repeat(50));

        try {
            const stats = await collection.aggregate([
                { $indexStats: {} }
            ]).toArray();

            stats.forEach(stat => {
                console.log(`Index: ${stat.name}`);
                console.log(`  Accesses: ${stat.accesses.ops}`);
                console.log(`  Since: ${stat.accesses.since}`);
                console.log();
            });
        } catch (err) {
            console.log('ℹ️  Index stats not available (requires MongoDB 3.2+)');
        }

        // 4. Test query performance for common patterns
        console.log('⚡ 4. QUERY PERFORMANCE TESTS:');
        console.log('='.repeat(50));

        // Test 1: Basic language + publishedAt query (used by personalized-light)
        const testDate = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24 hours ago

        console.log('Test 1: Language + PublishedAt query (personalized-light pattern)');
        const start1 = Date.now();

        const explain1 = await collection.find({
            language: 'english',
            publishedAt: { $gte: testDate }
        }).limit(10).explain('executionStats');

        const duration1 = Date.now() - start1;
        console.log(`  Execution time: ${duration1}ms`);
        console.log(`  Documents examined: ${explain1.executionStats.totalDocsExamined}`);
        console.log(`  Documents returned: ${explain1.executionStats.totalDocsReturned}`);
        console.log(`  Index used: ${explain1.executionStats.executionStages.indexName || 'NONE (table scan!)'}`);

        // Test 2: Sort by publishedAt (common pattern)
        console.log('\nTest 2: Sort by publishedAt query');
        const start2 = Date.now();

        const explain2 = await collection.find({
            language: 'english'
        }).sort({ publishedAt: -1 }).limit(10).explain('executionStats');

        const duration2 = Date.now() - start2;
        console.log(`  Execution time: ${duration2}ms`);
        console.log(`  Documents examined: ${explain2.executionStats.totalDocsExamined}`);
        console.log(`  Documents returned: ${explain2.executionStats.totalDocsReturned}`);
        console.log(`  Index used: ${explain2.executionStats.executionStages.indexName || 'NONE (table scan!)'}`);

        // Test 3: Complex query with exclusions (personalized pattern)
        console.log('\nTest 3: Complex exclusion query (personalized pattern)');
        const start3 = Date.now();

        const explain3 = await collection.find({
            language: 'english',
            publishedAt: { $gte: testDate },
            _id: { $nin: [new mongoose.Types.ObjectId()] }
        }).limit(20).explain('executionStats');

        const duration3 = Date.now() - start3;
        console.log(`  Execution time: ${duration3}ms`);
        console.log(`  Documents examined: ${explain3.executionStats.totalDocsExamined}`);
        console.log(`  Documents returned: ${explain3.executionStats.totalDocsReturned}`);
        console.log(`  Index used: ${explain3.executionStats.executionStages.indexName || 'NONE (table scan!)'}`);

        // 5. Collection statistics
        console.log('\n📊 5. COLLECTION STATISTICS:');
        console.log('='.repeat(50));

        const collStats = await db.command({ collStats: 'articles' });
        console.log(`Total documents: ${collStats.count.toLocaleString()}`);
        console.log(`Average document size: ${Math.round(collStats.avgObjSize)} bytes`);
        console.log(`Total data size: ${Math.round(collStats.size / 1024 / 1024)} MB`);
        console.log(`Total index size: ${Math.round(collStats.totalIndexSize / 1024 / 1024)} MB`);

        // 6. Recommendations
        console.log('\n💡 6. INDEX RECOMMENDATIONS:');
        console.log('='.repeat(50));

        const hasLanguageIndex = indexes.some(idx => idx.key.language === 1);
        const hasPublishedAtIndex = indexes.some(idx => idx.key.publishedAt === 1 || idx.key.publishedAt === -1);
        const hasCompoundIndex = indexes.some(idx =>
            idx.key.language && idx.key.publishedAt
        );

        if (!hasLanguageIndex) {
            console.log('⚠️  Recommended: Create index on { language: 1 }');
        }

        if (!hasPublishedAtIndex) {
            console.log('⚠️  Recommended: Create index on { publishedAt: -1 }');
        }

        if (!hasCompoundIndex) {
            console.log('⚠️  Recommended: Create compound index on { language: 1, publishedAt: -1 }');
            console.log('   This would optimize your personalized-light queries significantly');
        }

        if (!vectorIndex) {
            console.log('⚠️  Critical: Create vector search index for embedding_pca field');
            console.log('   Index name: articles_pca_index');
            console.log('   Field: embedding_pca');
            console.log('   Type: vectorSearch');
        }

        if (collStats.count > 100000) {
            console.log('ℹ️  Large collection detected. Consider:');
            console.log('   - Archiving old articles');
            console.log('   - Using background index builds');
            console.log('   - Monitoring query performance regularly');
        }

    } catch (error) {
        console.error('❌ Error checking indexes:', error);
    }
}

async function createRecommendedIndexes() {
    console.log('\n🔧 CREATING RECOMMENDED INDEXES:');
    console.log('='.repeat(50));

    const collection = mongoose.connection.db.collection('articles');

    try {
        // Create compound index for personalized-light optimization
        console.log('Creating compound index: { language: 1, publishedAt: -1 }');
        await collection.createIndex(
            { language: 1, publishedAt: -1 },
            {
                name: 'language_publishedAt_compound',
                background: true
            }
        );
        console.log('✅ Compound index created');

        // Create index for viewCount sorting
        console.log('Creating index: { language: 1, viewCount: -1 }');
        await collection.createIndex(
            { language: 1, viewCount: -1 },
            {
                name: 'language_viewCount_compound',
                background: true
            }
        );
        console.log('✅ ViewCount index created');

        // Note: Vector search index must be created through Atlas UI
        console.log('\nℹ️  Vector search index must be created through MongoDB Atlas UI');
        console.log('   Go to Atlas → Collections → articles → Search Indexes');
        console.log('   Create Vector Search Index with:');
        console.log('   - Name: articles_pca_index');
        console.log('   - Field: embedding_pca');
        console.log('   - Dimensions: 128 (or your actual embedding size)');

    } catch (error) {
        console.error('❌ Error creating indexes:', error);
    }
}

async function main() {
    await connectDB();

    const action = process.argv[2];

    if (action === 'create-indexes') {
        await createRecommendedIndexes();
    } else {
        await checkIndexes();

        console.log('\n🔧 To create recommended indexes, run:');
        console.log('   node check-indexes.js create-indexes');
    }

    console.log('\n✅ Analysis complete');
    process.exit(0);
}

// Handle errors
process.on('unhandledRejection', (err) => {
    console.error('❌ Unhandled Promise Rejection:', err);
    process.exit(1);
});

main();
