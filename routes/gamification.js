/**
 * 🎮 Gamification API Routes
 * Endpoints for points, badges, leaderboards, and user gamification profiles
 */

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const ensureMongoUser = require('../middleware/ensureMongoUser');
const UserPoints = require('../models/UserPoints');
const PointTransaction = require('../models/PointTransaction');
const Badge = require('../models/Badge');
const UserBadge = require('../models/UserBadge');
const User = require('../models/User');
const PointsService = require('../services/pointsService');
const { LEVELS, TIER_COLORS } = require('../utils/pointsConfig');
const redis = require('../utils/redis');

/**
 * GET /api/gamification/profile
 * Get current user's gamification profile
 */
router.get('/profile', auth, async (req, res) => {
    const userId = req.user.sub;
    const cacheKey = `gamification:profile:${userId}`;

    try {
        // Try cache first
        if (redis.isConnected && redis.isConnected()) {
            const cached = await redis.get(cacheKey);
            if (cached) {
                console.log(`⚡ Gamification profile cache HIT for ${userId}`);
                return res.json(JSON.parse(cached));
            }
        }

        console.log(`🔍 Gamification profile cache MISS for ${userId}`);

        const profile = await PointsService.getProfile(userId);

        // Cache for 60 seconds
        if (redis.isConnected && redis.isConnected()) {
            await redis.set(cacheKey, JSON.stringify(profile), 'EX', 60);
        }

        res.json(profile);

    } catch (error) {
        console.error('❌ GET /gamification/profile error:', error);
        res.status(500).json({ message: 'Failed to get gamification profile' });
    }
});

/**
 * GET /api/gamification/profile/:userId
 * Get another user's public gamification profile
 */
router.get('/profile/:userId', async (req, res) => {
    const { userId } = req.params;

    try {
        const profile = await PointsService.getProfile(userId);

        // Return limited public info
        res.json({
            points: profile.points,
            level: profile.level,
            streak: {
                current: profile.streak.current,
                longest: profile.streak.longest
            },
            badges: profile.badges.filter(b => b.isDisplayed), // Only displayed badges
            stats: {
                articlesRead: profile.stats.articlesRead,
                commentsPosted: profile.stats.commentsPosted
            }
        });

    } catch (error) {
        console.error('❌ GET /gamification/profile/:userId error:', error);
        res.status(500).json({ message: 'Failed to get user profile' });
    }
});

/**
 * GET /api/gamification/leaderboard
 * Get leaderboard by type (points, streak, level)
 */
router.get('/leaderboard', async (req, res) => {
    const { type = 'points', limit = 20 } = req.query;
    const cacheKey = `gamification:leaderboard:${type}:${limit}`;

    try {
        // Try cache
        if (redis.isConnected && redis.isConnected()) {
            const cached = await redis.get(cacheKey);
            if (cached) {
                console.log(`⚡ Leaderboard cache HIT for ${type}`);
                return res.json(JSON.parse(cached));
            }
        }

        console.log(`🔍 Leaderboard cache MISS for ${type}`);

        // Determine sort field
        let sortField = 'totalPoints';
        if (type === 'streak') sortField = 'streak.current';
        if (type === 'level') sortField = 'level';
        if (type === 'lifetime') sortField = 'lifetimePoints';

        const leaderboard = await UserPoints.find({ [sortField]: { $gt: 0 } })
            .sort({ [sortField]: -1 })
            .limit(parseInt(limit))
            .select('userId totalPoints lifetimePoints level streak.current streak.longest')
            .lean();

        // Enrich with user names (batch lookup)
        const userIds = leaderboard.map(l => l.userId);
        const users = await User.find({ supabase_id: { $in: userIds } })
            .select('supabase_id name avatar_url profile_image')
            .lean();

        const userMap = new Map(users.map(u => [u.supabase_id, u]));

        // Get displayed badges for each user
        const userBadges = await UserBadge.find({
            userId: { $in: userIds },
            isDisplayed: true
        }).populate('badgeId').lean();

        const badgeMap = new Map();
        userBadges.forEach(ub => {
            if (!ub.badgeId) return;
            if (!badgeMap.has(ub.userId)) {
                badgeMap.set(ub.userId, []);
            }
            badgeMap.get(ub.userId).push({
                name: ub.badgeId.name,
                icon: ub.badgeId.icon,
                tier: ub.badgeId.tier
            });
        });

        const result = leaderboard.map((entry, index) => {
            const user = userMap.get(entry.userId) || {};
            const levelInfo = LEVELS.find(l => l.level === entry.level) || LEVELS[0];

            return {
                rank: index + 1,
                userId: entry.userId,
                name: user.name || 'Anonymous',
                avatar: user.profile_image || user.avatar_url,
                points: entry.totalPoints,
                lifetimePoints: entry.lifetimePoints,
                level: entry.level,
                levelTitle: levelInfo.title,
                streak: entry.streak?.current || 0,
                longestStreak: entry.streak?.longest || 0,
                displayedBadges: badgeMap.get(entry.userId) || []
            };
        });

        // Cache for 5 minutes
        if (redis.isConnected && redis.isConnected()) {
            await redis.set(cacheKey, JSON.stringify(result), 'EX', 300);
        }

        res.json(result);

    } catch (error) {
        console.error('❌ GET /gamification/leaderboard error:', error);
        res.status(500).json({ message: 'Failed to get leaderboard' });
    }
});

