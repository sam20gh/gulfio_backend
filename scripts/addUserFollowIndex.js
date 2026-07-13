/**
 * Add the `following_users` index to the users collection.
 *
 * Why: the dashboard-summary endpoint counts a user's followers with
 *   User.countDocuments({ following_users: <id> })
 * Without this index that is a full collection scan of the users collection on
 * every cache miss — the main backend cause of slow dashboard loads.
 *
 * Safety:
 *  - Idempotent: skips if the index already exists (createIndex is a no-op when
 *    an identical index is present; error codes 85/86 are also tolerated).
 *  - Non-destructive: only ADDS an index, never drops anything.
 *  - Background/hybrid build: on MongoDB 4.2+ all builds yield to live traffic,
 *    so this is safe to run against production.
 *
 * Run: node scripts/addUserFollowIndex.js   (or: npm run add-user-follow-index)
 */

const mongoose = require('mongoose');
require('dotenv').config();

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;

if (!MONGO_URI) {
    console.error('❌ MONGO_URI not found in environment variables');
    process.exit(1);
}

const INDEX_SPEC = { following_users: 1 };
const INDEX_NAME = 'following_users_1';

async function addUserFollowIndex() {
    console.log('🔌 Connecting to MongoDB...');
    await mongoose.connect(MONGO_URI, {
        serverSelectionTimeoutMS: 10000,
        connectTimeoutMS: 10000,
    });
    console.log('✅ Connected');

    const users = mongoose.connection.db.collection('users');

    const before = await users.indexes();
    console.log(`\n📊 users collection currently has ${before.length} indexes.`);

    if (before.some((idx) => idx.name === INDEX_NAME)) {
        console.log(`⏭️  Index "${INDEX_NAME}" already exists — nothing to do.`);
    } else {
        console.log(`🔨 Creating "${INDEX_NAME}" (${JSON.stringify(INDEX_SPEC)})...`);
        try {
            await users.createIndex(INDEX_SPEC, { name: INDEX_NAME, background: true });
            console.log(`✅ Created "${INDEX_NAME}".`);
        } catch (error) {
            // 85 = IndexOptionsConflict, 86 = IndexKeySpecsConflict — an
            // equivalent index already exists under a different definition/name.
            if (error.code === 85 || error.code === 86) {
                console.log(`⏭️  An equivalent index already exists (code ${error.code}) — skipping.`);
            } else {
                throw error;
            }
        }
    }

    const after = await users.indexes();
    console.log('\n👤 users collection indexes:');
    after.forEach((idx) => console.log(`   - ${idx.name}: ${JSON.stringify(idx.key)}`));

    console.log('\n💡 Index builds on MongoDB 4.2+ run as hybrid (background) builds');
    console.log('   and yield to live traffic. Check progress in Atlas if the');
    console.log('   users collection is large.');
}

if (require.main === module) {
    addUserFollowIndex()
        .then(async () => {
            await mongoose.disconnect();
            console.log('\n🔌 Disconnected. Done.');
            process.exit(0);
        })
        .catch(async (error) => {
            console.error('\n💥 Failed to add index:', error);
            await mongoose.disconnect().catch(() => { });
            process.exit(1);
        });
}

module.exports = { addUserFollowIndex };
