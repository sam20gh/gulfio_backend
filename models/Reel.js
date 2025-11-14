const mongoose = require('mongoose');
const { Schema } = mongoose;

const ReelSchema = new Schema({
    source: { type: Schema.Types.ObjectId, ref: 'Source', required: true },
    reelId: { type: String, required: true },
    videoUrl: { type: String, required: true },
    thumbnailUrl: { type: String, default: null }, // Video thumbnail URL
    scrapedAt: { type: Date, default: Date.now },
    publishedAt: { type: Date, default: null }, // Added this field
    caption: { type: String, default: null },
    // Social features:
    likes: { type: Number, default: 0 },
    likedBy: [{ type: String, default: [] }],
    dislikes: { type: Number, default: 0 },
    dislikedBy: [{ type: String, default: [] }],
    viewCount: { type: Number, default: 0 },
    viewedBy: [{ type: String, default: [] }],
    saves: { type: Number, default: 0 },
    savedBy: [{ type: String, default: [] }],
    embedding: {
        type: [Number],
        default: [],
    },
    embedding_pca: {
        type: [Number],
        default: [],
    },
    engagement_score: { type: Number, default: 0 },
    categories: [{ type: String }],
    originalKey: { type: String }, // For R2 storage
    // Analytics fields
    completionRates: [{ type: Number }], // Array of completion percentages from user views
    completionRate: { type: Number, default: 0 }, // Average completion rate
    totalWatchTime: { type: Number, default: 0 }, // Total watch time in milliseconds
    avgWatchTime: { type: Number, default: 0 }, // Average watch time in milliseconds
}, { timestamps: true });

// Performance indexes (existing - maintained for backward compatibility)
ReelSchema.index({ scrapedAt: -1 }); // For sorted pagination
ReelSchema.index({ viewCount: -1 }); // For trending reels
ReelSchema.index({ likes: -1 }); // For popular reels
ReelSchema.index({ engagement_score: -1 }); // For engagement-based recommendations
ReelSchema.index({ publishedAt: -1 }); // For recency-based sorting
ReelSchema.index({ categories: 1 }); // For category-based filtering
ReelSchema.index({ source: 1, scrapedAt: -1 }); // For source-specific queries
ReelSchema.index({ reelId: 1 }); // For unique lookups
ReelSchema.index({ embedding: 1 }); // For recommendation queries
ReelSchema.index({ embedding_pca: 1 }); // For fast PCA-based recommendations

// ===================== NEW OPTIMIZED INDEXES FOR CURSOR-BASED FEED =====================
// These compound indexes significantly improve the new cursor-based feed queries
// Added: Nov 2025 - Phase 3 optimization

// Compound index for trending feed optimization (getTrendingFeedOptimized)
// Supports: { scrapedAt: {$gte}, _id: {$nin} } with sort by trendingScore + scrapedAt
// This eliminates the need for sorting in memory - MongoDB uses index for both filter and sort
ReelSchema.index({
    scrapedAt: -1,      // Filter: recent content (last 30 days) + sort secondary
    viewCount: -1,      // Component of trendingScore calculation
    engagement_score: -1 // Engagement-based scoring
});

// Compound index for cursor-based exclusion queries
// Supports efficient $nin operations in cursor pagination
// Improves performance when excluding viewed reels
ReelSchema.index({
    _id: 1,             // Primary filter for cursor exclusion
    videoUrl: 1,        // Validation that video exists
    scrapedAt: -1       // Sorting for consistent results
});

// Compound index for personalized feed with engagement
// Supports: Atlas Search results + engagement scoring + date sorting
ReelSchema.index({
    engagement_score: -1, // Primary sort after vector search
    scrapedAt: -1,       // Secondary sort for recency
    viewCount: -1        // Tertiary for trending boost
});

module.exports = mongoose.model('Reel', ReelSchema);
