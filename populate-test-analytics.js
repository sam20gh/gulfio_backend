/**
 * Test Script: Populate Sample Video Analytics Data
 * 
 * This script populates sample analytics data to test the video analytics dashboard.
 * Run with: node populate-test-analytics.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Reel = require('./models/Reel');
const UserActivity = require('./models/UserActivity');

async function populateTestData() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('✅ Connected to MongoDB');

        // Get some existing reels (prioritize recent ones)
        const reels = await Reel.find().sort({ scrapedAt: -1 }).limit(20).lean();

        if (reels.length === 0) {
            console.error('❌ No reels found in database!');
            process.exit(1);
        }

        console.log(`📊 Found ${reels.length} reels to populate with analytics`);

        let reelsUpdated = 0;
        let activitiesCreated = 0;

        for (const reel of reels) {
            // Generate random analytics data
            const numViews = Math.floor(Math.random() * 50) + 10; // 10-60 views
            const completionRates = [];

            for (let i = 0; i < numViews; i++) {
                // Generate completion rates (30-100%)
                const completionRate = Math.floor(Math.random() * 70) + 30;
                completionRates.push(completionRate);

                // Generate watch duration (15-120 seconds)
                const duration = Math.floor(Math.random() * 105) + 15;

                // Create UserActivity record
                const activity = new UserActivity({
                    userId: `test_user_${Math.floor(Math.random() * 20)}`,
                    eventType: 'view',
                    articleId: reel._id,
                    duration: duration,
                    timestamp: new Date(Date.now() - Math.random() * 7 * 24 * 60 * 60 * 1000) // Last 7 days
                });

                await activity.save();
                activitiesCreated++;
            }

            // Calculate averages
            const avgCompletionRate = completionRates.reduce((sum, rate) => sum + rate, 0) / completionRates.length;
            const totalWatchTime = completionRates.length * 45000; // ~45 seconds average in ms
            const avgWatchTime = totalWatchTime / completionRates.length;

            // Update Reel with analytics and update scrapedAt to be recent
            await Reel.findByIdAndUpdate(reel._id, {
                $set: {
                    completionRates: completionRates,
                    completionRate: avgCompletionRate,
                    totalWatchTime: totalWatchTime,
                    avgWatchTime: avgWatchTime,
                    viewCount: numViews,
                    scrapedAt: new Date(Date.now() - Math.random() * 7 * 24 * 60 * 60 * 1000) // Within last 7 days
                }
            });

            reelsUpdated++;
            console.log(`✅ Updated reel ${reel._id}: ${numViews} views, ${avgCompletionRate.toFixed(1)}% completion, ${(avgWatchTime / 1000).toFixed(1)}s avg watch`);
        }

        console.log('\n🎉 Test data populated successfully!');
        console.log(`   - ${reelsUpdated} reels updated`);
        console.log(`   - ${activitiesCreated} UserActivity records created`);
        console.log('\n📊 Now refresh the admin dashboard to see analytics!');

        await mongoose.disconnect();
        process.exit(0);

    } catch (error) {
        console.error('❌ Error populating test data:', error);
        process.exit(1);
    }
}

populateTestData();
