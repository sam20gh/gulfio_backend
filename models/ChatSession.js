const mongoose = require('mongoose');

const chatSessionSchema = new mongoose.Schema({
    userId: {
        type: String,
        required: true,
        index: true
    },
    startedAt: {
        type: Date,
        default: Date.now
    },
    lastMessageAt: {
        type: Date,
        default: Date.now
    },
    messageCount: {
        type: Number,
        default: 0
    },
    isActive: {
        type: Boolean,
        default: true
    },
    title: {
        type: String,
        default: 'New Chat'
    },
    language: {
        type: String,
        default: 'english'
    }
});

// Compound index for efficient querying
chatSessionSchema.index({ userId: 1, lastMessageAt: -1 });
chatSessionSchema.index({ userId: 1, isActive: 1 });

module.exports = mongoose.model('ChatSession', chatSessionSchema);