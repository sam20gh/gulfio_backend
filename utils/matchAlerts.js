// utils/matchAlerts.js
//
// Goal/kickoff push alerts for followed teams. Designed to be invoked every
// ~2 minutes during match hours by Cloud Scheduler hitting
// POST /api/football/poll-live-alerts (admin key protected).
//
// Flow per invocation:
//   1. Collect the api-football team ids anyone follows (User.followed_teams).
//   2. Fetch all live fixtures once; keep only those involving followed teams.
//   3. Diff each against its last-seen score in Redis:
//        - first sighting in the opening minutes  → kickoff alert
//        - first sighting mid-match               → silent baseline (no spam
//          after deploys/scheduler gaps)
//        - score increased                        → goal alert
//   4. Push to followers of either team (both device-token formats),
//      honouring the matchAlerts setting (default on).
//
// These are TARGETED, user-earned pushes — they do not count against the
// 2/day broadcast budget and are deliberately not quiet-hours filtered:
// European kickoffs are 22:00–midnight Gulf time, which is exactly when a
// football fan wants a goal alert. Opting out is one switch in settings.

const axios = require('axios');
const redis = require('./redis');
const User = require('../models/User');
const Team = require('../models/Team');
const sendExpoNotification = require('./sendExpoNotification');
const { isTypeEnabled } = require('./notificationPolicy');

const API_KEY = process.env.API_FOOTBALL_KEY;
const BASE_URL = process.env.API_FOOTBALL_BASE_URL || 'https://v3.football.api-sports.io';

const STATE_TTL_SECONDS = 6 * 60 * 60; // fixture score state
const KICKOFF_WINDOW_MINUTES = 5;      // first sighting later than this = silent baseline

const stateKey = (fixtureId) => `matchalert:${fixtureId}`;

/**
 * Compare a live fixture against its last-seen Redis state.
 * Returns null (no alert) or { kind: 'kickoff' | 'goal', scoringSide? }.
 * Always writes the current state back.
 */
async function detectEvent(match) {
    const fixtureId = match.fixture.id;
    const current = {
        h: match.goals?.home ?? 0,
        a: match.goals?.away ?? 0,
    };

    let previousRaw = null;
    try {
        previousRaw = await redis.get(stateKey(fixtureId));
    } catch {
        // Redis down — fail silent (no alerts) rather than spam on every poll
        return null;
    }

    try {
        await redis.set(stateKey(fixtureId), JSON.stringify(current), 'EX', STATE_TTL_SECONDS);
    } catch {
        return null;
    }

    if (!previousRaw) {
        const elapsed = match.fixture.status?.elapsed ?? 99;
        if (elapsed <= KICKOFF_WINDOW_MINUTES && current.h === 0 && current.a === 0) {
            return { kind: 'kickoff' };
        }
        return null; // mid-match baseline, stay silent
    }

    let previous;
    try {
        previous = JSON.parse(previousRaw);
    } catch {
        return null;
    }

    if (current.h > previous.h) return { kind: 'goal', scoringSide: 'home' };
    if (current.a > previous.a) return { kind: 'goal', scoringSide: 'away' };
    // Score decrease (VAR overturn) or unchanged — silent
    return null;
}

function buildMessage(match, event) {
    const home = match.teams.home.name;
    const away = match.teams.away.name;
    const score = `${match.goals?.home ?? 0}–${match.goals?.away ?? 0}`;
    const elapsed = match.fixture.status?.elapsed;

    if (event.kind === 'kickoff') {
        return {
            title: `🟢 Kickoff: ${home} vs ${away}`,
            body: 'Follow the match live in Gulfio',
        };
    }

    const scorer = event.scoringSide === 'home' ? home : away;
    return {
        title: `⚽ GOAL! ${home} ${score} ${away}`,
        body: `${elapsed ? `${elapsed}' — ` : ''}${scorer} score`,
    };
}

/** Collect unique push tokens across both token formats. */
function collectTokens(users) {
    const tokens = new Set();
    for (const user of users) {
        if (user.pushToken) tokens.add(user.pushToken);
        for (const device of user.pushTokens || []) {
            if (device.token) tokens.add(device.token);
        }
    }
    return [...tokens];
}

async function notifyFollowers(match, event, teamDocIds) {
    const followers = await User.find({ followed_teams: { $in: teamDocIds } })
        .select('supabase_id pushToken pushTokens notificationSettings')
        .lean();

    const eligible = followers.filter((user) => isTypeEnabled(user, 'matchAlerts'));
    const tokens = collectTokens(eligible);
    if (tokens.length === 0) return 0;

    const { title, body } = buildMessage(match, event);
    await sendExpoNotification(title, body, tokens, {
        type: 'match_alert',
        fixtureId: match.fixture.id,
    });
    console.log(`⚽ match_alert ${event.kind} → ${tokens.length} devices (fixture ${match.fixture.id})`);
    return tokens.length;
}

/**
 * One polling pass. Returns a summary for the scheduler response/logs.
 */
async function pollLiveMatchAlerts() {
    // 1. Which teams does anyone follow?
    const followedDocIds = await User.distinct('followed_teams', {
        'followed_teams.0': { $exists: true },
    });
    if (followedDocIds.length === 0) {
        return { liveFixtures: 0, relevant: 0, events: 0, devicesNotified: 0 };
    }

    const teams = await Team.find({ _id: { $in: followedDocIds } })
        .select('apiId')
        .lean();
    const apiIdToDocId = new Map(teams.map((t) => [t.apiId, t._id]));

    // 2. All live fixtures in one call
    const { data } = await axios.get(`${BASE_URL}/fixtures`, {
        params: { live: 'all' },
        headers: { 'x-apisports-key': API_KEY },
        timeout: 15000,
    });
    const fixtures = data?.response || [];

    let relevant = 0;
    let events = 0;
    let devicesNotified = 0;

    for (const match of fixtures) {
        const homeDocId = apiIdToDocId.get(match.teams?.home?.id);
        const awayDocId = apiIdToDocId.get(match.teams?.away?.id);
        if (!homeDocId && !awayDocId) continue;
        relevant++;

        const event = await detectEvent(match);
        if (!event) continue;
        events++;

        devicesNotified += await notifyFollowers(
            match,
            event,
            [homeDocId, awayDocId].filter(Boolean)
        );
    }

    return { liveFixtures: fixtures.length, relevant, events, devicesNotified };
}

module.exports = { pollLiveMatchAlerts, detectEvent, buildMessage, collectTokens };
