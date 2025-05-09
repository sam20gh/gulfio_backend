const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const ReplySchema = new Schema({
    userId: String,
    username: String,
    reply: String,
    createdAt: { type: Date, default: Date.now },
});

const CommentSchema = new Schema({
    articleId: String,
    userId: String,
    username: String,
    comment: String,
    likedBy: [String],
    dislikedBy: [String],
    replies: [ReplySchema],  // <-- Added this
    createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Comment', CommentSchema);
