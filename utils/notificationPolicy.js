// utils/notificationPolicy.js
//
// Phase 0 push-notification discipline. Every proactive ("broadcast") push
// must pass through this policy before it is sent:
//   1. Holdout  — a deterministic 10% of users never receive broadcast pushes,
//                 so retention impact can be measured against a control group.
//   2. Quiet hours — no broadcast pushes 22:00–08:00 in the user's local time
//                 (derived from user.city; breaking news is exempt).
//   3. Daily budget — max 2 broadcast pushes per user per rolling 24h window,
//                 counted from Notification history documents.
//   4. Breaking-news cap — at most 2 distinct breaking-news blasts per 7 days.
//
// Transactional pushes (replies, likes, mentions, follows) are user-earned and
// are NOT throttled here.

const Notification = require('../models/Notification');

// Notification-settings keys that represent proactive/broadcast pushes.
const BROADCAST_SETTING_KEYS = new Set([
    'newsNotifications',
    'breakingNews',
    'followedSources',
    'weeklyDigest',
]);

// Notification-history `type` values counted against the daily broadcast budget.
const BROADCAST_HISTORY_TYPES = ['news', 'breaking_news', 'followed_source', 'weekly_digest', 'lotto'];

const DAILY_BROADCAST_LIMIT = 2;
const HOLDOUT_PERCENT = 10;
const QUIET_START_HOUR = 22; // 10 PM local
const QUIET_END_HOUR = 8;    // 8 AM local
const BREAKING_WEEKLY_CAP = 2;

// Mirrors the User schema defaults — the single source of truth for what a
// missing settings object/key means. Explicit `false` always disables.
const SETTING_DEFAULTS = {
    newsNotifications: true,
    userNotifications: true,
    breakingNews: true,
    weeklyDigest: false,
    followedSources: true,
    articleLikes: true,
    newFollowers: true,
    mentions: true,
};

// UTC offsets in hours for the cities available in the User schema.
const CITY_UTC_OFFSETS = {
    'Dubai': 4,
    'Abu Dhabi': 4,
    'Jeddah': 3,
    'Riyadh': 3,
    'Doha': 3,
    'Kuwait': 3,
    'Manamah': 3,
    'Tehran': 3.5,
    'Baghdad': 3,
    'Amman': 3,
};
const DEFAULT_UTC_OFFSET = 4; // Dubai

function isBroadcastSetting(settingKey) {
    return BROADCAST_SETTING_KEYS.has(settingKey);
}

/**
 * Whether the user has this notification type enabled. Missing settings
 * object or missing key falls back to the schema default; explicit false
 * disables. This is the ONE semantic — the scrapers previously treated a
 * missing key as disabled while the service treated it as enabled.
 */
function isTypeEnabled(user, settingKey) {
    const settings = user.notificationSettings || {};
    if (settings[settingKey] === false) return false;
    if (settings[settingKey] === true) return true;
    return SETTING_DEFAULTS[settingKey] !== false;
}

/**
 * Deterministic 0–99 bucket from the Supabase user id (djb2 hash).
 * Stable across sessions and deploys — no DB writes needed.
 */
function getUserBucket(supabaseId) {
    let hash = 5381;
    const str = String(supabaseId || '');
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
    }
    return Math.abs(hash) % 100;
}

/** Users in buckets 0–9 (10%) receive no broadcast pushes — the control group. */
function isHoldoutUser(supabaseId) {
    return getUserBucket(supabaseId) < HOLDOUT_PERCENT;
}

function getUtcOffsetHours(user) {
    return CITY_UTC_OFFSETS[user?.city] ?? DEFAULT_UTC_OFFSET;
}

/** Local hour (0–23) for the user's city at `now`. */
function getLocalHour(user, now = new Date()) {
    const utcHours = now.getUTCHours() + now.getUTCMinutes() / 60;
    return ((utcHours + getUtcOffsetHours(user)) % 24 + 24) % 24;
}

/** True between 22:00 and 08:00 in the user's local time. */
function isQuietHours(user, now = new Date()) {
    const hour = getLocalHour(user, now);
    return hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR;
}

