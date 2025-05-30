const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    supabase_id: { type: String, unique: true, required: true },
    email: { type: String, required: true },
    name: { type: String },
    avatar_url: { type: String }, // legacy field
    profile_image: { type: String }, // ✅ NEW
    gender: { type: String, enum: ['Male', 'Female', 'Other', ''] }, // ✅ NEW
    dob: { type: Date }, // ✅ NEW
    pushToken: { type: String },
    liked_articles: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Article' }],
    disliked_articles: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Article' }],
    viewed_articles: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Article' }],
    saved_articles: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Article' }],
    following_sources: [{ type: String }],
    following_users: [{ type: String }],
    blocked_users: [{ type: String }],
    embedding: {
        type: [Number],
        default: [],
    },
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);

