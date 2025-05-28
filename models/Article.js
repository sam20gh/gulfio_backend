const mongoose = require('mongoose');

const ArticleSchema = new mongoose.Schema({
    title: { type: String, required: true },
    content: String,
    url: String,
    sourceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Source' },
    category: String,
    publishedAt: Date,
    image: {
        type: [String],
        default: []
    },
    viewCount: { type: Number, default: 0 },
    likes: { type: Number, default: 0 },
    dislikes: { type: Number, default: 0 },
    likedBy: [{ type: String }],      // Supabase user ID or email
    dislikedBy: [{ type: String }],
    language: { type: String, default: 'english' },
});


module.exports = mongoose.model('Article', ArticleSchema);