/**
 * GET /api/gamification/badges
 * Get all available badges with unlock requirements
 */
router.get('/badges', async (req, res) => {
    const { category } = req.query;

    try {
        const query = { isActive: true };
        if (category) query.category = category;

        const badges = await Badge.find(query)
            .sort({ category: 1, tier: 1, 'requirement.value': 1 })
            .lean();

        // Add tier colors
        const badgesWithColors = badges.map(badge => ({
            ...badge,
            tierColor: TIER_COLORS[badge.tier] || TIER_COLORS.bronze
        }));

        res.json(badgesWithColors);

    } catch (error) {
        console.error('❌ GET /gamification/badges error:', error);
        res.status(500).json({ message: 'Failed to get badges' });
    }
});

/**
 * GET /api/gamification/badges/user/:userId
 * Get badges earned by a specific user
 */
router.get('/badges/user/:userId', async (req, res) => {
    const { userId } = req.params;

    try {
        const userBadges = await UserBadge.find({ userId })
            .populate('badgeId')
            .sort({ earnedAt: -1 })
            .lean();

        const badges = userBadges
            .filter(ub => ub.badgeId)
            .map(ub => ({
                ...ub.badgeId,
                earnedAt: ub.earnedAt,
                isDisplayed: ub.isDisplayed,
                tierColor: TIER_COLORS[ub.badgeId.tier] || TIER_COLORS.bronze
            }));

        res.json(badges);

    } catch (error) {
        console.error('❌ GET /gamification/badges/user/:userId error:', error);
        res.status(500).json({ message: 'Failed to get user badges' });
    }
});

/**
 * GET /api/gamification/history
 * Get current user's recent point transactions
 */
router.get('/history', auth, async (req, res) => {
    const { limit = 50, offset = 0, action } = req.query;

    try {
        const query = { userId: req.user.sub };
        if (action) query.action = action;

        const transactions = await PointTransaction.find(query)
            .sort({ createdAt: -1 })
            .skip(parseInt(offset))
            .limit(parseInt(limit))
            .lean();

        // Get total count for pagination
        const total = await PointTransaction.countDocuments(query);

        res.json({
            transactions,
            total,
            hasMore: parseInt(offset) + transactions.length < total
        });

    } catch (error) {
        console.error('❌ GET /gamification/history error:', error);
        res.status(500).json({ message: 'Failed to get history' });
    }
});

/**
 * POST /api/gamification/badges/display
 * Set which badges to display on profile (max 3)
 */
