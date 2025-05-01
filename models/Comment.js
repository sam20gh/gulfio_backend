const mongoose = require('mongoose');

const commentSchema = new mongoose.Schema({
    articleId: {
        type: String, // store as string since you're comparing string IDs in routes
        required: true,
    },
    userId: {
        type: String, // Supabase user ID
        required: true,
    },
    username: {
        type: String,
        required: true,
    },
    comment: {
        type: String,
        required: true,
    },
    createdAt: {
        type: Date,
        default: Date.now,
    },
    likedBy: [String],
    dislikedBy: [String],
});

module.exports = mongoose.model('Comment', commentSchema);
