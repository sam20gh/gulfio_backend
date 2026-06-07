// models/MetalPrice.js
//
// One snapshot per calendar day of gold & silver prices (in USD) plus the live
// USD→Gulf-currency FX rates used to convert them. Storing one document per day
// (keyed by `date`) keeps a cheap price history for trends/sparklines and makes
// the daily refresh idempotent — the cron upserts the same day's doc rather than
// piling up rows. Metals are stored in USD; the app converts to AED/SAR/QAR
// client-side using `fxRates`, so a user can switch currency without a refetch.
const mongoose = require('mongoose');

const MetalQuoteSchema = new mongoose.Schema(
    {
        ouncePriceUsd: { type: Number, required: true }, // USD per troy ounce
        gramUsd: {
            '24k': { type: Number, required: true },
            '22k': { type: Number, required: true },
            '21k': { type: Number, required: true },
            '18k': { type: Number, required: true },
        },
        changeUsd: { type: Number, default: 0 }, // 24h change, USD/oz
        changePercent: { type: Number, default: 0 }, // 24h change, %
    },
    { _id: false }
);

const MetalPriceSchema = new mongoose.Schema({
    // 'YYYY-MM-DD' (UTC) — one snapshot per day.
    date: { type: String, required: true, unique: true, index: true },
    gold: { type: MetalQuoteSchema, required: true },
    silver: { type: MetalQuoteSchema, required: true },
    // Live USD→currency rates (1 USD = N units). USD is implicitly 1.
    fxRates: {
        AED: { type: Number, required: true },
        SAR: { type: Number, required: true },
        QAR: { type: Number, required: true },
    },
    fxSource: { type: String, default: 'open.er-api.com' },
    fxUpdatedAt: { type: Date },
    metalSource: { type: String, default: 'goldapi.io' },
    fetchedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('MetalPrice', MetalPriceSchema);
