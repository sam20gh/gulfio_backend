const mongoose = require('mongoose');
const { Schema } = mongoose;

const ReelSchema = new Schema({
    source: { type: Schema.Types.ObjectId, ref: 'Source', required: true },
    reelId: { type: String, required: true },
    videoUrl: { type: String, required: true },
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
    originalKey: { type: String }, // For R2 storage
}, { timestamps: true });

// Performance indexes
ReelSchema.index({ scrapedAt: -1 }); // For sorted pagination
ReelSchema.index({ viewCount: -1 }); // For trending reels
ReelSchema.index({ likes: -1 }); // For popular reels
ReelSchema.index({ source: 1, scrapedAt: -1 }); // For source-specific queries
ReelSchema.index({ reelId: 1 }); // For unique lookups
ReelSchema.index({ embedding: 1 }); // For recommendation queries

module.exports = mongoose.model('Reel', ReelSchema);
