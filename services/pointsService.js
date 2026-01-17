/**
 * 🎮 Points Service
 * Core business logic for the gamification system
 */

const UserPoints = require('../models/UserPoints');
const PointTransaction = require('../models/PointTransaction');
const Badge = require('../models/Badge');
const UserBadge = require('../models/UserBadge');
const { POINTS, LEVELS, STREAK, ANTI_ABUSE } = require('../utils/pointsConfig');
const redis = require('../utils/redis');

class PointsService {
    
    /**
     * Award points to a user for an action
     * @param {string} userId - Supabase user ID
     * @param {string} action - Action type (e.g., 'ARTICLE_READ', 'COMMENT_POST')
     * @param {object} metadata - Additional data (articleId, category, etc.)
     * @returns {object|null} - Points awarded info or null if blocked
     */
    static async awardPoints(userId, action, metadata = {}) {
        const actionKey = action.toUpperCase();
        const pointsToAward = POINTS[actionKey];
        
        if (pointsToAward === undefined) {
            console.warn(`⚠️ Unknown action for points: ${action}`);
            return null;
        }
        
        // Anti-abuse check
        const canAward = await this.checkAntiAbuse(userId, actionKey);
        if (!canAward) {
            console.log(`🚫 Points blocked for ${userId}: rate limit on ${action}`);
            return null;
        }
        
        try {
            // Get or create user points
            let userPoints = await UserPoints.findOne({ userId });
            if (!userPoints) {
                userPoints = await UserPoints.create({ userId });
                console.log(`✅ Created new UserPoints for ${userId}`);
            }
            
            // Calculate final points (with potential streak bonus)
            let finalPoints = pointsToAward;
            
            // Apply streak multiplier for daily login
            if (actionKey === 'DAILY_LOGIN' && userPoints.streak.current > 1) {
                const multiplier = Math.min(userPoints.streak.current, STREAK.MAX_MULTIPLIER);
                finalPoints = Math.round(pointsToAward * multiplier);
                metadata.streakDay = userPoints.streak.current;
                metadata.description = `Day ${userPoints.streak.current} streak bonus`;
            }
            
            // Update user points
            userPoints.totalPoints += finalPoints;
            userPoints.lifetimePoints += finalPoints;
            
            // Update stats based on action
            this.updateStats(userPoints, actionKey, metadata);
            
            // Check for level up
            const oldLevel = userPoints.level;
            const newLevel = this.calculateLevel(userPoints.lifetimePoints);
            const leveledUp = newLevel > oldLevel;
            userPoints.level = newLevel;
            
            await userPoints.save();
            
            // Log transaction
            await PointTransaction.create({
                userId,
                points: finalPoints,
                action: actionKey.toLowerCase(),
                metadata
            });
            
            console.log(`🎮 Awarded ${finalPoints} points to ${userId} for ${action}`);
            
            // Check for new badges (async, don't await to keep response fast)
            this.checkAndAwardBadges(userId, userPoints).catch(err => 
                console.error('❌ Badge check error:', err.message)
            );
            
            // Invalidate cache
            this.invalidateCache(userId).catch(console.error);
            
            return {
                pointsAwarded: finalPoints,
                totalPoints: userPoints.totalPoints,
                lifetimePoints: userPoints.lifetimePoints,
                leveledUp,
                newLevel: leveledUp ? newLevel : null,
                oldLevel: leveledUp ? oldLevel : null
            };
            
        } catch (error) {
            console.error('❌ Award points error:', error);
            return null;
        }
    }
    
