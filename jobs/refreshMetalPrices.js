/**
 * Daily Metal Prices Refresh Job
 *
 * Pulls gold/silver (USD) + live FX once per day and stores a snapshot. Because
 * GoldAPI's free tier allows only ~100 calls/month, this job:
 *   1. Runs on a fixed daily schedule (2 GoldAPI calls = ~60/month).
 *   2. On server startup, ONLY fetches if today's snapshot is missing — Cloud
 *      Run can restart often, and an unguarded boot-fetch would quickly exhaust
 *      the monthly quota.
 */
const cron = require('node-cron');
const { fetchAndStoreMetalPrices, hasTodaySnapshot } = require('../services/metalPrices');

// 05:00 UTC daily (~09:00 Gulf Standard Time).
const SCHEDULE = '0 5 * * *';

async function refreshIfNeeded(reason) {
    try {
        if (await hasTodaySnapshot()) {
            console.log(`ℹ️ [Metals] Snapshot for today already exists — skipping ${reason} fetch.`);
            return;
        }
        console.log(`⏰ [Metals] Refreshing prices (${reason})...`);
        await fetchAndStoreMetalPrices();
    } catch (err) {
        console.error(`❌ [Metals] Refresh failed (${reason}):`, err.message);
    }
}

function startMetalPricesJob() {
    const job = cron.schedule(SCHEDULE, () => refreshIfNeeded('scheduled'));
    console.log('🚀 Metal prices refresh job started (runs daily at 05:00 UTC)');

    // Catch-up on startup, but only if we don't already have today's data.
    setTimeout(() => refreshIfNeeded('startup'), 8000);

    return job;
}

module.exports = { startMetalPricesJob, refreshIfNeeded };