/**
 * Count broadcast-type notifications per user over the last 24h.
 * @param {string[]} userIds - Supabase ids
 * @returns {Map<string, number>}
 */
async function getBroadcastCounts(userIds) {
    if (!userIds.length) return new Map();
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const rows = await Notification.aggregate([
        {
            $match: {
                userId: { $in: userIds },
                type: { $in: BROADCAST_HISTORY_TYPES },
                createdAt: { $gte: since },
            },
        },
        { $group: { _id: '$userId', count: { $sum: 1 } } },
    ]);
    return new Map(rows.map(r => [r._id, r.count]));
}

/**
 * Filter a list of user docs down to those allowed to receive a broadcast
 * push right now. Applies holdout, quiet hours, and the rolling daily budget.
 *
 * @param {Array} users - User docs with supabase_id, pushToken, city
 * @param {Object} [opts]
 * @param {boolean} [opts.bypassQuietHours=false] - breaking news is allowed at night
 * @param {boolean} [opts.bypassBudget=false]     - breaking news ignores the daily cap
 * @param {Date}    [opts.now]
 * @returns {{ eligible: Array, skipped: { holdout: number, quietHours: number, budget: number } }}
 */
async function filterBroadcastEligible(users, opts = {}) {
    const { bypassQuietHours = false, bypassBudget = false, now = new Date() } = opts;
    const skipped = { holdout: 0, quietHours: 0, budget: 0 };

    let candidates = [];
    for (const user of users) {
        if (isHoldoutUser(user.supabase_id)) { skipped.holdout++; continue; }
        if (!bypassQuietHours && isQuietHours(user, now)) { skipped.quietHours++; continue; }
        candidates.push(user);
    }

    if (!bypassBudget && candidates.length) {
        const counts = await getBroadcastCounts(candidates.map(u => u.supabase_id));
        candidates = candidates.filter(user => {
            if ((counts.get(user.supabase_id) || 0) >= DAILY_BROADCAST_LIMIT) {
                skipped.budget++;
                return false;
            }
            return true;
        });
    }

    return { eligible: candidates, skipped };
}

/**
 * Global once-per-window check for scheduled blasts (e.g. the daily news
 * digest). True if any notification of `type` was recorded in the last
 * `windowHours` — 20h (not 24h) so a daily cron that drifts a little later
 * or earlier never skips a whole day.
 */
async function wasBroadcastSentRecently(type, windowHours = 20) {
    const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);
    const existing = await Notification.findOne({ type, createdAt: { $gte: since } })
        .select('_id')
        .lean();
    return !!existing;
}

/**
 * Breaking-news blasts are capped at BREAKING_WEEKLY_CAP distinct articles
 * per rolling 7 days, and the same article is never blasted twice.
 * @returns {{ allowed: boolean, reason?: string, recentCount: number }}
 */
async function canSendBreakingBlast(articleId) {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const recentArticleIds = await Notification.distinct('data.articleId', {
        type: 'breaking_news',
        createdAt: { $gte: since },
    });
    const idStr = String(articleId);
    if (recentArticleIds.some(id => String(id) === idStr)) {
        return { allowed: false, reason: 'already_sent_for_article', recentCount: recentArticleIds.length };
    }
    if (recentArticleIds.length >= BREAKING_WEEKLY_CAP) {
        return { allowed: false, reason: 'weekly_cap_reached', recentCount: recentArticleIds.length };
    }
    return { allowed: true, recentCount: recentArticleIds.length };
}

module.exports = {
    BROADCAST_SETTING_KEYS,
    BROADCAST_HISTORY_TYPES,
    DAILY_BROADCAST_LIMIT,
    SETTING_DEFAULTS,
    isBroadcastSetting,
    isTypeEnabled,
    getUserBucket,
    isHoldoutUser,
    getUtcOffsetHours,
    getLocalHour,
    isQuietHours,
    getBroadcastCounts,
    filterBroadcastEligible,
    wasBroadcastSentRecently,
    canSendBreakingBlast,
};
