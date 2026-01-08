/**
 * Performance Analysis Script
 * Analyzes MongoDB collection stats and identifies bottlenecks
 */

const mongoose = require('mongoose');
require('dotenv').config();

async function analyze() {
    const uri = process.env.MONGO_URI;
    if (!uri) {
        console.error('❌ MONGO_URI not found in .env');
        process.exit(1);
    }

    console.log('🔗 Connecting to MongoDB...');
    await mongoose.connect(uri);
    const db = mongoose.connection.db;

    // Check collection stats
    console.log('\n📊 ARTICLES COLLECTION STATS:');
    console.log('='.repeat(50));
    const stats = await db.command({ collStats: 'articles' });
    console.log('  Total docs:', stats.count);
    console.log('  Size:', Math.round(stats.size / 1024 / 1024), 'MB');
    console.log('  Index size:', Math.round(stats.totalIndexSize / 1024 / 1024), 'MB');
    console.log('  Avg doc size:', Math.round(stats.avgObjSize / 1024), 'KB');

    // Check for embedding field distribution
    console.log('\n📈 EMBEDDING STATUS:');
    console.log('='.repeat(50));
    const withEmbedding = await db.collection('articles').countDocuments({
        embedding: { $exists: true, $ne: null }
    });
    const withoutEmbedding = await db.collection('articles').countDocuments({
        embedding: { $exists: false }
    });
    const nullEmbedding = await db.collection('articles').countDocuments({
        embedding: null
    });
    console.log('  With embedding:', withEmbedding);
    console.log('  Without embedding field:', withoutEmbedding);
    console.log('  Null embedding:', nullEmbedding);

    // Check sourceGroupName distribution
    console.log('\n📰 TOP SOURCE GROUPS:');
    console.log('='.repeat(50));
    const sourceGroups = await db.collection('articles').aggregate([
        { $group: { _id: '$sourceGroupName', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 }
    ]).toArray();
    sourceGroups.forEach(s => console.log('  ', s._id || '(null)', ':', s.count));

    // Check existing indexes
    console.log('\n📑 INDEX ANALYSIS:');
    console.log('='.repeat(50));
    const indexes = await db.collection('articles').indexes();

    const hasSourceGroupIndex = indexes.some(i => Object.keys(i.key).includes('sourceGroupName'));
    const hasEmbeddingIndex = indexes.some(i => Object.keys(i.key).includes('embedding'));
    const hasLanguageSourceGroupIndex = indexes.some(i => {
        const keys = Object.keys(i.key);
        return keys.includes('language') && keys.includes('sourceGroupName');
    });

    console.log('  sourceGroupName index:', hasSourceGroupIndex ? '✅ EXISTS' : '❌ MISSING');
    console.log('  embedding index:', hasEmbeddingIndex ? '✅ EXISTS' : '❌ MISSING');
    console.log('  language+sourceGroupName compound:', hasLanguageSourceGroupIndex ? '✅ EXISTS' : '❌ MISSING');

    // Check useractivities stats
    console.log('\n📊 USER ACTIVITIES STATS:');
    console.log('='.repeat(50));
    try {
        const actStats = await db.command({ collStats: 'useractivities' });
        console.log('  Total docs:', actStats.count);
        console.log('  Size:', Math.round(actStats.size / 1024 / 1024), 'MB');

        const actIndexes = await db.collection('useractivities').indexes();
        console.log('  Indexes:', actIndexes.length);
        const hasUserIdIndex = actIndexes.some(i => Object.keys(i.key).includes('userId'));
        const hasUserArticleIndex = actIndexes.some(i => {
            const keys = Object.keys(i.key);
            return keys.includes('userId') && keys.includes('articleId');
        });
        console.log('  userId index:', hasUserIdIndex ? '✅ EXISTS' : '❌ MISSING');
        console.log('  userId+articleId compound:', hasUserArticleIndex ? '✅ EXISTS' : '❌ MISSING');
    } catch (e) {
        console.log('  Error:', e.message);
    }

    // Check userprofiles stats
    console.log('\n📊 USER PROFILES STATS:');
    console.log('='.repeat(50));
    try {
        const profileStats = await db.command({ collStats: 'userprofiles' });
        console.log('  Total docs:', profileStats.count);
        console.log('  Size:', Math.round(profileStats.size / 1024 / 1024), 'MB');
    } catch (e) {
        console.log('  Error:', e.message);
    }

    // Identify missing recommended indexes based on query patterns
    console.log('\n🔧 RECOMMENDED INDEXES TO CREATE:');
    console.log('='.repeat(50));

    const recommendations = [];

    if (!hasSourceGroupIndex) {
        recommendations.push({
            name: 'sourceGroupName_1_publishedAt_-1',
            keys: { sourceGroupName: 1, publishedAt: -1 },
            reason: 'Query: source diversity filtering in personalized feed'
        });
    }

    if (!hasEmbeddingIndex) {
        recommendations.push({
            name: 'embedding_exists_partial',
            keys: { embedding: 1 },
            options: { partialFilterExpression: { embedding: { $exists: true } } },
            reason: 'Query: embedding existence checks (2.88 min total exec time)'
        });
    }

    if (!hasLanguageSourceGroupIndex) {
        recommendations.push({
            name: 'language_1_sourceGroupName_1_publishedAt_-1',
            keys: { language: 1, sourceGroupName: 1, publishedAt: -1 },
            reason: 'Query: personalized feed with source diversity'
        });
    }

    if (recommendations.length === 0) {
        console.log('  ✅ All recommended indexes exist');
    } else {
        recommendations.forEach((r, i) => {
            console.log(`\n  ${i + 1}. ${r.name}`);
            console.log(`     Keys: ${JSON.stringify(r.keys)}`);
            console.log(`     Reason: ${r.reason}`);
        });
    }

    await mongoose.disconnect();
    console.log('\n✅ Analysis complete');
}

analyze().catch(err => {
    console.error('❌ Error:', err.message);
    process.exit(1);
});
