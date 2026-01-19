/**
 * 🎮 Migration Script: Populate UserPoints from Existing User Activity
 * 
 * This script retroactively creates UserPoints records for all users based on:
 * - liked_articles, saved_articles, viewed_articles
 * - liked_reels, saved_reels, viewed_reels
 * - Comments posted
 * 
 * Run with: node scripts/migrate-user-points.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const UserPoints = require('../models/UserPoints');
const Comment = require('../models/Comment');
const pointsConfig = require('../utils/pointsConfig');

const POINTS = pointsConfig.POINTS;

// Calculate level from points
function calculateLevel(points) {
    const levels = pointsConfig.LEVELS;
    for (let i = levels.length - 1; i >= 0; i--) {
        if (points >= levels[i].pointsRequired) {
            return levels[i].level;
        }
    }
    return 1;
}

async function migrateUserPoints() {
    console.log('🎮 UserPoints Migration Script');
    console.log('================================');

    try {
        // Connect to MongoDB
        console.log('\n🔌 Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGO_URI);
        console.log('✅ Connected to MongoDB');

        // Get all users
        console.log('\n📋 Fetching all users...');
        const users = await User.find({}).lean();
        console.log(`📊 Found ${users.length} users to process`);

        let created = 0;
        let updated = 0;
        let skipped = 0;
        let errors = 0;

        for (let i = 0; i < users.length; i++) {
            const user = users[i];
            const userId = user.supabase_id;

            if (!userId) {
                console.log(`  ⚠️ Skipping user without supabase_id: ${user._id}`);
                skipped++;
                continue;
            }

            try {
                // Calculate stats from existing data
                const articlesLiked = (user.liked_articles || []).length;
                const articlesRead = (user.viewed_articles || []).length;
                const articlesSaved = (user.saved_articles || []).length;
                const reelsWatched = (user.viewed_reels || []).length;
                const reelsLiked = (user.liked_reels || []).length;
                const reelsSaved = (user.saved_reels || []).length;

                // Count comments by this user
                const commentsPosted = await Comment.countDocuments({ userId: userId });

                // Calculate points retroactively
                let totalPoints = 0;
                totalPoints += articlesRead * POINTS.ARTICLE_READ;
                totalPoints += articlesLiked * POINTS.ARTICLE_LIKE;
                totalPoints += articlesSaved * POINTS.ARTICLE_SAVE;
                totalPoints += reelsWatched * POINTS.REEL_WATCH;
                totalPoints += reelsLiked * POINTS.REEL_LIKE;
                totalPoints += commentsPosted * POINTS.COMMENT_POST;

                // Calculate level
                const level = calculateLevel(totalPoints);

                // Check if UserPoints already exists
                const existingUserPoints = await UserPoints.findOne({ userId });

                if (existingUserPoints) {
                    // Update existing record if new calculated points are higher
                    if (totalPoints > existingUserPoints.totalPoints) {
                        existingUserPoints.totalPoints = totalPoints;
                        existingUserPoints.lifetimePoints = Math.max(existingUserPoints.lifetimePoints, totalPoints);
                        existingUserPoints.level = level;
                        existingUserPoints.stats.articlesRead = Math.max(existingUserPoints.stats.articlesRead, articlesRead);
                        existingUserPoints.stats.articlesLiked = Math.max(existingUserPoints.stats.articlesLiked, articlesLiked);
                        existingUserPoints.stats.commentsPosted = Math.max(existingUserPoints.stats.commentsPosted, commentsPosted);
                        existingUserPoints.stats.reelsWatched = Math.max(existingUserPoints.stats.reelsWatched, reelsWatched);
                        await existingUserPoints.save();
                        updated++;
                        console.log(`  📝 Updated: ${userId} - ${totalPoints} pts (level ${level})`);
                    } else {
                        skipped++;
                    }
                } else {
                    // Create new UserPoints record
                    await UserPoints.create({
                        userId,
                        totalPoints,
                        lifetimePoints: totalPoints,
                        level,
                        streak: {
                            current: 0,
                            longest: 0,
                            lastActivityDate: user.updatedAt || new Date()
                        },
                        stats: {
                            articlesRead,
                            articlesLiked,
                            articlesSaved,
                            commentsPosted,
                            commentsLiked: 0,
                            sharesCompleted: 0,
                            reelsWatched,
                            dailyLogins: 0,
                            referrals: 0
                        }
                    });
                    created++;
                    console.log(`  ✅ Created: ${userId} - ${totalPoints} pts (level ${level})`);
                }

                // Progress indicator
                if ((i + 1) % 100 === 0) {
                    console.log(`\n📊 Progress: ${i + 1}/${users.length} users processed...`);
                }

            } catch (userError) {
                console.error(`  ❌ Error processing user ${userId}:`, userError.message);
                errors++;
            }
        }

        // Summary
        console.log('\n================================');
        console.log('📊 Migration Summary:');
        console.log(`  ✅ Created: ${created}`);
        console.log(`  📝 Updated: ${updated}`);
        console.log(`  ⏭️  Skipped: ${skipped}`);
        console.log(`  ❌ Errors: ${errors}`);
        console.log('================================');

        // Verify final count
        const totalUserPoints = await UserPoints.countDocuments();
        console.log(`\n📈 Total UserPoints records: ${totalUserPoints}`);

        // Show top 10 users by points
        console.log('\n🏆 Top 10 Users by Points:');
        const topUsers = await UserPoints.find()
            .sort({ totalPoints: -1 })
            .limit(10)
            .lean();

        topUsers.forEach((up, index) => {
            console.log(`  ${index + 1}. ${up.userId.substring(0, 12)}... - ${up.totalPoints} pts (Level ${up.level})`);
        });

    } catch (error) {
        console.error('❌ Migration failed:', error);
        process.exit(1);
    } finally {
        await mongoose.disconnect();
        console.log('\n🔌 Disconnected from MongoDB');
    }
}

// Run migration
migrateUserPoints().then(() => {
    console.log('\n✅ Migration completed successfully!');
    process.exit(0);
}).catch(err => {
    console.error('❌ Migration failed:', err);
    process.exit(1);
});
