const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const CommentSchema = new mongoose.Schema({
    articleId: { type: String, required: false },
    reelId: { type: String, required: false },
    userId: { type: String, required: true },
    username: { type: String },
    comment: { type: String, required: true },
    likedBy: [{ type: String, default: [] }],
    dislikedBy: [{ type: String, default: [] }],
    replies: [{
        userId: String,
        username: String,
        reply: String,
        createdAt: Date,
    }],
    createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Comment', CommentSchema);
