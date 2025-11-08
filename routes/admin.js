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

        console.log('📊 Analytics request started for user:', currentUser.email);
        const startTime = Date.now();

        // Get date range from query params or use defaults (last 7 days for speed)
        const daysBack = parseInt(req.query.days) || 7;
        const now = new Date();
        const timeWindowStart = new Date(now);
        timeWindowStart.setDate(now.getDate() - daysBack);

        console.log(`📅 Using ${daysBack} day time window starting from`, timeWindowStart.toISOString());

        // Build filter based on user role
        let articleFilter = {
            publishedAt: { $gte: timeWindowStart } // ✅ CRITICAL: Limit to time window
        };
        let sourceFilter = {};

        if (currentUser.type === 'publisher' && currentUser.publisher_group?.length > 0) {
            // Publishers see only their assigned groups
            sourceFilter = { groupName: { $in: currentUser.publisher_group } };
            const publisherSources = await Source.find(sourceFilter).select('_id');
            const sourceIds = publisherSources.map(s => s._id);
            articleFilter.sourceId = { $in: sourceIds };
        } else if (currentUser.type !== 'admin') {
            // Non-admin, non-publisher users get no data
            return res.status(403).json({ message: 'Access denied.' });
        }

        // Get current date ranges
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const startOfWeek = new Date(startOfToday);
        startOfWeek.setDate(startOfToday.getDate() - 7);
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);

        console.log('⏱️  Query 1: Total statistics (combined)');
        // Combined statistics query for better performance
        // Note: totalViews now comes from UserActivity for accuracy
        const [totalArticles, articleStatsResults, activityStatsResults] = await Promise.all([
            Article.countDocuments(articleFilter),
            Article.aggregate([
                { $match: articleFilter },
                {
                    $group: {
                        _id: null,
                        totalLikes: { $sum: '$likes' },
                        totalDislikes: { $sum: '$dislikes' }
                    }
                }
            ]),
            // Get total views from UserActivity within time window
            UserActivity.aggregate([
                {
                    $match: {
                        timestamp: { $gte: timeWindowStart },
                        eventType: 'view'
                    }
                },
                {
                    $group: {
                        _id: null,
                        totalViews: { $sum: 1 }
                    }
                }
            ])
        ]);

        const articleStats = articleStatsResults[0] || { totalLikes: 0, totalDislikes: 0 };
        const activityStats = activityStatsResults[0] || { totalViews: 0 };
        const stats = {
            totalViews: activityStats.totalViews,
            totalLikes: articleStats.totalLikes,
            totalDislikes: articleStats.totalDislikes
        };

        console.log('⏱️  Query 2: User activity');
        // User activity stats (ALWAYS limited by time window)
        let activityFilter = { timestamp: { $gte: timeWindowStart } };

        // For publishers, additionally filter by their article IDs
        if (currentUser.type === 'publisher' && currentUser.publisher_group?.length > 0) {
            const publisherArticleIds = await Article.find(articleFilter)
                .select('_id')
                .limit(1000) // Reduced from 5000 for better performance
                .lean()
                .then(docs => docs.map(d => d._id));

            if (publisherArticleIds.length > 0) {
                activityFilter.articleId = { $in: publisherArticleIds };
            }
        }

        const uniqueUsers = await UserActivity.distinct('userId', activityFilter);
        const totalUsers = await User.countDocuments();

        console.log('⏱️  Query 3: Weekly activity');
        // Weekly trends (last 7 days) - optimized
        const weeklyActivity = await UserActivity.aggregate([
            {
                $match: {
                    timestamp: { $gte: startOfWeek }
                    // Removed articleId filter for performance - will show all platform activity
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
            { $sort: { '_id.date': 1 } },
            { $limit: 100 } // Safety limit
        ]);

        console.log('⏱️  Query 4: Monthly trends');
        // Monthly trends (within time window, not 6 months ago)
        const monthlyTrends = await Article.aggregate([
            {
                $match: articleFilter // Already includes time window
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

        console.log('⏱️  Query 5: Top articles by recent activity');
        // Top articles by views in the time window (from UserActivity, not Article.viewCount)
        const topArticleIds = await UserActivity.aggregate([
            {
                $match: {
                    eventType: 'view',
                    timestamp: { $gte: timeWindowStart }
                }
            },
            {
                $group: {
                    _id: '$articleId',
                    viewCount: { $sum: 1 }
                }
            },
            { $sort: { viewCount: -1 } },
            { $limit: 10 }
        ]);

        // Fetch full article details for top articles
        const topArticleIdsArray = topArticleIds.map(item => item._id).filter(Boolean);
        const topArticlesRaw = await Article.find({ _id: { $in: topArticleIdsArray } })
            .populate('sourceId', 'name groupName')
            .select('title viewCount likes dislikes publishedAt category sourceId')
            .lean();

        // Merge with view counts from UserActivity and sort
        const topArticles = topArticleIds.map(item => {
            const article = topArticlesRaw.find(a => a._id.toString() === item._id.toString());
            if (article) {
                return {
                    ...article,
                    viewCount: item.viewCount // Use actual views from time window
                };
            }
            return null;
        }).filter(Boolean);

        console.log('⏱️  Query 6: Category stats');
        // Category distribution (within time window)
        const categoryStats = await Article.aggregate([
            { $match: articleFilter },
            {
                $group: {
                    _id: '$category',
                    count: { $sum: 1 },
                    views: { $sum: '$viewCount' }
                }
            },
            { $sort: { count: -1 } },
            { $limit: 10 } // Limit to top 10 categories
        ]);

        console.log('⏱️  Query 7: Recent activity');
        // Recent activity (last 24 hours) - simplified query
        const recentActivity = await UserActivity.aggregate([
            {
                $match: {
                    timestamp: { $gte: startOfToday }
                    // Removed articleId filter for performance
                }
            },
            {
                $group: {
                    _id: '$eventType',
                    count: { $sum: 1 }
                }
            },
            { $limit: 20 } // Safety limit
        ]);

        console.log('⏱️  Query 8: Growth calculations (combined)');
        // Growth calculations (compare this month vs last month) - combined queries
        const [thisMonthArticles, lastMonthArticles, thisMonthViews, lastMonthViews] = await Promise.all([
            Article.countDocuments({
                ...articleFilter,
                publishedAt: { $gte: startOfMonth, $lte: now }
            }),
            Article.countDocuments({
                ...articleFilter,
                publishedAt: { $gte: startOfLastMonth, $lte: endOfLastMonth }
            }),
            // Count view events from UserActivity (this month)
            UserActivity.aggregate([
                {
                    $match: {
                        timestamp: { $gte: startOfMonth, $lte: now },
                        eventType: 'view'
                    }
                },
                { $group: { _id: null, views: { $sum: 1 } } }
            ]),
            // Count view events from UserActivity (last month)
            UserActivity.aggregate([
                {
                    $match: {
                        timestamp: { $gte: startOfLastMonth, $lte: endOfLastMonth },
                        eventType: 'view'
                    }
                },
                { $group: { _id: null, views: { $sum: 1 } } }
            ])
        ]);

        const articleGrowth = lastMonthArticles > 0
            ? ((thisMonthArticles - lastMonthArticles) / lastMonthArticles * 100).toFixed(1)
            : 0;

        const thisMonthViewCount = thisMonthViews[0]?.views || 0;
        const lastMonthViewCount = lastMonthViews[0]?.views || 0;
        const viewGrowth = lastMonthViewCount > 0
            ? ((thisMonthViewCount - lastMonthViewCount) / lastMonthViewCount * 100).toFixed(1)
            : 0;

        const endTime = Date.now();
        const duration = ((endTime - startTime) / 1000).toFixed(2);
        console.log(`✅ Analytics completed in ${duration}s`);

        res.json({
            overview: {
                totalArticles,
                totalViews: stats.totalViews,
                totalLikes: stats.totalLikes,
                totalDislikes: stats.totalDislikes,
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
            publisherGroups: currentUser.publisher_group || [],
            timeWindow: {
                days: daysBack,
                startDate: timeWindowStart.toISOString(),
                endDate: now.toISOString()
            },
            performanceMs: endTime - startTime
        });
    } catch (error) {
        console.error('❌ Error fetching analytics:', error);
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
