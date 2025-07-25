/**
 * 📊 Update Engagement Scores for Existing Reels
 * 
 * Calculates and updates engagement scores for all reels based on:
 * - Likes, dislikes, view count
 * - Recency factor
 * - Engagement ratios
 */

const mongoose = require('mongoose');
const Reel = require('../models/Reel');
require('dotenv').config();

/**
 * Calculate engagement score for a reel
 */
function calculateEngagementScore(reel) {
    const likes = reel.likes || 0;
    const dislikes = reel.dislikes || 0;
    const views = reel.viewCount || 0;

    // Calculate ratios
    const likeRatio = views > 0 ? likes / views : 0;
    const dislikeRatio = views > 0 ? dislikes / views : 0;

    // Calculate recency score (newer content gets higher score)
    const recencyScore = getRecencyScore(reel.publishedAt || reel.createdAt);

    // Weighted engagement formula
    const baseScore = likes * 2 + views * 0.1 - dislikes * 0.5;
    const ratioBonus = (1 + likeRatio - dislikeRatio);

    return Math.max(0, baseScore * recencyScore * ratioBonus);
}

/**
 * Calculate recency score (exponential decay over 30 days)
 */
function getRecencyScore(publishedAt) {
    if (!publishedAt) return 0.5;

    const now = new Date();
    const daysDiff = (now - new Date(publishedAt)) / (1000 * 60 * 60 * 24);

    // Exponential decay over 30 days
    return Math.exp(-daysDiff / 30);
}

async function updateEngagementScores() {
    try {
        console.log('🚀 Starting engagement score update...');

        // Connect to MongoDB
        await mongoose.connect(process.env.MONGO_URI);
        console.log('✅ Connected to MongoDB');

        // Count total reels
        const totalReels = await Reel.countDocuments();
        console.log(`📊 Found ${totalReels} reels to process`);

        if (totalReels === 0) {
            console.log('⚠️ No reels found to update');
            return;
        }

        let updatedCount = 0;
        let skippedCount = 0;
        const batchSize = 100;

        // Process reels in batches
        for (let skip = 0; skip < totalReels; skip += batchSize) {
            console.log(`🔄 Processing batch ${Math.floor(skip / batchSize) + 1}/${Math.ceil(totalReels / batchSize)}`);

            const reels = await Reel.find({})
                .select('_id likes dislikes viewCount publishedAt createdAt engagement_score')
                .skip(skip)
                .limit(batchSize)
                .lean();

            const bulkOps = [];

            for (const reel of reels) {
                const newEngagementScore = calculateEngagementScore(reel);

                // Only update if score changed significantly or is first time
                if (Math.abs((reel.engagement_score || 0) - newEngagementScore) > 0.1) {
                    bulkOps.push({
                        updateOne: {
                            filter: { _id: reel._id },
                            update: { $set: { engagement_score: newEngagementScore } }
                        }
                    });
                    updatedCount++;
                } else {
                    skippedCount++;
                }
            }

            // Execute batch update
            if (bulkOps.length > 0) {
                await Reel.bulkWrite(bulkOps);
            }

            console.log(`📈 Batch complete: ${bulkOps.length} updates queued`);
        }

        console.log(`✅ Engagement score update completed:`);
        console.log(`   📊 Total reels processed: ${totalReels}`);
        console.log(`   ✨ Updated: ${updatedCount}`);
        console.log(`   ⏭️ Skipped (no change): ${skippedCount}`);

        // Verify some samples
        const topEngagement = await Reel.find({ engagement_score: { $gt: 0 } })
            .sort({ engagement_score: -1 })
            .limit(5)
            .select('_id engagement_score likes dislikes viewCount publishedAt')
            .lean();

        if (topEngagement.length > 0) {
            console.log('\n🏆 Top 5 engagement scores:');
            topEngagement.forEach((reel, index) => {
                console.log(`   ${index + 1}. Score: ${reel.engagement_score.toFixed(2)} | Likes: ${reel.likes} | Views: ${reel.viewCount}`);
            });
        }

    } catch (error) {
        console.error('❌ Error updating engagement scores:', error);
    } finally {
        await mongoose.disconnect();
        console.log('👋 Disconnected from MongoDB');
    }
}

// Run the script
if (require.main === module) {
    updateEngagementScores().then(() => {
        console.log('🎉 Engagement score update completed');
        process.exit(0);
    }).catch(error => {
        console.error('💥 Script failed:', error);
        process.exit(1);
    });
}

module.exports = { updateEngagementScores, calculateEngagementScore };
