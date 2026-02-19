/**
 * Notification Model (Phase 3.3)
 *
 * Stores user notification history in MongoDB for in-app notification center.
 * Separate from push notifications - this is for persistent notification history.
 */

const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
    // User who receives the notification
    userId: {
        type: String, // Supabase user ID
        required: true,
        index: true,
    },

    // Notification type
    type: {
        type: String,
        required: true,
        enum: [
            'breaking_news',
            'article_like',
            'new_follower',
            'mention',
            'comment_reply',
            'comment_like',
            'followed_source',
            'weekly_digest',
            'news',
        ],
    },

    // Notification content
    title: {
        type: String,
        required: true,
    },

    body: {
        type: String,
        required: true,
    },

    // Additional data (article ID, user ID, etc.)
    data: {
        type: mongoose.Schema.Types.Mixed,
        default: {},
    },

    // Read status
    read: {
        type: Boolean,
        default: false,
        index: true,
    },

    // Auto-delete after 30 days
    expiresAt: {
        type: Date,
        default: () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
        index: true,
    },
}, {
    timestamps: true, // Adds createdAt and updatedAt
});

// Compound index for efficient queries
notificationSchema.index({ userId: 1, read: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, type: 1, createdAt: -1 });

// TTL index to auto-delete expired notifications
notificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('Notification', notificationSchema);
