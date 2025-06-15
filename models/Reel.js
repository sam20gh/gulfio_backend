const mongoose = require('mongoose');
const { Schema } = mongoose;

const ReelSchema = new Schema({
    source: { type: Schema.Types.ObjectId, ref: 'Source', required: true },
    reelId: { type: String, required: true },
    videoUrl: { type: String, required: true },
    scrapedAt: { type: Date, default: Date.now },
    caption: { type: String, default: null },
    // Social features:
    likes: { type: Number, default: 0 },
    likedBy: [{ type: Schema.Types.ObjectId, ref: 'User', default: [] }],
    dislikes: { type: Number, default: 0 },
    dislikedBy: [{ type: Schema.Types.ObjectId, ref: 'User', default: [] }],
    viewCount: { type: Number, default: 0 },
    viewedBy: [{ type: Schema.Types.ObjectId, ref: 'User', default: [] }],
    embedding: {
        type: [Number],
        default: [],
    },
}, { timestamps: true });

module.exports = mongoose.model('Reel', ReelSchema);
