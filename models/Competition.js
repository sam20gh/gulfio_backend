const mongoose = require('mongoose');

const competitionSchema = new mongoose.Schema({
    apiId: { type: Number, required: true, unique: true, index: true }, // ID from API-Sports.io
    name: { type: String, required: true },
    type: { type: String, enum: ['League', 'Cup', 'Super_cup'], default: 'League' },
    logo: { type: String }, // Competition logo URL
    country: { type: String },
    countryCode: { type: String },
    countryFlag: { type: String }, // Country flag URL
    currentSeason: { type: Number }, // Current season year (e.g., 2024)
    seasonStart: { type: Date },
    seasonEnd: { type: Date },
    // Additional metadata
    standings: { type: Boolean, default: false }, // Has standings data
    rounds: { type: String }, // Current round (e.g., "Regular Season - 15")
}, { timestamps: true });

// Index for text search
competitionSchema.index({ name: 'text', country: 'text' });

// Index for efficient lookups
competitionSchema.index({ name: 1 });
competitionSchema.index({ country: 1 });
competitionSchema.index({ type: 1 });

module.exports = mongoose.model('Competition', competitionSchema);
