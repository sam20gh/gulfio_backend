// models/Video.js
const mongoose = require('mongoose');
const { Schema } = mongoose;

const VideoSchema = new Schema({
    source: { type: Schema.Types.ObjectId, ref: 'Source', required: true },
    videoId: { type: String, required: true, unique: true },
    title: { type: String, required: true },
    description: { type: String },
    publishedAt: { type: Date },
    thumbnailUrl: { type: String },
    scrapedAt: { type: Date, default: Date.now },
    embedding: {
        type: [Number],
        default: [],
    },
}, { timestamps: true });

module.exports = mongoose.model('Video', VideoSchema);
