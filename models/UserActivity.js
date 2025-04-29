const mongoose = require('mongoose');

const userActivitySchema = new mongoose.Schema({
    userId: { type: String, required: true },
    eventType: { type: String, enum: ['view', 'like', 'dislike', 'save', 'unsave', 'follow', 'read_time'], required: true },
    articleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Article' },
    duration: { type: Number }, // in seconds
    timestamp: { type: Date, default: Date.now },
});

module.exports = mongoose.model('UserActivity', userActivitySchema);
