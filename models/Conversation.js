const mongoose = require('mongoose');

// 1:1 conversations only (v1). `pairKey` is the two participant _ids sorted
// and joined, so the unique index makes "find or create" race-safe and
// guarantees the same two users can never end up with two conversations.
const conversationSchema = new mongoose.Schema({
    participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }],
    pairKey: { type: String, required: true, unique: true },

    // 'pending' = message request (not yet mutual-follow at creation time,
    // or not yet accepted); 'inbox' = visible in both users' main inbox.
    status: { type: String, enum: ['inbox', 'pending'], default: 'pending' },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    lastMessageAt: { type: Date, default: Date.now },
    lastMessagePreview: { type: String, default: '' },
    lastMessageSenderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    // Per-participant "read up to" timestamp. Cheaper than a readBy array on
    // every message doc — unread state and read receipts are both derived by
    // comparing a message's createdAt against the other participant's entry.
    readUpTo: {
        type: Map,
        of: Date,
        default: {},
    },
}, { timestamps: true });

conversationSchema.index({ participants: 1, status: 1, lastMessageAt: -1 });

module.exports = mongoose.model('Conversation', conversationSchema);
