/**
 * Notification Routes (Phase 3.3)
 *
 * In-app notification history and management.
 * Separate from push notifications - this is for persistent notification center.
 */

const express = require('express');
const router = express.Router();
const Notification = require('../models/Notification');
const auth = require('../middleware/auth');

/**
 * GET /api/notifications
 * Get user's notifications with filtering and pagination
 *
 * Query params:
 * - type: Filter by notification type (optional)
 * - read: Filter by read status (true/false, optional)
 * - limit: Max notifications to return (default: 50, max: 100)
 * - offset: Skip N notifications (default: 0)
 */
router.get('/', auth, async (req, res) => {
    try {
        const userId = req.user?.sub;

        if (!userId) {
            return res.status(401).json({ error: 'User not authenticated' });
        }

        const { type, read, limit = 50, offset = 0 } = req.query;

        // Build query
        const query = { userId };

        if (type) {
            query.type = type;
        }

        if (read !== undefined) {
            query.read = read === 'true';
        }

        // Get notifications
        const notifications = await Notification.find(query)
            .sort({ createdAt: -1 })
            .limit(Math.min(parseInt(limit), 100))
            .skip(parseInt(offset))
            .lean();

        // Get unread count
        const unreadCount = await Notification.countDocuments({
            userId,
            read: false,
        });

        res.json({
            success: true,
            notifications,
            unreadCount,
            total: notifications.length,
        });
    } catch (error) {
        console.error('❌ Error fetching notifications:', error);
        res.status(500).json({ error: 'Failed to fetch notifications' });
    }
});

/**
 * GET /api/notifications/unread-count
 * Get count of unread notifications
 */
router.get('/unread-count', auth, async (req, res) => {
    try {
        const userId = req.user?.sub;

        if (!userId) {
            return res.status(401).json({ error: 'User not authenticated' });
        }

        const unreadCount = await Notification.countDocuments({
            userId,
            read: false,
        });

        res.json({
            success: true,
            unreadCount,
        });
    } catch (error) {
        console.error('❌ Error counting unread notifications:', error);
        res.status(500).json({ error: 'Failed to count notifications' });
    }
});

/**
 * PUT /api/notifications/:id/mark-read
 * Mark a notification as read
 */
router.put('/:id/mark-read', auth, async (req, res) => {
    try {
        const userId = req.user?.sub;
        const notificationId = req.params.id;

        if (!userId) {
            return res.status(401).json({ error: 'User not authenticated' });
        }

        const notification = await Notification.findOneAndUpdate(
            { _id: notificationId, userId },
            { read: true },
            { new: true }
        );

        if (!notification) {
            return res.status(404).json({ error: 'Notification not found' });
        }

        res.json({
            success: true,
            notification,
        });
    } catch (error) {
        console.error('❌ Error marking notification as read:', error);
        res.status(500).json({ error: 'Failed to mark notification as read' });
    }
});

/**
 * PUT /api/notifications/mark-all-read
 * Mark all notifications as read for the user
 */
router.put('/mark-all-read', auth, async (req, res) => {
    try {
        const userId = req.user?.sub;

        if (!userId) {
            return res.status(401).json({ error: 'User not authenticated' });
        }

        const result = await Notification.updateMany(
            { userId, read: false },
            { read: true }
        );

        res.json({
            success: true,
            modifiedCount: result.modifiedCount,
        });
    } catch (error) {
        console.error('❌ Error marking all notifications as read:', error);
        res.status(500).json({ error: 'Failed to mark all notifications as read' });
    }
});

/**
 * DELETE /api/notifications/:id
 * Delete a notification
 */
router.delete('/:id', auth, async (req, res) => {
    try {
        const userId = req.user?.sub;
        const notificationId = req.params.id;

        if (!userId) {
            return res.status(401).json({ error: 'User not authenticated' });
        }

        const notification = await Notification.findOneAndDelete({
            _id: notificationId,
            userId,
        });

        if (!notification) {
            return res.status(404).json({ error: 'Notification not found' });
        }

        res.json({
            success: true,
            message: 'Notification deleted',
        });
    } catch (error) {
        console.error('❌ Error deleting notification:', error);
        res.status(500).json({ error: 'Failed to delete notification' });
    }
});

/**
 * DELETE /api/notifications/clear-all
 * Delete all read notifications for the user
 */
router.delete('/clear-all', auth, async (req, res) => {
    try {
        const userId = req.user?.sub;

        if (!userId) {
            return res.status(401).json({ error: 'User not authenticated' });
        }

        const result = await Notification.deleteMany({
            userId,
            read: true,
        });

        res.json({
            success: true,
            deletedCount: result.deletedCount,
        });
    } catch (error) {
        console.error('❌ Error clearing notifications:', error);
        res.status(500).json({ error: 'Failed to clear notifications' });
    }
});

/**
 * POST /api/notifications (Internal use only - called by NotificationService)
 * Create a new notification
 *
 * This route is for internal server use. External clients should not call this directly.
 */
router.post('/', async (req, res) => {
    try {
        const { userId, type, title, body, data } = req.body;

        if (!userId || !type || !title || !body) {
            return res.status(400).json({
                error: 'Missing required fields: userId, type, title, body',
            });
        }

        const notification = await Notification.create({
            userId,
            type,
            title,
            body,
            data: data || {},
        });

        res.json({
            success: true,
            notification,
        });
    } catch (error) {
        console.error('❌ Error creating notification:', error);
        res.status(500).json({ error: 'Failed to create notification' });
    }
});

module.exports = router;
