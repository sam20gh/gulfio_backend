const mongoose = require('mongoose');

const teamSchema = new mongoose.Schema({
    apiId: { type: Number, required: true, unique: true, index: true }, // ID from API-Sports.io
    name: { type: String, required: true },
    logo: { type: String }, // Logo URL
    country: { type: String },
    founded: { type: Number },
    venueId: { type: Number },
    venueName: { type: String },
    venueCity: { type: String },
    venueCapacity: { type: Number },
    // For display in search
    code: { type: String }, // Team short code (e.g., "MUN", "ARS")
    national: { type: Boolean, default: false }, // Is national team
}, { timestamps: true });

// Index for text search
teamSchema.index({ name: 'text', country: 'text' });

// Index for efficient lookups
teamSchema.index({ name: 1 });
teamSchema.index({ country: 1 });

module.exports = mongoose.model('Team', teamSchema);