    /**
     * Update daily streak for a user
     * Should be called on each meaningful activity
     */
    static async updateStreak(userId) {
        try {
            let userPoints = await UserPoints.findOne({ userId });
            if (!userPoints) {
                userPoints = await UserPoints.create({ userId });
            }
            
            const now = new Date();
            const lastActivity = userPoints.streak.lastActivityDate;
            
            if (!lastActivity) {
                // First activity ever
                userPoints.streak.current = 1;
                userPoints.streak.longest = 1;
                userPoints.streak.lastActivityDate = now;
                userPoints.stats.dailyLogins += 1;
                await userPoints.save();
                
                // Award daily login points
                await this.awardPoints(userId, 'DAILY_LOGIN');
                return { streak: 1, isNewDay: true };
            }
            
            // Calculate time difference
            const hoursDiff = (now - lastActivity) / (1000 * 60 * 60);
            
            // Check if same calendar day (using UTC)
            const lastDate = new Date(lastActivity).toISOString().split('T')[0];
            const todayDate = now.toISOString().split('T')[0];
            
            if (lastDate === todayDate) {
                // Same day, no streak change needed
                return { streak: userPoints.streak.current, isNewDay: false };
            }
            
            // Different day - check if streak continues or breaks
            if (hoursDiff < STREAK.GRACE_PERIOD_HOURS) {
                // Within grace period - increment streak
                userPoints.streak.current += 1;
                userPoints.streak.longest = Math.max(
                    userPoints.streak.longest,
                    userPoints.streak.current
                );
                console.log(`🔥 Streak increased to ${userPoints.streak.current} for ${userId}`);
            } else {
                // Streak broken - reset to 1
                console.log(`💔 Streak broken for ${userId} (${Math.round(hoursDiff)}h gap)`);
                userPoints.streak.current = 1;
            }
            
            userPoints.streak.lastActivityDate = now;
            userPoints.stats.dailyLogins += 1;
            await userPoints.save();
            
            // Award daily login points
            await this.awardPoints(userId, 'DAILY_LOGIN');
            
            // Invalidate cache
            this.invalidateCache(userId).catch(console.error);
            
            return { 
                streak: userPoints.streak.current, 
                isNewDay: true,
                longestStreak: userPoints.streak.longest
            };
            
        } catch (error) {
            console.error('❌ Update streak error:', error);
            return null;
        }
    }
    
    /**
     * Check anti-abuse rate limits
     */
    static async checkAntiAbuse(userId, action) {
        // Skip rate limiting if Redis is not available
        if (!redis.isConnected || !redis.isConnected()) {
            return true;
        }
        
        const cooldownKey = `points:cooldown:${userId}:${action}`;
        const dailyKey = `points:daily:${userId}:${action}`;
        
        try {
            // Check cooldown
            const recentAction = await redis.get(cooldownKey);
            if (recentAction) {
                return false;
            }
            
            // Check daily limit
            const dailyCount = parseInt(await redis.get(dailyKey) || '0');
            const limit = this.getDailyLimit(action);
            if (dailyCount >= limit) {
                return false;
            }
            
            // Set cooldown
            const cooldownMs = this.getCooldown(action);
            if (cooldownMs > 0) {
                await redis.set(cooldownKey, '1', 'PX', cooldownMs);
            }
            
            // Increment daily count with 24hr expiry
            await redis.incr(dailyKey);
            await redis.expire(dailyKey, 86400);
            
            return true;
        } catch (error) {
            console.error('❌ Redis anti-abuse check failed:', error.message);
            return true; // Fail open - don't block users if Redis fails
        }
    }
    
    /**
     * Get daily limit for an action
     */
    static getDailyLimit(action) {
        const limits = {
            'ARTICLE_READ': ANTI_ABUSE.MAX_ARTICLE_READS_PER_DAY,
            'ARTICLE_READ_FULL': ANTI_ABUSE.MAX_ARTICLE_READS_PER_DAY,
            'COMMENT_POST': ANTI_ABUSE.MAX_COMMENTS_PER_DAY,
            'ARTICLE_LIKE': ANTI_ABUSE.MAX_LIKES_PER_DAY,
            'REEL_LIKE': ANTI_ABUSE.MAX_LIKES_PER_DAY,
            'ARTICLE_SHARE': ANTI_ABUSE.MAX_SHARES_PER_DAY,
            'REEL_SHARE': ANTI_ABUSE.MAX_SHARES_PER_DAY,
        };
        return limits[action] || 100;
    }
    
