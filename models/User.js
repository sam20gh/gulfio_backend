const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    supabase_id: { type: String, unique: true, required: true },
    email: { type: String, required: true },
    name: { type: String },
    avatar_url: { type: String },
    liked_articles: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Article' }],
    saved_articles: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Article' }],
    following_sources: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Source' }],
    following_users: [{ type: String }], // supabase_id of followed users
    blocked_users: [{ type: String }], // supabase_id of blocked users
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);
