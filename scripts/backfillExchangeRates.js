/**
 * Backfill daily FX snapshots from the free dated currency-api endpoints.
 *
 * Our primary provider (open.er-api.com) sells historical data on paid tiers
 * only, so a freshly deployed ExchangeRate collection has a single day in it and
 * the history chart stays empty for months. The jsdelivr-hosted currency-api,
 * however, publishes an immutable snapshot per date at
 *   .../@fawazahmed0/currency-api@YYYY-MM-DD/v1/currencies/usd.min.json
 * for free, with no key and no rate limit. This script walks backwards through
 * those dates and fills the gap, so the chart is useful the day we ship rather
 * than one quarter later.
 *
 * Safe to re-run: existing dates are skipped unless --overwrite is passed, and
 * a backfilled document is never allowed to clobber a live-fetched one.
 *
 * Usage:
 *   node scripts/backfillExchangeRates.js                 # last 90 days
 *   node scripts/backfillExchangeRates.js --days=365
 *   node scripts/backfillExchangeRates.js --days=30 --dry-run
 *   node scripts/backfillExchangeRates.js --overwrite      # redo backfilled days
 */

const mongoose = require('mongoose');
const axios = require('axios');
require('dotenv').config();

const BASE = 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api';
const SOURCE = 'jsdelivr/currency-api (backfill)';
const REQUEST_TIMEOUT_MS = 20000;
/** Be polite to the CDN — this is a free service doing us a favour. */
const DELAY_MS = 120;
const MIN_CURRENCIES = 50;

const args = process.argv.slice(2);
const flag = (name, fallback) => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.split('=')[1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

const DAYS = Math.max(1, Math.min(parseInt(flag('days', '90'), 10) || 90, 1825));
const DRY_RUN = has('dry-run');
const OVERWRITE = has('overwrite');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 'YYYY-MM-DD' for N days before today, in UTC. */
function dateKeyDaysAgo(n) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().slice(0, 10);
}

function sanitise(rates) {
    const clean = {};
    for (const [code, value] of Object.entries(rates)) {
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
            clean[code.toUpperCase()] = value;
        }
    }
    clean.USD = 1;
    return clean;
}

/** One dated snapshot, or null if that date isn't published (weekends/gaps). */
async function fetchDated(date) {
    const url = `${BASE}@${date}/v1/currencies/usd.min.json`;
    try {
        const { data } = await axios.get(url, { timeout: REQUEST_TIMEOUT_MS });
        const raw = data?.usd;
        if (!raw || Object.keys(raw).length < MIN_CURRENCIES) return null;
        const rates = sanitise(raw);
        // Guard against a partial payload losing the pairs the app depends on.
        if (!rates.AED || !rates.INR) return null;
        return { rates, date: data.date || date };
    } catch {
        return null;
    }
}

async function backfillExchangeRates() {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to Mongo');

    const ExchangeRate = require('../models/ExchangeRate');

    // Skip dates we already hold. Live-fetched documents are always preserved;
    // --overwrite only refreshes days we previously backfilled ourselves.
    const existing = await ExchangeRate.find().select('date source').lean();
    const skip = new Set(
        existing
            .filter((d) => !OVERWRITE || d.source !== SOURCE)
            .map((d) => d.date)
    );
    console.log(
        `📊 ${existing.length} snapshots already stored; ${skip.size} dates will be skipped`
    );

    // Day 0 is today — leave it to the live cron so we never overwrite a real
    // same-day fetch with a CDN copy that may lag.
    const targets = [];
    for (let i = 1; i <= DAYS; i++) {
        const key = dateKeyDaysAgo(i);
        if (!skip.has(key)) targets.push(key);
    }

    console.log(
        `🎯 ${targets.length} dates to fetch (last ${DAYS} days)${DRY_RUN ? ' — DRY RUN' : ''}`
    );

    let written = 0;
    let missing = 0;

    for (const date of targets) {
        const snapshot = await fetchDated(date);

        if (!snapshot) {
            missing++;
            process.stdout.write('·');
            await sleep(DELAY_MS);
            continue;
        }

        if (!DRY_RUN) {
            await ExchangeRate.findOneAndUpdate(
                { date },
                {
                    $set: {
                        base: 'USD',
                        rates: snapshot.rates,
                        source: SOURCE,
                        providerUpdatedAt: new Date(`${date}T00:00:00Z`),
                        fetchedAt: new Date(),
                    },
                },
                { upsert: true, new: true, setDefaultsOnInsert: true }
            );
        }

        written++;
        process.stdout.write('.');
        if (written % 60 === 0) process.stdout.write(`  ${written}\n`);
        await sleep(DELAY_MS);
    }

    console.log(
        `\n\n✅ Backfill complete — ${written} snapshots ${DRY_RUN ? 'would be written' : 'written'}, ${missing} dates unavailable upstream`
    );

    const total = await ExchangeRate.countDocuments();
    const oldest = await ExchangeRate.findOne().sort({ date: 1 }).select('date').lean();
    const newest = await ExchangeRate.findOne().sort({ date: -1 }).select('date').lean();
    console.log(`📈 Collection now holds ${total} days: ${oldest?.date} → ${newest?.date}`);

    await mongoose.disconnect();
}

backfillExchangeRates().catch(async (err) => {
    console.error('❌ Backfill failed:', err.message);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
});
