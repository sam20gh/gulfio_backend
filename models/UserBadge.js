const mongoose = require('mongoose');

const userBadgeSchema = new mongoose.Schema({
    userId: { type: String, required: true, index: true }, // Supabase ID
    badgeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Badge', required: true },
    earnedAt: { type: Date, default: Date.now },
    isDisplayed: { type: Boolean, default: false }, // For profile showcase (max 3)
    notified: { type: Boolean, default: false } // Push notification sent
}, { timestamps: true });

// Compound unique index - user can only earn each badge once
userBadgeSchema.index({ userId: 1, badgeId: 1 }, { unique: true });

// Index for queries
userBadgeSchema.index({ earnedAt: -1 });
userBadgeSchema.index({ userId: 1, isDisplayed: 1 });

module.exports = mongoose.model('UserBadge', userBadgeSchema);
