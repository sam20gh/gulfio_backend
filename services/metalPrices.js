// services/metalPrices.js
//
// Fetches gold & silver from GoldAPI (in USD only — 2 calls) and upserts a
// single daily snapshot. Keeping GoldAPI to 2 calls/day (~60/month) stays well
// inside the 100-calls/month free tier.
//
// FX is NOT fetched here. Currency rates are owned by services/exchangeRates.js
// and shared: whichever job runs first pays for the single daily HTTP call and
// the other reads the stored snapshot. This service just picks the three Gulf
// currencies it needs out of that shared set.
const axios = require('axios');
const MetalPrice = require('../models/MetalPrice');
const { getRatesForToday, PEG_FALLBACK } = require('./exchangeRates');

const GOLDAPI_BASE = 'https://www.goldapi.io/api';
const GRAMS_PER_TROY_OUNCE = 31.1034768;
const REQUEST_TIMEOUT_MS = 15000;

/** MetalPrice.fxRates requires exactly these three and they must never be absent. */
const METAL_CURRENCIES = ['AED', 'SAR', 'QAR'];

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

/**
 * USD→Gulf currency rates, taken from the shared daily FX snapshot.
 *
 * Any currency missing from the snapshot falls back to its official peg —
 * accurate rather than approximate, since AED/SAR/QAR are all pegged to USD by
 * their central banks and do not float.
 */
async function fetchFxRates() {
    const snapshot = await getRatesForToday();
    const rates = {};
    for (const code of METAL_CURRENCIES) {
        rates[code] = snapshot.rates?.[code] ?? PEG_FALLBACK[code];
    }
    return {
        rates,
        source: snapshot.source,
        updatedAt: snapshot.providerUpdatedAt || snapshot.fetchedAt || new Date(),
    };
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
