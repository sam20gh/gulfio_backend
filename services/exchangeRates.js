// services/exchangeRates.js
//
// Daily USD→everything FX rates, stored as one snapshot per day.
//
// Cost model: $0/month. Both providers are keyless and free; we make exactly
// one HTTP call per day and every feature (currency converter, gold/silver
// conversion) reads the same stored snapshot. Nothing here needs a secret, so
// there is no new env var to add to Cloud Run.
//
// Provider chain, in order:
//   1. open.er-api.com  — ExchangeRate-API's open-access endpoint. 166
//      currencies, refreshes ~00:00 UTC. Rate limited *by IP* with a 20-minute
//      429 ban, which is precisely why only the backend may call it — never the
//      app. One call a day is nowhere near the limit.
//   2. cdn.jsdelivr.net currency-api — CDN-hosted, unlimited, 338 currencies.
//      Different infrastructure and a different data pipeline, so it is a
//      genuine fallback rather than a second door to the same outage.
//   3. Hard-peg emergency values — Gulf currencies only. Enough to keep the
//      metals feature converting; the converter marks the snapshot degraded.
//
// Attribution to exchangerate-api.com is REQUIRED by the open-access terms and
// is rendered in the app's price screen footer.
const axios = require('axios');
const ExchangeRate = require('../models/ExchangeRate');

const PRIMARY_URL = 'https://open.er-api.com/v6/latest/USD';
const FALLBACK_URL =
    'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.min.json';
const REQUEST_TIMEOUT_MS = 15000;

/**
 * Emergency values, used only when both providers are unreachable.
 *
 * These are the official USD pegs, not market rates. AED/SAR/QAR/BHD/OMR are
 * pegged by their central banks and genuinely do not move, so falling back to
 * them is accurate rather than approximate — but the snapshot is still flagged
 * `peg-fallback` so the app can hide non-Gulf conversions it cannot honour.
 */
const PEG_FALLBACK = { AED: 3.6725, SAR: 3.75, QAR: 3.64, BHD: 0.376, OMR: 0.3845, USD: 1 };

/**
 * A response is only trusted if it carries a broad currency list *and* the
 * currencies this app actually depends on. A provider returning a handful of
 * ECB majors (no AED, no PKR) is worse than useless for a Gulf audience, so we
 * reject it and fall through rather than storing a snapshot that silently
 * breaks the remittance pairs.
 */
const MIN_CURRENCIES = 50;
const REQUIRED_CURRENCIES = ['AED', 'SAR', 'INR'];

function isUsableRateSet(rates) {
    if (!rates || typeof rates !== 'object') return false;
    if (Object.keys(rates).length < MIN_CURRENCIES) return false;
    return REQUIRED_CURRENCIES.every((c) => typeof rates[c] === 'number' && rates[c] > 0);
}

/** UTC date key, 'YYYY-MM-DD'. */
function todayKey(d = new Date()) {
    return d.toISOString().slice(0, 10);
}

/** Drop non-numeric/non-positive entries so one bad key can't poison a conversion. */
function sanitise(rates) {
    const clean = {};
    for (const [code, value] of Object.entries(rates)) {
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
            clean[code.toUpperCase()] = value;
        }
    }
    clean.USD = 1; // base is implicit upstream; make it explicit for the client
    return clean;
}

async function fetchFromPrimary() {
    const { data } = await axios.get(PRIMARY_URL, { timeout: REQUEST_TIMEOUT_MS });
    if (data?.result !== 'success' || !isUsableRateSet(data.rates)) {
        throw new Error('open.er-api.com returned an unusable payload');
    }
    return {
        rates: sanitise(data.rates),
        source: 'open.er-api.com',
        providerUpdatedAt: data.time_last_update_unix
            ? new Date(data.time_last_update_unix * 1000)
            : new Date(),
    };
}

