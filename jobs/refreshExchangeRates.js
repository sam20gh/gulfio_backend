/**
 * Daily Exchange Rates Refresh Job
 *
 * Pulls the full USD→everything rate set once per day and stores a snapshot.
 * The upstream provider is free and keyless but rate limits by IP with a
 * 20-minute 429 ban, so this job:
 *   1. Runs on a fixed daily schedule (1 HTTP call/day).
 *   2. On server startup, ONLY fetches if today's snapshot is missing — Cloud
 *      Run restarts often, and an unguarded boot-fetch could get our egress IP
 *      banned and take the feature down for every user at once.
 *
 * Scheduled slightly ahead of the metals job so the shared FX snapshot is
 * already in Mongo when metals goes looking for it — that way one HTTP call
 * feeds both features.
 */
const cron = require('node-cron');
const { fetchAndStoreExchangeRates, hasTodaySnapshot } = require('../services/exchangeRates');

// 04:55 UTC daily — after the provider's ~00:00 UTC recalculation, and five
// minutes before the metals job at 05:00 UTC.
const SCHEDULE = '55 4 * * *';

async function refreshIfNeeded(reason) {
    try {
        if (await hasTodaySnapshot()) {
            console.log(`ℹ️ [FX] Snapshot for today already exists — skipping ${reason} fetch.`);
            return;
        }
        console.log(`⏰ [FX] Refreshing exchange rates (${reason})...`);
        await fetchAndStoreExchangeRates();
    } catch (err) {
        console.error(`❌ [FX] Refresh failed (${reason}):`, err.message);
    }
}

function startExchangeRatesJob() {
    const job = cron.schedule(SCHEDULE, () => refreshIfNeeded('scheduled'));
    console.log('🚀 Exchange rates refresh job started (runs daily at 04:55 UTC)');

    // Catch-up on startup, but only if we don't already have today's data.
    setTimeout(() => refreshIfNeeded('startup'), 5000);

    return job;
}

module.exports = { startExchangeRatesJob, refreshIfNeeded };
