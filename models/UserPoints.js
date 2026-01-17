const mongoose = require('mongoose');

const userPointsSchema = new mongoose.Schema({
    userId: { type: String, required: true, unique: true, index: true }, // Supabase ID
    totalPoints: { type: Number, default: 0 },
    lifetimePoints: { type: Number, default: 0 }, // Never decreases (for lifetime badges)
    level: { type: Number, default: 1 },
    streak: {
        current: { type: Number, default: 0 },
        longest: { type: Number, default: 0 },
        lastActivityDate: { type: Date }
    },
    stats: {
        articlesRead: { type: Number, default: 0 },
        articlesLiked: { type: Number, default: 0 },
        commentsPosted: { type: Number, default: 0 },
        commentsLiked: { type: Number, default: 0 }, // Comments user received likes on
        sharesCompleted: { type: Number, default: 0 },
        reelsWatched: { type: Number, default: 0 },
        dailyLogins: { type: Number, default: 0 },
        referrals: { type: Number, default: 0 }
    },
    categoryStats: {
        type: Map,
        of: Number,
        default: {} // e.g., { "football": 45, "business": 12 }
    },
    weeklyProgress: {
        startDate: { type: Date },
        articlesRead: { type: Number, default: 0 },
        challengeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Challenge' }
    }
}, { timestamps: true });

// Indexes for leaderboards and queries
userPointsSchema.index({ totalPoints: -1 });
userPointsSchema.index({ lifetimePoints: -1 });
userPointsSchema.index({ level: -1 });
userPointsSchema.index({ 'streak.current': -1 });
userPointsSchema.index({ 'streak.longest': -1 });

module.exports = mongoose.model('UserPoints', userPointsSchema);
