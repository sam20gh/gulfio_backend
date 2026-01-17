/**
 * 🎮 Gamification Points Configuration
 * Central configuration for all points, levels, and anti-abuse settings
 */

module.exports = {
    // Points awarded for each action
    POINTS: {
        // Reading
        ARTICLE_READ: 5,           // Reading an article for 30+ seconds
        ARTICLE_READ_FULL: 10,     // Scrolling to 80%+ of article
        ARTICLE_LIKE: 3,
        ARTICLE_SAVE: 2,
        ARTICLE_SHARE: 15,

        // Comments
        COMMENT_POST: 10,
        COMMENT_RECEIVED_LIKE: 2,  // Your comment got liked
        COMMENT_QUALITY_BONUS: 25, // AI-detected thoughtful comment (>100 chars, not spam)

        // Reels/Videos
        REEL_WATCH: 3,             // Watch 75%+
        REEL_LIKE: 2,
        REEL_SHARE: 10,

        // Engagement
        DAILY_LOGIN: 5,
        STREAK_BONUS: 5,           // Base streak bonus (multiplied by day)
        PROFILE_COMPLETE: 50,
        REFERRAL_SIGNUP: 100,
        REFERRAL_ACTIVE: 200,      // Referral becomes active (5+ articles read)

        // Badges
        BADGE_EARNED: 0,           // Bonus points defined per badge
    },

    // Level progression system
    LEVELS: [
        { level: 1, pointsRequired: 0, title: 'Newcomer', titleAr: 'مبتدئ' },
        { level: 2, pointsRequired: 100, title: 'Reader', titleAr: 'قارئ' },
        { level: 3, pointsRequired: 300, title: 'Enthusiast', titleAr: 'متحمس' },
        { level: 4, pointsRequired: 600, title: 'Contributor', titleAr: 'مساهم' },
        { level: 5, pointsRequired: 1000, title: 'Expert', titleAr: 'خبير' },
        { level: 6, pointsRequired: 2000, title: 'Influencer', titleAr: 'مؤثر' },
        { level: 7, pointsRequired: 4000, title: 'Champion', titleAr: 'بطل' },
        { level: 8, pointsRequired: 7000, title: 'Legend', titleAr: 'أسطورة' },
        { level: 9, pointsRequired: 12000, title: 'Icon', titleAr: 'أيقونة' },
        { level: 10, pointsRequired: 20000, title: 'Titan', titleAr: 'عملاق' },
    ],

    // Streak configuration
    STREAK: {
        RESET_HOUR: 4,             // Reset at 4 AM local time
        MAX_MULTIPLIER: 7,         // Cap streak multiplier at 7x
        GRACE_PERIOD_HOURS: 48,    // Hours before streak resets
    },

    // Anti-abuse rate limits
    ANTI_ABUSE: {
        MAX_ARTICLE_READS_PER_DAY: 50,
        MAX_COMMENTS_PER_DAY: 20,
        MAX_LIKES_PER_DAY: 100,
        MAX_SHARES_PER_DAY: 20,
        MIN_READ_TIME_SECONDS: 30,
        COOLDOWN_BETWEEN_READS_MS: 10000, // 10 seconds between point-earning reads
        COOLDOWN_BETWEEN_LIKES_MS: 1000,  // 1 second between likes
    },

    // Tier colors for UI
    TIER_COLORS: {
        bronze: '#CD7F32',
        silver: '#C0C0C0',
        gold: '#FFD700',
        platinum: '#E5E4E2',
        diamond: '#B9F2FF',
    },

    // Helper functions
    getLevelInfo: function (lifetimePoints) {
        for (let i = this.LEVELS.length - 1; i >= 0; i--) {
            if (lifetimePoints >= this.LEVELS[i].pointsRequired) {
                return this.LEVELS[i];
            }
        }
        return this.LEVELS[0];
    },

    getNextLevelInfo: function (currentLevel) {
        const nextIndex = this.LEVELS.findIndex(l => l.level === currentLevel) + 1;
        return nextIndex < this.LEVELS.length ? this.LEVELS[nextIndex] : null;
    },

    calculateLevelProgress: function (lifetimePoints) {
        const currentLevel = this.getLevelInfo(lifetimePoints);
        const nextLevel = this.getNextLevelInfo(currentLevel.level);

        if (!nextLevel) {
            return { current: currentLevel, next: null, progress: 100, pointsToNext: 0 };
        }

        const pointsIntoLevel = lifetimePoints - currentLevel.pointsRequired;
        const pointsForLevel = nextLevel.pointsRequired - currentLevel.pointsRequired;
        const progress = Math.min(100, (pointsIntoLevel / pointsForLevel) * 100);

        return {
            current: currentLevel,
            next: nextLevel,
            progress: Math.round(progress * 10) / 10,
            pointsToNext: nextLevel.pointsRequired - lifetimePoints
        };
    }
};