router.post('/badges/display', auth, async (req, res) => {
    const { badgeIds } = req.body;
    const userId = req.user.sub;

    if (!Array.isArray(badgeIds)) {
        return res.status(400).json({ message: 'badgeIds must be an array' });
    }

    if (badgeIds.length > 3) {
        return res.status(400).json({ message: 'Maximum 3 badges can be displayed' });
    }

    try {
        // Reset all to not displayed
        await UserBadge.updateMany(
            { userId },
            { isDisplayed: false }
        );

        // Set selected as displayed
        if (badgeIds.length > 0) {
            const result = await UserBadge.updateMany(
                { userId, badgeId: { $in: badgeIds } },
                { isDisplayed: true }
            );

            console.log(`✅ Updated ${result.modifiedCount} displayed badges for ${userId}`);
        }

        // Invalidate cache
        await PointsService.invalidateCache(userId);

        res.json({ success: true, displayedCount: badgeIds.length });

    } catch (error) {
        console.error('❌ POST /gamification/badges/display error:', error);
        res.status(500).json({ message: 'Failed to update displayed badges' });
    }
});

/**
 * GET /api/gamification/levels
 * Get all level definitions
 */
router.get('/levels', (req, res) => {
    res.json(LEVELS);
});

/**
 * GET /api/gamification/stats
 * Get overall gamification stats (admin/public stats)
 */
router.get('/stats', async (req, res) => {
    const cacheKey = 'gamification:stats:global';

    try {
        // Try cache
        if (redis.isConnected && redis.isConnected()) {
            const cached = await redis.get(cacheKey);
            if (cached) {
                return res.json(JSON.parse(cached));
            }
        }

        const [
            totalUsers,
            totalPoints,
            totalBadgesEarned,
            avgPoints,
            levelDistribution
        ] = await Promise.all([
            UserPoints.countDocuments(),
            UserPoints.aggregate([
                { $group: { _id: null, total: { $sum: '$lifetimePoints' } } }
            ]),
            UserBadge.countDocuments(),
            UserPoints.aggregate([
                { $group: { _id: null, avg: { $avg: '$lifetimePoints' } } }
            ]),
            UserPoints.aggregate([
                { $group: { _id: '$level', count: { $sum: 1 } } },
                { $sort: { _id: 1 } }
            ])
        ]);

        const stats = {
            totalUsers,
            totalPointsAwarded: totalPoints[0]?.total || 0,
            totalBadgesEarned,
            averagePointsPerUser: Math.round(avgPoints[0]?.avg || 0),
            levelDistribution: levelDistribution.map(l => ({
                level: l._id,
                count: l.count,
                title: LEVELS.find(lv => lv.level === l._id)?.title || 'Unknown'
            }))
        };

        // Cache for 10 minutes
        if (redis.isConnected && redis.isConnected()) {
            await redis.set(cacheKey, JSON.stringify(stats), 'EX', 600);
        }

        res.json(stats);

    } catch (error) {
        console.error('❌ GET /gamification/stats error:', error);
        res.status(500).json({ message: 'Failed to get stats' });
    }
});

/**
 * POST /api/gamification/check-streak
 * Manually trigger streak check (called on app open)
 */
router.post('/check-streak', auth, async (req, res) => {
    const userId = req.user.sub;

    try {
        const result = await PointsService.updateStreak(userId);
        res.json(result || { streak: 0, isNewDay: false });
    } catch (error) {
        console.error('❌ POST /gamification/check-streak error:', error);
        res.status(500).json({ message: 'Failed to check streak' });
    }
});

/**
 * GET /api/gamification/referral-code
 * Get or generate user's referral code
 */
