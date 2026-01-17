const mongoose = require('mongoose');

const pointTransactionSchema = new mongoose.Schema({
    userId: { type: String, required: true, index: true },
    points: { type: Number, required: true }, // Can be negative for redemptions
    action: {
        type: String,
        enum: [
            'article_read', 'article_read_full', 'article_like', 'article_share', 'article_save',
            'comment_post', 'comment_received_like', 'comment_quality_bonus',
            'reel_watch', 'reel_like', 'reel_share',
            'daily_login', 'streak_bonus', 'weekly_challenge',
            'badge_earned', 'referral_signup', 'referral_active', 'profile_complete',
            'redemption' // For spending points on premium features
        ],
        required: true
    },
    metadata: {
        articleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Article' },
        reelId: { type: mongoose.Schema.Types.ObjectId, ref: 'Reel' },
        commentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Comment' },
        badgeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Badge' },
        category: { type: String },
        streakDay: { type: Number },
        description: { type: String }
    }
}, { timestamps: true });

// Indexes for queries
pointTransactionSchema.index({ userId: 1, createdAt: -1 });
pointTransactionSchema.index({ action: 1, createdAt: -1 });
pointTransactionSchema.index({ createdAt: -1 });

// TTL index - auto-delete after 6 months (180 days)
pointTransactionSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 180 });

module.exports = mongoose.model('PointTransaction', pointTransactionSchema);