async function fetchFromFallback() {
    const { data } = await axios.get(FALLBACK_URL, { timeout: REQUEST_TIMEOUT_MS });
    // Shape: { date: '2026-08-04', usd: { aed: 3.6725, ... } } — lowercase keys.
    const raw = data?.usd;
    const upper = raw
        ? Object.fromEntries(Object.entries(raw).map(([k, v]) => [k.toUpperCase(), v]))
        : null;
    if (!isUsableRateSet(upper)) {
        throw new Error('currency-api returned an unusable payload');
    }
    return {
        rates: sanitise(upper),
        source: 'jsdelivr/currency-api',
        providerUpdatedAt: data.date ? new Date(`${data.date}T00:00:00Z`) : new Date(),
    };
}

/**
 * Live rates from the first provider that answers with a usable payload.
 * Never throws — the peg fallback always yields something the metals feature
 * can convert with.
 */
async function fetchLiveRates() {
    try {
        return await fetchFromPrimary();
    } catch (err) {
        console.warn('⚠️ [FX] Primary provider failed:', err.message);
    }

    try {
        const result = await fetchFromFallback();
        console.log('ℹ️ [FX] Served by fallback provider.');
        return result;
    } catch (err) {
        console.warn('⚠️ [FX] Fallback provider failed:', err.message);
    }

    console.error('❌ [FX] All providers failed — using hard pegs.');
    return { rates: { ...PEG_FALLBACK }, source: 'peg-fallback', providerUpdatedAt: new Date() };
}

/**
 * Fetch fresh rates and upsert today's snapshot.
 *
 * A peg-fallback result is never allowed to overwrite a real snapshot that
 * already exists for today — a transient provider outage during a restart must
 * not degrade good data we already hold.
 */
async function fetchAndStoreExchangeRates() {
    const live = await fetchLiveRates();
    const date = todayKey();

    if (live.source === 'peg-fallback') {
        const existing = await ExchangeRate.findOne({ date }).lean();
        if (existing && existing.source !== 'peg-fallback') {
            console.warn('⚠️ [FX] Keeping existing good snapshot instead of peg fallback.');
            return existing;
        }
    }

    const doc = await ExchangeRate.findOneAndUpdate(
        { date },
        {
            $set: {
                base: 'USD',
                rates: live.rates,
                source: live.source,
                providerUpdatedAt: live.providerUpdatedAt,
                fetchedAt: new Date(),
            },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    console.log(
        `✅ [FX] Stored ${date}: ${Object.keys(live.rates).length} currencies (${live.source})`
    );
    return doc;
}

/** Latest stored snapshot (no network call). */
async function getLatestExchangeRates() {
    return ExchangeRate.findOne().sort({ date: -1 }).lean();
}

/** True if today's snapshot already exists. */
async function hasTodaySnapshot() {
    const existing = await ExchangeRate.findOne({ date: todayKey() }).select('_id').lean();
    return !!existing;
}

/**
 * Today's rates, fetching only if we don't already have them.
 *
 * This is the seam that lets the metals service share our single daily HTTP
 * call: whichever job runs first pays for the fetch, the second reads it back
 * out of Mongo. Falls back to the most recent snapshot of any age before
 * resorting to pegs, since yesterday's real rates beat a hardcoded guess.
 */
async function getRatesForToday() {
    const today = await ExchangeRate.findOne({ date: todayKey() }).lean();
    if (today && today.source !== 'peg-fallback') return today;

    try {
        return await fetchAndStoreExchangeRates();
    } catch (err) {
        console.warn('⚠️ [FX] getRatesForToday fetch failed:', err.message);
        const latest = await getLatestExchangeRates();
        if (latest) return latest;
        return {
            date: todayKey(),
            base: 'USD',
            rates: { ...PEG_FALLBACK },
            source: 'peg-fallback',
            providerUpdatedAt: new Date(),
        };
    }
}

module.exports = {
    fetchLiveRates,
    fetchAndStoreExchangeRates,
    getLatestExchangeRates,
    getRatesForToday,
    hasTodaySnapshot,
    todayKey,
    PEG_FALLBACK,
};
