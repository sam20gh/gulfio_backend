/**
 * Auto-expire Breaking News Job (Phase 3.3)
 *
 * Automatically removes breaking news status from articles that have expired.
 * Runs every hour to check for expired breaking news.
 */

const cron = require('node-cron');
const Article = require('../models/Article');

/**
 * Expire breaking news articles that have passed their expiry time
 * @returns {Object} { expired: number, error: string }
 */
async function expireBreakingNews() {
    try {
        const now = new Date();

        console.log('🔍 Checking for expired breaking news articles...');

        // Find articles with expired breaking news status
        const result = await Article.updateMany(
            {
                isBreakingNews: true,
                breakingNewsExpiry: { $exists: true, $ne: null, $lt: now },
            },
            {
                $set: {
                    isBreakingNews: false,
                    breakingNewsPriority: 0,
                },
            }
        );

        if (result.modifiedCount > 0) {
            console.log(`✅ Expired ${result.modifiedCount} breaking news article(s)`);
        } else {
            console.log('ℹ️ No expired breaking news articles found');
        }

        return {
            expired: result.modifiedCount,
            checkedAt: now.toISOString(),
        };
    } catch (error) {
        console.error('❌ Error expiring breaking news:', error);
        return {
            expired: 0,
            error: error.message,
        };
    }
}

/**
 * Start the cron job
 * Runs every hour at minute 0 (e.g., 1:00, 2:00, 3:00)
 */
function startBreakingNewsExpiryJob() {
    // Run every hour at minute 0
    const job = cron.schedule('0 * * * *', async () => {
        console.log('⏰ Running breaking news expiry job...');
        await expireBreakingNews();
    });

    console.log('🚀 Breaking news expiry job started (runs hourly)');

    // Also run once immediately on startup
    setTimeout(() => {
        console.log('🔄 Running initial breaking news expiry check...');
        expireBreakingNews();
    }, 5000); // Wait 5 seconds after server start

    return job;
}

module.exports = {
    expireBreakingNews,
    startBreakingNewsExpiryJob,
};
