const mongoose = require('mongoose');

const AdRevenueEventSchema = new mongoose.Schema({
    ts: { type: Date, default: Date.now },
    adUnitId: { type: String, required: true },
    articleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Article', required: true },
    sourceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Source', required: true },
    sourceName: { type: String, required: true },
    value: { type: Number, required: true }, // Revenue in micro-units
    currency: { type: String, required: true },
    precision: { type: Number, required: true }, // AdMob precision type
    platform: { type: String, enum: ['android', 'ios'], required: true },
});

// Indexes for efficient aggregation
AdRevenueEventSchema.index({ sourceId: 1, ts: -1 });
AdRevenueEventSchema.index({ articleId: 1, ts: -1 });
AdRevenueEventSchema.index({ ts: -1 });
AdRevenueEventSchema.index({ adUnitId: 1 });

// Optional: Unique index to prevent duplicate impressions
// AdRevenueEventSchema.index({ adUnitId: 1, articleId: 1, sourceId: 1, ts: 1 }, { unique: true });

module.exports = mongoose.model('AdRevenueEvent', AdRevenueEventSchema);
