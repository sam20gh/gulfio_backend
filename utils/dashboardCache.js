const redisClient = require('./redis');

// Single source of truth for the dashboard-summary cache key so the read path
// and every invalidation site agree on the exact key.
function dashboardSummaryKey(supabaseId) {
    return `user_dashboard_summary_${supabaseId}`;
}

// Fire-and-forget invalidation. Callers (follow/save/like/profile-edit) should
// never block on — or fail because of — Redis, so this swallows all errors.
function invalidateDashboardSummary(supabaseId) {
    if (!supabaseId || !redisClient.isConnected()) return;
    redisClient.del(dashboardSummaryKey(supabaseId)).catch(() => { });
}

module.exports = { dashboardSummaryKey, invalidateDashboardSummary };
