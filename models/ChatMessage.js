const mongoose = require('mongoose');

const chatMessageSchema = new mongoose.Schema({
    sessionId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'ChatSession',
        required: true,
        index: true
    },
    userId: {
        type: String,
        required: true,
        index: true
    },
    role: {
        type: String,
        enum: ['user', 'assistant'],
        required: true
    },
    content: {
        type: String,
        required: true
    },
    articleReferences: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Article'
    }],
    timestamp: {
        type: Date,
        default: Date.now
    },
    metadata: {
        articlesFound: Number,
        searchQuery: String,
        category: String,
        responseTime: Number
    }
});

// Compound indexes for efficient querying
chatMessageSchema.index({ sessionId: 1, timestamp: 1 });
chatMessageSchema.index({ userId: 1, timestamp: -1 });

module.exports = mongoose.model('ChatMessage', chatMessageSchema);