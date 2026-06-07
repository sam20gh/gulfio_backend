// services/metalPrices.js
//
// Fetches gold & silver from GoldAPI (in USD only — 2 calls) plus live daily
// USD→AED/SAR/QAR rates from a free, keyless FX API, and upserts a single daily
// snapshot. Keeping GoldAPI to 2 calls/day (~60/month) stays well inside the
// 100-calls/month free tier, while the FX API supplies genuinely live rates
// (not the fixed peg).
const axios = require('axios');
const MetalPrice = require('../models/MetalPrice');

const GOLDAPI_BASE = 'https://www.goldapi.io/api';
const FX_URL = 'https://open.er-api.com/v6/latest/USD';
const GRAMS_PER_TROY_OUNCE = 31.1034768;
const REQUEST_TIMEOUT_MS = 15000;

/** Hard-peg fallbacks, used only if the live FX API is unreachable. */
const FX_FALLBACK = { AED: 3.6725, SAR: 3.75, QAR: 3.64 };

/** UTC date key, 'YYYY-MM-DD'. */
function todayKey(d = new Date()) {
    return d.toISOString().slice(0, 10);
}

/** Fetch one metal in USD and normalise to the stored quote shape. */
async function fetchMetalUsd(metal) {
    const key = process.env.GOLDAPI_KEY;
    if (!key) throw new Error('GOLDAPI_KEY is not configured');

    const { data } = await axios.get(`${GOLDAPI_BASE}/${metal}/USD`, {
        timeout: REQUEST_TIMEOUT_MS,
        headers: { 'x-access-token': key, 'Content-Type': 'application/json' },
    });

    if (!data || typeof data.price !== 'number') {
        throw new Error(`GoldAPI ${metal} returned no price`);
    }

    const pureGram = data.price_gram_24k ?? data.price / GRAMS_PER_TROY_OUNCE;
    return {
        ouncePriceUsd: data.price,
        gramUsd: {
            '24k': data.price_gram_24k ?? pureGram,
            '22k': data.price_gram_22k ?? pureGram * (22 / 24),
            '21k': data.price_gram_21k ?? pureGram * (21 / 24),
            '18k': data.price_gram_18k ?? pureGram * (18 / 24),
        },
        changeUsd: data.ch ?? 0,
        changePercent: data.chp ?? 0,
    };
}

/** Live USD→Gulf currency rates; falls back to pegs if the FX API fails. */
async function fetchFxRates() {
    try {
        const { data } = await axios.get(FX_URL, { timeout: REQUEST_TIMEOUT_MS });
        const rates = data && data.rates;
        if (data?.result === 'success' && rates && rates.AED && rates.SAR && rates.QAR) {
            return {
                rates: { AED: rates.AED, SAR: rates.SAR, QAR: rates.QAR },
                source: 'open.er-api.com',
                updatedAt: data.time_last_update_unix
                    ? new Date(data.time_last_update_unix * 1000)
                    : new Date(),
            };
        }
        throw new Error('FX API returned unexpected payload');
    } catch (err) {
        console.warn('⚠️ [Metals] FX API failed, using peg fallback:', err.message);
        return { rates: { ...FX_FALLBACK }, source: 'peg-fallback', updatedAt: new Date() };
    }
}

/**
 * Fetch fresh prices and upsert today's snapshot.
 * @returns {Promise<MetalPrice>} the stored document
 */
async function fetchAndStoreMetalPrices() {
    const [gold, silver, fx] = await Promise.all([
        fetchMetalUsd('XAU'),
        fetchMetalUsd('XAG'),
        fetchFxRates(),
    ]);

    const date = todayKey();
    const doc = await MetalPrice.findOneAndUpdate(
        { date },
        {
            $set: {
                gold,
                silver,
                fxRates: fx.rates,
                fxSource: fx.source,
                fxUpdatedAt: fx.updatedAt,
                metalSource: 'goldapi.io',
                fetchedAt: new Date(),
            },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    console.log(
        `✅ [Metals] Stored ${date}: gold $${gold.ouncePriceUsd}/oz, silver $${silver.ouncePriceUsd}/oz (FX ${fx.source})`
    );
    return doc;
}

/** Latest stored snapshot (no network call). */
async function getLatestMetalPrices() {
    return MetalPrice.findOne().sort({ date: -1 }).lean();
}

/** True if today's snapshot already exists (guards against refetching on every restart). */
async function hasTodaySnapshot() {
    const existing = await MetalPrice.findOne({ date: todayKey() }).select('_id').lean();
    return !!existing;
}

module.exports = {
    fetchAndStoreMetalPrices,
    getLatestMetalPrices,
    hasTodaySnapshot,
    todayKey,
};