router.get('/referral-code', auth, async (req, res) => {
    const userId = req.user.sub;

    try {
        let user = await User.findOne({ supabase_id: userId });
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        // Generate referral code if not exists
        if (!user.referralCode) {
            // Generate unique 8-char code
            const generateCode = () => {
                const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Avoid confusing chars
                let code = '';
                for (let i = 0; i < 8; i++) {
                    code += chars.charAt(Math.floor(Math.random() * chars.length));
                }
                return code;
            };

            let code = generateCode();
            let attempts = 0;
            while (await User.findOne({ referralCode: code }) && attempts < 10) {
                code = generateCode();
                attempts++;
            }

            user.referralCode = code;
            await user.save();
        }

        // Get referral stats
        const referralCount = await User.countDocuments({ referredBy: userId });
        const activeReferrals = await User.countDocuments({
            referredBy: userId,
            referralActivated: true
        });

        res.json({
            code: user.referralCode,
            shareUrl: `https://gulfio.app/invite/${user.referralCode}`,
            stats: {
                totalReferrals: referralCount,
                activeReferrals,
                pendingReferrals: referralCount - activeReferrals,
                pointsEarned: (referralCount * 100) + (activeReferrals * 200), // REFERRAL_SIGNUP + REFERRAL_ACTIVE
            }
        });

    } catch (error) {
        console.error('❌ GET /gamification/referral-code error:', error);
        res.status(500).json({ message: 'Failed to get referral code' });
    }
});

/**
 * POST /api/gamification/apply-referral
 * Apply a referral code for new users
 */
router.post('/apply-referral', auth, async (req, res) => {
    const userId = req.user.sub;
    const { code } = req.body;

    if (!code) {
        return res.status(400).json({ message: 'Referral code is required' });
    }

    try {
        // Find the referring user
        const referrer = await User.findOne({ referralCode: code.toUpperCase() });
        if (!referrer) {
            return res.status(404).json({ message: 'Invalid referral code' });
        }

        // Can't refer yourself
        if (referrer.supabase_id === userId) {
            return res.status(400).json({ message: 'Cannot use your own referral code' });
        }

        // Check if user already has a referrer
        const currentUser = await User.findOne({ supabase_id: userId });
        if (!currentUser) {
            return res.status(404).json({ message: 'User not found' });
        }

        if (currentUser.referredBy) {
            return res.status(400).json({ message: 'You already have a referrer' });
        }

        // Apply referral
        currentUser.referredBy = referrer.supabase_id;
        await currentUser.save();

        // Award points to referrer for signup
        await PointsService.awardPoints(referrer.supabase_id, 'REFERRAL_SIGNUP', {
            referredUserId: userId,
            description: 'New user signed up with your referral code'
        });

        console.log(`✅ Referral applied: ${userId} referred by ${referrer.supabase_id}`);

        res.json({
            success: true,
            message: 'Referral code applied successfully',
            referrerName: referrer.name || 'A friend'
        });

    } catch (error) {
        console.error('❌ POST /gamification/apply-referral error:', error);
        res.status(500).json({ message: 'Failed to apply referral code' });
    }
});

/**
 * POST /api/gamification/activate-referral
 * Called internally when a referred user becomes "active" (5+ articles read)
 * This is typically called by a background job or after reaching threshold
 */
router.post('/activate-referral', auth, async (req, res) => {
    const userId = req.user.sub;

    try {
        const user = await User.findOne({ supabase_id: userId });
        if (!user || !user.referredBy || user.referralActivated) {
            return res.json({ activated: false, message: 'No pending referral activation' });
        }

        // Check if user has read enough articles
        const userPoints = await UserPoints.findOne({ userId });
        if (!userPoints || userPoints.stats.articlesRead < 5) {
            return res.json({
                activated: false,
                message: 'Need to read more articles to activate referral',
                articlesRead: userPoints?.stats.articlesRead || 0,
                required: 5
            });
        }

        // Mark as activated
        user.referralActivated = true;
        await user.save();

        // Award bonus points to referrer
        await PointsService.awardPoints(user.referredBy, 'REFERRAL_ACTIVE', {
            referredUserId: userId,
            description: 'Your referral became an active reader!'
        });

        console.log(`✅ Referral activated: ${userId} (referred by ${user.referredBy})`);

        res.json({
            activated: true,
            message: 'Referral activated! Your referrer earned bonus points.'
        });

    } catch (error) {
        console.error('❌ POST /gamification/activate-referral error:', error);
        res.status(500).json({ message: 'Failed to activate referral' });
    }
});

module.exports = router;
