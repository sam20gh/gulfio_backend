const mongoose = require('mongoose');

const userActivitySchema = new mongoose.Schema({
    userId: { type: String, required: true },
    eventType: { type: String, enum: ['view', 'like', 'dislike', 'save', 'unsave', 'follow', 'read_time'], required: true },
    articleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Article' },
    duration: { type: Number }, // in seconds
    timestamp: { type: Date, default: Date.now },
});
userActivitySchema.index({ userId: 1 });
userActivitySchema.index({ articleId: 1 });
userActivitySchema.index({ timestamp: -1 });
userActivitySchema.index({ eventType: 1, timestamp: -1 });

userActivitySchema.index({ timestamp: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 }); // 90 days

module.exports = mongoose.model('UserActivity', userActivitySchema);