    /**
     * Get cooldown time for an action in milliseconds
     */
    static getCooldown(action) {
        const cooldowns = {
            'ARTICLE_READ': ANTI_ABUSE.COOLDOWN_BETWEEN_READS_MS,
            'ARTICLE_READ_FULL': ANTI_ABUSE.COOLDOWN_BETWEEN_READS_MS,
            'ARTICLE_LIKE': ANTI_ABUSE.COOLDOWN_BETWEEN_LIKES_MS,
            'REEL_LIKE': ANTI_ABUSE.COOLDOWN_BETWEEN_LIKES_MS,
        };
        return cooldowns[action] || 0;
    }
    
    /**
     * Update user stats based on action
     */
    static updateStats(userPoints, action, metadata) {
        const statsMap = {
            'ARTICLE_READ': 'articlesRead',
            'ARTICLE_READ_FULL': 'articlesRead',
            'ARTICLE_LIKE': 'articlesLiked',
            'COMMENT_POST': 'commentsPosted',
            'COMMENT_RECEIVED_LIKE': 'commentsLiked',
            'ARTICLE_SHARE': 'sharesCompleted',
            'REEL_SHARE': 'sharesCompleted',
            'REEL_WATCH': 'reelsWatched',
            'REFERRAL_SIGNUP': 'referrals',
            'REFERRAL_ACTIVE': 'referrals',
        };
        
        const statField = statsMap[action];
        if (statField && userPoints.stats[statField] !== undefined) {
            // Don't double-count ARTICLE_READ_FULL if already counted ARTICLE_READ
            if (action !== 'ARTICLE_READ_FULL') {
                userPoints.stats[statField] += 1;
            }
        }
        
        // Update category stats for reading/liking articles
        if (metadata.category && ['ARTICLE_READ', 'ARTICLE_LIKE'].includes(action)) {
            const currentCount = userPoints.categoryStats.get(metadata.category) || 0;
            userPoints.categoryStats.set(metadata.category, currentCount + 1);
        }
    }
    
    /**
     * Calculate level from lifetime points
     */
    static calculateLevel(lifetimePoints) {
        for (let i = LEVELS.length - 1; i >= 0; i--) {
            if (lifetimePoints >= LEVELS[i].pointsRequired) {
                return LEVELS[i].level;
            }
        }
        return 1;
    }
    
    /**
     * Check and award any newly earned badges
     */
    static async checkAndAwardBadges(userId, userPoints) {
        try {
            const allBadges = await Badge.find({ isActive: true }).lean();
            const earnedBadgeIds = (await UserBadge.find({ userId }).select('badgeId').lean())
                .map(ub => ub.badgeId.toString());
            
            const newBadges = [];
            
            for (const badge of allBadges) {
                // Skip if already earned
                if (earnedBadgeIds.includes(badge._id.toString())) continue;
                
                // Check if requirement is met
                const earned = this.checkBadgeRequirement(badge, userPoints);
                if (earned) {
                    // Award the badge
                    await UserBadge.create({
                        userId,
                        badgeId: badge._id
                    });
                    
                    console.log(`🏆 Badge earned: ${badge.name} for user ${userId}`);
                    
                    // Award bonus points for earning badge (if any)
                    if (badge.pointsAwarded > 0) {
                        userPoints.totalPoints += badge.pointsAwarded;
                        userPoints.lifetimePoints += badge.pointsAwarded;
                        await userPoints.save();
                        
                        // Log the bonus transaction
                        await PointTransaction.create({
                            userId,
                            points: badge.pointsAwarded,
                            action: 'badge_earned',
                            metadata: {
                                badgeId: badge._id,
                                description: `Earned "${badge.name}" badge`
                            }
                        });
                    }
                    
                    newBadges.push(badge);
                    
                    // Send push notification (non-blocking)
                    this.sendBadgeNotification(userId, badge).catch(console.error);
                }
            }
            
            return newBadges;
            
        } catch (error) {
            console.error('❌ Check badges error:', error);
            return [];
        }
    }
    
