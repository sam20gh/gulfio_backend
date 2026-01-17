const mongoose = require('mongoose');

const badgeSchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true },
    nameAr: { type: String }, // Arabic name
    description: { type: String, required: true },
    descriptionAr: { type: String },
    icon: { type: String, required: true }, // Icon name (e.g., 'book-open', 'fire', 'trophy')
    color: { type: String, default: '#FFD700' }, // Badge accent color
    category: { 
        type: String, 
        enum: ['engagement', 'reading', 'social', 'streak', 'special', 'category_expert'],
        required: true 
    },
    tier: { 
        type: String, 
        enum: ['bronze', 'silver', 'gold', 'platinum', 'diamond'],
        default: 'bronze'
    },
    requirement: {
        type: { 
            type: String, 
            enum: [
                'articles_read', 'articles_liked', 'comments_posted', 
                'comments_liked', 'shares', 'streak_days', 'total_points',
                'daily_logins', 'category_articles', 'referrals', 'level'
            ],
            required: true 
        },
        value: { type: Number, required: true }, // Threshold to unlock
        category: { type: String } // For category-specific badges (e.g., "football")
    },
    pointsAwarded: { type: Number, default: 0 }, // Bonus points for earning badge
    isActive: { type: Boolean, default: true },
    rarity: { type: Number, default: 100 }, // Percentage of users who have it (updated daily)
    sortOrder: { type: Number, default: 0 } // For display ordering
}, { timestamps: true });

// Indexes
badgeSchema.index({ category: 1, tier: 1 });
badgeSchema.index({ isActive: 1 });
badgeSchema.index({ 'requirement.type': 1 });

module.exports = mongoose.model('Badge', badgeSchema);
