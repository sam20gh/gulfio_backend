const mongoose = require('mongoose');

const SourceSchema = new mongoose.Schema({
    name: String,
    groupName: String, // 🆕 Group sources under a common name
    url: String,
    baseUrl: { type: String },
    type: { type: String, default: 'website' }, // e.g., website, instagram, youtube
    category: String,
    frequency: String,
    listSelector: String,
    linkSelector: String,
    titleSelector: String,
    imageSelector: String,
    contentSelector: String,
    // Optional data-driven config for AJAX/JSON-rendered listings (see scraper
    // "API-listing adapter"). When set, links are discovered via this endpoint instead
    // of DOM selectors. Mixed so the shape can evolve without schema churn.
    listApi: { type: mongoose.Schema.Types.Mixed, default: null },
    icon: String,
    lastScraped: Date,
    followers: { type: Number, default: 0 },
    instagramUsername: { type: String, default: null },
    youtubeChannelId: { type: String, default: null },// e.g., .story-element.story-element-text p
    language: { type: String, default: "english" },
    bioSection: { type: String, default: null },
    bioLink: { type: String, default: null },
    status: { type: String, enum: ['active', 'suspended', 'blocked'], default: 'active' },
    articleType: { type: String, enum: ['mainPage', 'subPage', 'both'], default: 'mainPage' },
    // Rev-share fields for AdMob revenue tracking
    revSharePercent: { type: Number, default: 70 }, // Default 70% to source
    payoutCurrency: { type: String, default: 'USD' },

    // P3-5: aggregate quality signal in [0, 1]. 1.0 = neutral (default,
    // no data yet); lower = more reliably disliked relative to liked.
    // Computed periodically from articles published in the last 30 days:
    // quality = 1 - dislikes/(likes+dislikes+SMOOTHING). Smoothing
    // prevents brand-new sources with few interactions from being
    // penalized as outliers. Scorer multiplies the article's score by
    // this so low-quality scrapers self-demote.
    quality_score: { type: Number, default: 1.0, min: 0, max: 1 },
    quality_score_updated_at: { type: Date, default: null },
});

module.exports = mongoose.model('Source', SourceSchema);
