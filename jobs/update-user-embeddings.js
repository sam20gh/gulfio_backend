/**
 * Background Job: Update User Embeddings
 * 
 * PHASE 2.1: Periodic User Embedding Updates
 * - Runs daily at 2 AM UTC via Cloud Scheduler
 * - Updates User.embedding_pca for active users based on UserActivity
 * - Reduces inline embedding calculation overhead
 * - Keeps pre-calculated embeddings fresh
 * 
 * PERFORMANCE IMPACT:
 * - Eliminates slow embedding updates during user actions (500ms → 0ms)
 * - Processes all activities (views, likes, dislikes, saves) in batch
 * - Maintains 10x performance improvement for active users
 * - Reduced response times for /article/:id/like, /article/:id/save, etc.
 * 
 * SCHEDULING:
 * gcloud scheduler jobs create http update-user-embeddings \
 *   --schedule="0 2 * * *" \
 *   --uri="https://your-backend-url/api/jobs/update-user-embeddings" \
 *   --http-method=POST \
 *   --headers="x-api-key=YOUR_ADMIN_API_KEY" \
 *   --time-zone="UTC"
 */

const mongoose = require('mongoose');
const User = require('../models/User');
const { updateUserProfileEmbedding } = require('../utils/userEmbedding');

/**
 * Update embeddings for active users
 * Active = users with activity in the last 7 days (from UserActivity collection)
 */
async function updateActiveUserEmbeddings() {
    const startTime = Date.now();
    console.log(`🚀 Starting user embedding update job at ${new Date().toISOString()}`);

    try {
        // Find active users from UserActivity collection
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

        const UserActivity = require('../models/UserActivity');

        // Get unique user IDs with recent activity
        const activeUserIds = await UserActivity.aggregate([
            {
                $match: {
                    timestamp: { $gte: sevenDaysAgo },
                    eventType: { $in: ['view', 'like', 'dislike', 'save', 'read_time'] }
                }
            },
            {
                $group: {
                    _id: '$userId' // Supabase UUID
                }
            },
            { $limit: 1000 } // Process max 1000 users per run
        ]);

        const userIds = activeUserIds.map(doc => doc._id);
        console.log(`📊 Found ${userIds.length} active users (from UserActivity) to process`);

        if (userIds.length === 0) {
            console.log('✅ No active users to process');
            return {
                success: true,
                processed: 0,
                updated: 0,
                skipped: 0,
                failed: 0,
                duration: Date.now() - startTime
            };
        }

        // Process users in batches
        const BATCH_SIZE = 25; // Reduced batch size for article embedding (more expensive)
        let processed = 0;
        let updated = 0;
        let skipped = 0;
        let failed = 0;

        for (let i = 0; i < userIds.length; i += BATCH_SIZE) {
            const batch = userIds.slice(i, i + BATCH_SIZE);
            console.log(`\n📦 Processing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(userIds.length / BATCH_SIZE)} (${batch.length} users)`);

            const results = await Promise.allSettled(
                batch.map(async (userId) => {
                    try {
                        // Use userEmbedding utility which handles both User arrays and UserActivity
                        await updateUserProfileEmbedding(userId);
                        updated++;
                        return { userId: userId.substring(0, 8), status: 'updated' };
                    } catch (error) {
                        // Check if it's a "no activities" scenario vs real error
                        if (error.message.includes('No activities') || error.message.includes('User not found')) {
                            skipped++;
                            return { userId: userId.substring(0, 8), status: 'skipped', reason: error.message };
                        }

                        failed++;
                        console.error(`❌ Failed to update user ${userId.substring(0, 8)}:`, error.message);
                        return { userId: userId.substring(0, 8), status: 'failed', error: error.message };
                    }
                })
            );

            processed += batch.length;
            console.log(`✅ Batch complete: ${updated} updated, ${skipped} skipped, ${failed} failed`);

            // Delay between batches to avoid overwhelming DeepSeek API and database
            if (i + BATCH_SIZE < userIds.length) {
                await new Promise(resolve => setTimeout(resolve, 2000)); // 2 second delay
            }
        }

        const duration = Date.now() - startTime;
        const result = {
            success: true,
            processed,
            updated,
            skipped,
            failed,
            duration,
            usersPerSecond: (processed / (duration / 1000)).toFixed(2)
        };

        console.log(`\n✅ User embedding update complete!`);
        console.log(`📊 Stats:`, result);

        return result;
    } catch (error) {
        console.error('❌ Error in updateActiveUserEmbeddings:', error);
        return {
            success: false,
            error: error.message,
            duration: Date.now() - startTime
        };
    }
}

module.exports = {
    updateActiveUserEmbeddings
};