    /**
     * Check if a badge requirement is met
     */
    static checkBadgeRequirement(badge, userPoints) {
        const { type, value, category } = badge.requirement;
        
        switch (type) {
            case 'articles_read':
                return userPoints.stats.articlesRead >= value;
            case 'articles_liked':
                return userPoints.stats.articlesLiked >= value;
            case 'comments_posted':
                return userPoints.stats.commentsPosted >= value;
            case 'comments_liked':
                return userPoints.stats.commentsLiked >= value;
            case 'shares':
                return userPoints.stats.sharesCompleted >= value;
            case 'streak_days':
                return userPoints.streak.longest >= value;
            case 'total_points':
                return userPoints.lifetimePoints >= value;
            case 'daily_logins':
                return userPoints.stats.dailyLogins >= value;
            case 'level':
                return userPoints.level >= value;
            case 'category_articles':
                return (userPoints.categoryStats.get(category) || 0) >= value;
            case 'referrals':
                return userPoints.stats.referrals >= value;
            default:
                console.warn(`⚠️ Unknown badge requirement type: ${type}`);
                return false;
        }
    }
    
    /**
     * Send push notification for badge earned
     */
    static async sendBadgeNotification(userId, badge) {
        try {
            const NotificationService = require('../utils/notificationService');
            
            await NotificationService.sendToUser(userId, {
                title: '🏆 New Badge Earned!',
                body: `You've earned the "${badge.name}" badge!`,
                data: {
                    type: 'badge_earned',
                    badgeId: badge._id.toString(),
                    badgeName: badge.name
                }
            });
            
            // Mark as notified
            await UserBadge.updateOne(
                { userId, badgeId: badge._id },
                { notified: true }
            );
            
        } catch (error) {
            console.error('❌ Badge notification error:', error.message);
        }
    }
    
    /**
     * Get user's gamification profile
     */
    static async getProfile(userId) {
        try {
            let userPoints = await UserPoints.findOne({ userId });
            if (!userPoints) {
                userPoints = await UserPoints.create({ userId });
            }
            
            // Get badges
            const userBadges = await UserBadge.find({ userId })
                .populate('badgeId')
                .sort({ earnedAt: -1 })
                .lean();
            
            // Calculate level info
            const { calculateLevelProgress } = require('../utils/pointsConfig');
            const levelProgress = calculateLevelProgress(userPoints.lifetimePoints);
            
            return {
                points: {
                    total: userPoints.totalPoints,
                    lifetime: userPoints.lifetimePoints,
                },
                level: {
                    current: userPoints.level,
                    title: levelProgress.current.title,
                    titleAr: levelProgress.current.titleAr,
                    pointsToNext: levelProgress.pointsToNext,
                    progress: levelProgress.progress,
                    nextTitle: levelProgress.next?.title || null
                },
                streak: {
                    current: userPoints.streak.current,
                    longest: userPoints.streak.longest,
                    lastActivity: userPoints.streak.lastActivityDate
                },
                stats: userPoints.stats,
                badges: userBadges
                    .filter(ub => ub.badgeId) // Filter out any with deleted badges
                    .map(ub => ({
                        ...ub.badgeId,
                        earnedAt: ub.earnedAt,
                        isDisplayed: ub.isDisplayed
                    })),
                categoryStats: Object.fromEntries(userPoints.categoryStats || new Map()),
                updatedAt: userPoints.updatedAt
            };
            
        } catch (error) {
            console.error('❌ Get profile error:', error);
            throw error;
        }
    }
    
    /**
     * Invalidate user's cache
     */
    static async invalidateCache(userId) {
        if (!redis.isConnected || !redis.isConnected()) return;
        
        try {
            await redis.del(`gamification:profile:${userId}`);
            // Also invalidate leaderboard caches
            await redis.del('gamification:leaderboard:points:20');
            await redis.del('gamification:leaderboard:streak:20');
            await redis.del('gamification:leaderboard:level:20');
        } catch (error) {
            console.error('❌ Cache invalidation error:', error.message);
        }
    }
}

module.exports = PointsService;
