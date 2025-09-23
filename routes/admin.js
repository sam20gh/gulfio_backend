const express = require('express');
const router = express.Router();
const UserActivity = require('../models/UserActivity');
const EngagementSummary = require('../models/EngagementSummary');
const User = require('../models/User');
const auth = require('../middleware/auth');
const ensureMongoUser = require('../middleware/ensureMongoUser');

// GET /api/admin/generate-engagement-summary
router.get('/generate-engagement-summary', async (req, res) => {
    try {
        const now = new Date();
        const yesterday = new Date(now);
        yesterday.setDate(now.getDate() - 1);
        yesterday.setHours(0, 0, 0, 0);

        const today = new Date(now);
        today.setHours(0, 0, 0, 0);

        const activities = await UserActivity.find({
            timestamp: {
                $gte: yesterday,
                $lt: today,
            },
        });

        const summary = {
            date: yesterday.toISOString().split('T')[0],
            view: 0,
            like: 0,
            dislike: 0,
            save: 0,
            unsave: 0,
            follow: 0,
            read_time_total: 0,
            read_time_count: 0,
        };

        for (const activity of activities) {
            if (summary[activity.eventType] !== undefined) {
                summary[activity.eventType]++;
            }
            if (activity.eventType === 'read_time' && activity.duration) {
                summary.read_time_total += activity.duration;
                summary.read_time_count++;
            }
        }

        const read_time_avg = summary.read_time_count
            ? Math.round(summary.read_time_total / summary.read_time_count)
            : 0;

        await EngagementSummary.updateOne(
            { date: summary.date },
            {
                $set: {
                    view: summary.view,
                    like: summary.like,
                    dislike: summary.dislike,
                    save: summary.save,
                    unsave: summary.unsave,
                    follow: summary.follow,
                    read_time_avg,
                },
            },
            { upsert: true }
        );

        res.status(200).json({ message: `✅ Summary saved for ${summary.date}` });
    } catch (err) {
        console.error('❌ Error generating summary:', err);
        res.status(500).json({ message: 'Failed to generate summary', error: err.message });
    }
});

// User management endpoints for role-based access control

// Get all users with their types and publisher groups (admin only)
router.get('/users', auth, ensureMongoUser, async (req, res) => {
    try {
        const currentUser = req.mongoUser;
        
        // Only allow admins to access this endpoint
        if (currentUser.type !== 'admin') {
            return res.status(403).json({ message: 'Access denied. Admin access required.' });
        }

        const users = await User.find({})
            .select('email name type publisher_group supabase_id createdAt')
            .sort({ createdAt: -1 });

        res.json({
            users,
            total: users.length
        });
    } catch (error) {
        console.error('Error fetching users:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Update user type and publisher groups (admin only)
router.put('/users/:userId/role', auth, ensureMongoUser, async (req, res) => {
    try {
        const currentUser = req.mongoUser;
        const { userId } = req.params;
        const { type, publisher_group } = req.body;

        // Only allow admins to access this endpoint
        if (currentUser.type !== 'admin') {
            return res.status(403).json({ message: 'Access denied. Admin access required.' });
        }

        // Validate type
        const validTypes = ['admin', 'publisher', 'user'];
        if (type && !validTypes.includes(type)) {
            return res.status(400).json({ message: 'Invalid user type. Must be admin, publisher, or user.' });
        }

        // Validate publisher_group if provided
        if (publisher_group && !Array.isArray(publisher_group)) {
            return res.status(400).json({ message: 'publisher_group must be an array of group names.' });
        }

        const updateData = {};
        if (type !== undefined) updateData.type = type;
        if (publisher_group !== undefined) updateData.publisher_group = publisher_group;

        const user = await User.findByIdAndUpdate(
            userId,
            updateData,
            { new: true, runValidators: true }
        ).select('email name type publisher_group supabase_id');

        if (!user) {
            return res.status(404).json({ message: 'User not found.' });
        }

        res.json({
            message: 'User role updated successfully',
            user
        });
    } catch (error) {
        console.error('Error updating user role:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

module.exports = router;
