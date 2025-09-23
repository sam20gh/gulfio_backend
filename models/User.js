const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    supabase_id: { type: String, unique: true, required: true },
    email: { type: String, required: true },
    name: { type: String },
    avatar_url: { type: String }, // legacy field
    profile_image: { type: String }, // ✅ NEW
    gender: { type: String, enum: ['Male', 'Female', 'Other', ''] }, // ✅ NEW
    dob: { type: Date }, // ✅ NEW
    type: { type: String, enum: ['admin', 'publisher', 'user', ''], default: 'user' }, // ✅ NEW
    publisher_group: [{ type: String }], // ✅ NEW - Publisher groups (e.g., 'gulf news', 'arab news')
    pushToken: { type: String },
    liked_articles: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Article' }],
    disliked_articles: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Article' }],
    viewed_articles: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Article' }],
    saved_articles: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Article' }],
    following_sources: [{ type: String }],
    following_users: [{ type: String }],
    blocked_users: [{ type: String }],
    // User.js (update schema)
    liked_reels: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Reel' }],
    disliked_reels: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Reel' }],
    saved_reels: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Reel' }],
    viewed_reels: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Reel' }],

    embedding: {
        type: [Number],
        default: [],
    },
    embedding_pca: {
        type: [Number],
        default: [],
    },
    disliked_categories: [{ type: String }],
    notificationSettings: {
        type: mongoose.Schema.Types.Mixed,
        default: {
            newsNotifications: true,
            userNotifications: true,
            breakingNews: true,
            weeklyDigest: false,
            followedSources: true,
            articleLikes: true,
            newFollowers: true,
            mentions: true,
        }
    },
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);

