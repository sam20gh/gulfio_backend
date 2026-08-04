// models/ExchangeRate.js
//
// One snapshot per calendar day of USD→everything FX rates (~166 currencies).
//
// Why one document per day rather than a rolling "latest" doc:
//   1. The upstream free feed refreshes once every 24h, so anything finer is
//      wasted storage for identical numbers.
//   2. It makes the daily refresh idempotent — the cron upserts the same day's
//      doc instead of piling up rows on every Cloud Run restart.
//   3. It hands us a free price history. The provider charges for historical
//      endpoints; by keeping our own daily snapshots we own a growing archive
//      at zero cost, which is what feeds the 30-day trend chart.
//
// Everything is stored against a USD base. Any-to-any conversion is derived
// client-side as a cross-rate (to / from), so switching currencies in the
// converter needs no network call.
const mongoose = require('mongoose');

const ExchangeRateSchema = new mongoose.Schema({
    // 'YYYY-MM-DD' (UTC) — one snapshot per day.
    date: { type: String, required: true, unique: true, index: true },

    // Always 'USD'. Stored explicitly so a future base change is detectable
    // rather than silently reinterpreting old documents.
    base: { type: String, required: true, default: 'USD' },

    // { AED: 3.6725, INR: 95.4, ... } — 1 USD = N units. Mixed rather than a
    // fixed shape because the provider's currency list changes over time and we
    // never want a new ISO code to fail validation and lose the whole snapshot.
    rates: { type: mongoose.Schema.Types.Mixed, required: true },

    // Which provider actually answered — primary, fallback, or peg emergency.
    source: { type: String, required: true },

    // When the provider says the rates were last recalculated (not when we
    // fetched them). Used to show an honest "as of" timestamp in the app.
    providerUpdatedAt: { type: Date },

    fetchedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('ExchangeRate', ExchangeRateSchema);
