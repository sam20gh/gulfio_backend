const mongoose = require('mongoose');

const ArticleSchema = new mongoose.Schema({
    title: { type: String, required: true },
    content: String,
    url: { type: String, unique: true, sparse: true }, // Add unique constraint for URLs
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
    embedding: {
        type: [Number],
        default: [],
    },
    embedding_pca: {
        type: [Number],
        default: [],
    },
    relatedIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Article' }],
});

// Add compound index for title + sourceId to prevent duplicate titles from same source
ArticleSchema.index({ title: 1, sourceId: 1 }, { unique: true });

// Add index for URL lookups (already unique but helps with query performance)
ArticleSchema.index({ url: 1 });

// Add index for publishedAt for sorting recent articles
ArticleSchema.index({ publishedAt: -1 });

// Add index for category filtering
ArticleSchema.index({ category: 1 });

// Add index for sourceId filtering
ArticleSchema.index({ sourceId: 1 });


module.exports = mongoose.model('Article', ArticleSchema);
