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

// Analytics dashboard endpoint
router.get('/analytics', auth, ensureMongoUser, async (req, res) => {
    try {
        const currentUser = req.mongoUser;
        const Article = require('../models/Article');
        const Source = require('../models/Source');

        // Build filter based on user role
        let articleFilter = {};
        let sourceFilter = {};
        
        if (currentUser.type === 'publisher' && currentUser.publisher_group?.length > 0) {
            // Publishers see only their assigned groups
            sourceFilter = { groupName: { $in: currentUser.publisher_group } };
            const publisherSources = await Source.find(sourceFilter).select('_id');
            const sourceIds = publisherSources.map(s => s._id);
            articleFilter = { sourceId: { $in: sourceIds } };
        } else if (currentUser.type !== 'admin') {
            // Non-admin, non-publisher users get no data
            return res.status(403).json({ message: 'Access denied.' });
        }

        // Get current date ranges
        const now = new Date();
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const startOfWeek = new Date(startOfToday);
        startOfWeek.setDate(startOfToday.getDate() - 7);
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);

        // Total statistics
        const totalArticles = await Article.countDocuments(articleFilter);
        const totalViews = await Article.aggregate([
            { $match: articleFilter },
            { $group: { _id: null, total: { $sum: '$viewCount' } } }
        ]);
        const totalLikes = await Article.aggregate([
            { $match: articleFilter },
            { $group: { _id: null, total: { $sum: '$likes' } } }
        ]);
        const totalDislikes = await Article.aggregate([
            { $match: articleFilter },
            { $group: { _id: null, total: { $sum: '$dislikes' } } }
        ]);

        // User activity stats
        const activityFilter = currentUser.type === 'publisher' && currentUser.publisher_group?.length > 0
            ? { articleId: { $in: await Article.find(articleFilter).select('_id').then(docs => docs.map(d => d._id)) } }
            : {};

        const uniqueUsers = await UserActivity.distinct('userId', activityFilter);
        const totalUsers = await User.countDocuments();

        // Weekly trends (last 7 days)
        const weeklyActivity = await UserActivity.aggregate([
            {
                $match: {
                    timestamp: { $gte: startOfWeek },
                    ...(activityFilter.articleId && { articleId: activityFilter.articleId })
                }
            },
            {
                $group: {
                    _id: {
                        date: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp' } },
                        eventType: '$eventType'
                    },
                    count: { $sum: 1 }
                }
            },
            { $sort: { '_id.date': 1 } }
        ]);

        // Monthly trends (last 6 months)
        const sixMonthsAgo = new Date(now);
        sixMonthsAgo.setMonth(now.getMonth() - 6);
        
        const monthlyTrends = await Article.aggregate([
            {
                $match: {
                    ...articleFilter,
                    publishedAt: { $gte: sixMonthsAgo }
                }
            },
            {
                $group: {
                    _id: {
                        year: { $year: '$publishedAt' },
                        month: { $month: '$publishedAt' }
                    },
                    articles: { $sum: 1 },
                    views: { $sum: '$viewCount' },
                    likes: { $sum: '$likes' }
                }
            },
            { $sort: { '_id.year': 1, '_id.month': 1 } }
        ]);

        // Top articles by views
        const topArticles = await Article.find(articleFilter)
            .sort({ viewCount: -1 })
            .limit(10)
            .populate('sourceId', 'name groupName')
            .select('title viewCount likes dislikes publishedAt category sourceId');

        // Category distribution
        const categoryStats = await Article.aggregate([
            { $match: articleFilter },
            {
                $group: {
                    _id: '$category',
                    count: { $sum: 1 },
                    views: { $sum: '$viewCount' }
                }
            },
            { $sort: { count: -1 } }
        ]);

        // Recent activity (last 24 hours)
        const recentActivity = await UserActivity.aggregate([
            {
                $match: {
                    timestamp: { $gte: startOfToday },
                    ...(activityFilter.articleId && { articleId: activityFilter.articleId })
                }
            },
            {
                $group: {
                    _id: '$eventType',
                    count: { $sum: 1 }
                }
            }
        ]);

        // Growth calculations (compare this month vs last month)
        const thisMonthArticles = await Article.countDocuments({
            ...articleFilter,
            publishedAt: { $gte: startOfMonth }
        });
        const lastMonthArticles = await Article.countDocuments({
            ...articleFilter,
            publishedAt: { $gte: startOfLastMonth, $lte: endOfLastMonth }
        });
        const articleGrowth = lastMonthArticles > 0
            ? ((thisMonthArticles - lastMonthArticles) / lastMonthArticles * 100).toFixed(1)
            : 0;

        const thisMonthViews = await Article.aggregate([
            {
                $match: {
                    ...articleFilter,
                    publishedAt: { $gte: startOfMonth }
                }
            },
            { $group: { _id: null, total: { $sum: '$viewCount' } } }
        ]);
        const lastMonthViews = await Article.aggregate([
            {
                $match: {
                    ...articleFilter,
                    publishedAt: { $gte: startOfLastMonth, $lte: endOfLastMonth }
                }
            },
            { $group: { _id: null, total: { $sum: '$viewCount' } } }
        ]);
        const thisMonthViewCount = thisMonthViews[0]?.total || 0;
        const lastMonthViewCount = lastMonthViews[0]?.total || 0;
        const viewGrowth = lastMonthViewCount > 0
            ? ((thisMonthViewCount - lastMonthViewCount) / lastMonthViewCount * 100).toFixed(1)
            : 0;

        res.json({
            overview: {
                totalArticles,
                totalViews: totalViews[0]?.total || 0,
                totalLikes: totalLikes[0]?.total || 0,
                totalDislikes: totalDislikes[0]?.total || 0,
                activeUsers: uniqueUsers.length,
                totalUsers,
                articleGrowth: parseFloat(articleGrowth),
                viewGrowth: parseFloat(viewGrowth)
            },
            weeklyActivity,
            monthlyTrends,
            topArticles,
            categoryStats,
            recentActivity,
            userRole: currentUser.type,
            publisherGroups: currentUser.publisher_group || []
        });
    } catch (error) {
        console.error('Error fetching analytics:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
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
