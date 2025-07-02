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
}, { timestamps: true });

module.exports = mongoose.model('Reel', ReelSchema);
