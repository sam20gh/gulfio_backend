const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
    conversationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true },
    senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: ['text', 'image', 'article_share', 'reel_share'], default: 'text' },
    text: { type: String, default: '' },
    mediaUrl: { type: String, default: null },
    // Populated only for article_share / reel_share — the shared Article or Reel _id.
    sharedRefId: { type: mongoose.Schema.Types.ObjectId, default: null },
}, { timestamps: true });

messageSchema.index({ conversationId: 1, createdAt: -1 });

module.exports = mongoose.model('Message', messageSchema);
