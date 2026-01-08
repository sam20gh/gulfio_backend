/**
 * Performance Monitoring Utility
 * 
 * Use this script to monitor and diagnose performance issues.
 * Run: node scripts/monitor-performance.js
 */

const mongoose = require('mongoose');
require('dotenv').config();

async function monitorPerformance() {
    const uri = process.env.MONGO_URI;
    if (!uri) {
        console.error('❌ MONGO_URI not found');
        process.exit(1);
    }

    console.log('🔗 Connecting to MongoDB...');
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
    const db = mongoose.connection.db;
    const admin = db.admin();

    console.log('\n' + '='.repeat(70));
    console.log('📊 PERFORMANCE MONITORING REPORT');
    console.log('='.repeat(70));
    console.log(`Generated at: ${new Date().toISOString()}`);

    // 1. Server Status
    console.log('\n📈 SERVER STATUS:');
    console.log('-'.repeat(50));
    try {
        const serverStatus = await admin.serverStatus();
        console.log(`  Uptime: ${Math.round(serverStatus.uptime / 3600)} hours`);
        console.log(`  Current connections: ${serverStatus.connections?.current || 'N/A'}`);
        console.log(`  Available connections: ${serverStatus.connections?.available || 'N/A'}`);

        if (serverStatus.opcounters) {
            console.log('\n  Operations (total):');
            console.log(`    Insert: ${serverStatus.opcounters.insert}`);
            console.log(`    Query: ${serverStatus.opcounters.query}`);
            console.log(`    Update: ${serverStatus.opcounters.update}`);
            console.log(`    Delete: ${serverStatus.opcounters.delete}`);
        }
    } catch (err) {
        console.log(`  ⚠️ Could not get server status: ${err.message}`);
    }

    // 2. Collection Stats
    console.log('\n📊 COLLECTION STATISTICS:');
    console.log('-'.repeat(50));

    const collections = ['articles', 'users', 'useractivities', 'sources', 'reels'];
    for (const collName of collections) {
        try {
            const stats = await db.command({ collStats: collName });
            console.log(`\n  ${collName}:`);
            console.log(`    Documents: ${stats.count?.toLocaleString() || 'N/A'}`);
            console.log(`    Size: ${Math.round((stats.size || 0) / 1024 / 1024)} MB`);
            console.log(`    Index size: ${Math.round((stats.totalIndexSize || 0) / 1024 / 1024)} MB`);
            console.log(`    Avg doc size: ${Math.round((stats.avgObjSize || 0) / 1024)} KB`);
            console.log(`    Index count: ${stats.nindexes || 'N/A'}`);
        } catch (err) {
            console.log(`  ${collName}: ⚠️ ${err.message}`);
        }
    }

    // 3. Index Analysis
    console.log('\n📑 INDEX ANALYSIS (articles):');
    console.log('-'.repeat(50));
    try {
        const indexes = await db.collection('articles').indexes();

        // Critical indexes we need
        const criticalIndexes = {
            'language_sourceGroupName_publishedAt': false,
            'sourceGroupName_1': false,
            'embedding_partial': false,
            'embedding_pca_partial': false
        };

        for (const idx of indexes) {
            const keys = Object.keys(idx.key);

            // Check for sourceGroupName
            if (keys.includes('sourceGroupName')) {
                if (keys.includes('language')) {
                    criticalIndexes['language_sourceGroupName_publishedAt'] = true;
                } else {
                    criticalIndexes['sourceGroupName_1'] = true;
                }
            }

            // Check for embedding indexes
            if (idx.name?.includes('embedding') && idx.partialFilterExpression) {
                if (keys.includes('embedding_pca')) {
                    criticalIndexes['embedding_pca_partial'] = true;
                } else if (keys.includes('embedding')) {
                    criticalIndexes['embedding_partial'] = true;
                }
            }
        }

        console.log('  Critical indexes status:');
        for (const [name, exists] of Object.entries(criticalIndexes)) {
            console.log(`    ${exists ? '✅' : '❌'} ${name}`);
        }

        const missingIndexes = Object.entries(criticalIndexes)
            .filter(([_, exists]) => !exists)
            .map(([name]) => name);

        if (missingIndexes.length > 0) {
            console.log('\n  ⚠️ MISSING INDEXES - Run: node scripts/create-performance-indexes.js');
        }

    } catch (err) {
        console.log(`  ⚠️ Could not analyze indexes: ${err.message}`);
    }

    // 4. Recent Slow Queries (if profiling is enabled)
    console.log('\n🐢 SLOW QUERY PATTERNS TO WATCH:');
    console.log('-'.repeat(50));
    console.log('  Based on MongoDB Atlas Query Profiler:');
    console.log('  1. sourceId: {$in: [...]} - Ensure sourceId_1 index exists');
    console.log('  2. embedding: {$exists: true} - Needs partial index');
    console.log('  3. $vectorSearch operations - Check Atlas Search index');
    console.log('  4. $lookup to sources - Use sourceCache.js for caching');

    // 5. Recommendations
    console.log('\n💡 PERFORMANCE RECOMMENDATIONS:');
    console.log('-'.repeat(50));
    console.log('  1. Create missing indexes: node scripts/create-performance-indexes.js');
    console.log('  2. Use source caching: require("./utils/sourceCache").enrichArticlesWithSources()');
    console.log('  3. Avoid .populate() - use aggregation with $lookup or sourceCache');
    console.log('  4. Use estimatedDocumentCount() instead of countDocuments() for totals');
    console.log('  5. Cache common queries with Redis (TTL: 5-15 minutes)');
    console.log('  6. Limit $vectorSearch numCandidates to reduce scan time');

    await mongoose.disconnect();
    console.log('\n✅ Monitoring complete');
}

monitorPerformance().catch(err => {
    console.error('❌ Error:', err.message);
    process.exit(1);
});
