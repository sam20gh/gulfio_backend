const mongoose = require('mongoose');

const ArticleSchema = new mongoose.Schema({
    title: { type: String, required: true },
    content: String,
    contentFormat: {
        type: String,
        enum: ['text', 'markdown'],
        default: 'text' // Default to 'text' for backward compatibility with existing 24k+ articles
    },
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

    // Phase 3.3: Breaking News Support
    isBreakingNews: { type: Boolean, default: false },
    breakingNewsExpiry: { type: Date }, // Auto-expire breaking status after set duration
    breakingNewsPriority: { type: Number, default: 0 }, // Higher = more urgent (0-10)
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

// Add index for breaking news queries (Phase 3.3)
ArticleSchema.index({ isBreakingNews: 1, publishedAt: -1 });

module.exports = mongoose.model('Article', ArticleSchema);
