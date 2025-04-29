const mongoose = require('mongoose');

const engagementSummarySchema = new mongoose.Schema({
    date: { type: String, required: true, unique: true }, // e.g., '2025-04-29'
    view: { type: Number, default: 0 },
    like: { type: Number, default: 0 },
    dislike: { type: Number, default: 0 },
    save: { type: Number, default: 0 },
    unsave: { type: Number, default: 0 },
    follow: { type: Number, default: 0 },
    read_time_avg: { type: Number, default: 0 }, // average in seconds
});

module.exports = mongoose.model('EngagementSummary', engagementSummarySchema);
