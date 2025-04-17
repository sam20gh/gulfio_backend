const mongoose = require('mongoose');

const ArticleSchema = new mongoose.Schema({
    title: { type: String, required: true },
    content: String,
    url: String,
    sourceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Source' },
    category: String,
    publishedAt: Date,
    image: [String], // ✅ now an array of image URLs
    viewCount: {
        type: Number,
        default: 0
    }
});

module.exports = mongoose.model('Article', ArticleSchema);
