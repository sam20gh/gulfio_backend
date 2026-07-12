// utils/matchAlerts.js
//
// Goal/kickoff/full-time push alerts for followed teams. Designed to be
// invoked every ~2 minutes during match hours by Cloud Scheduler hitting
// POST /api/football/poll-live-alerts (admin key protected).
//
// Flow per invocation:
//   1. Collect the api-football team ids anyone follows (User.followed_teams).
//   2. Fetch all live fixtures once; keep only those involving followed teams.
//   3. Diff each against the previous pass's snapshot in Redis (one JSON key,
//      matchalert:active = { [fixtureId]: {hId,aId,hName,aName,h,a} }):
//        - first sighting in the opening minutes  → kickoff alert
//        - first sighting mid-match               → silent baseline (no spam
//          after deploys/scheduler gaps) but still tracked
//        - score increased                        → goal alert
//   4. Full time is detected by DISAPPEARANCE: a followed fixture present in
//      the previous snapshot but absent from the current live payload has
//      finished — send a full-time alert from its last-known score.
//   5. Push to followers of either team (both device-token formats),
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

const ACTIVE_KEY = 'matchalert:active';
const STATE_TTL_SECONDS = 6 * 60 * 60; // active-fixtures snapshot
const KICKOFF_WINDOW_MINUTES = 5;      // first sighting later than this = silent baseline

/**
 * Pure: decide the in-play event from the previous snapshot entry (or
 * undefined) and the current one. Exported for testing.
 * Returns null | { kind: 'kickoff' } | { kind: 'goal', scoringSide }.
 */
function detectInPlayEvent(prev, current) {
    if (!prev) {
        if (
            current.elapsed != null &&
            current.elapsed <= KICKOFF_WINDOW_MINUTES &&
            current.h === 0 &&
            current.a === 0
        ) {
            return { kind: 'kickoff' };
        }
        return null; // mid-match baseline — stay silent, but caller still tracks it
    }
    if (current.h > prev.h) return { kind: 'goal', scoringSide: 'home' };
    if (current.a > prev.a) return { kind: 'goal', scoringSide: 'away' };
    // Score decrease (VAR overturn) or unchanged — silent
    return null;
}

/**
 * Pure: build the push title/body for an event from a fixture meta snapshot
 * ({ hName, aName, h, a, elapsed? }). Exported for testing.
 */
function buildMessage(meta, event) {
    const score = `${meta.h}–${meta.a}`;

    if (event.kind === 'kickoff') {
        return {
            title: `🟢 Kickoff: ${meta.hName} vs ${meta.aName}`,
            body: 'Follow the match live in Gulfio',
        };
    }

    if (event.kind === 'fulltime') {
        return {
            title: `⏱️ Full time: ${meta.hName} ${score} ${meta.aName}`,
            body: 'See the match report in Gulfio',
        };
    }

    const scorer = event.scoringSide === 'home' ? meta.hName : meta.aName;
    return {
        title: `⚽ GOAL! ${meta.hName} ${score} ${meta.aName}`,
        body: `${meta.elapsed ? `${meta.elapsed}' — ` : ''}${scorer} score`,
    };
}

/** Collect unique push tokens across both token formats. Exported for testing. */
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

async function notifyTeamFollowers(teamDocIds, fixtureId, title, body) {
    const followers = await User.find({ followed_teams: { $in: teamDocIds } })
        .select('supabase_id pushToken pushTokens notificationSettings')
        .lean();

    const eligible = followers.filter((user) => isTypeEnabled(user, 'matchAlerts'));
    const tokens = collectTokens(eligible);
    if (tokens.length === 0) return 0;

    await sendExpoNotification(title, body, tokens, { type: 'match_alert', fixtureId });
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

    // 2. Previous active snapshot. Redis outage → fail closed (skip the pass)
    //    rather than risk spurious full-time/goal storms on the next read.
    let prevActive;
    try {
        const raw = await redis.get(ACTIVE_KEY);
        prevActive = raw ? JSON.parse(raw) : {};
    } catch {
        console.warn('⚠️ match-alert: Redis unavailable, skipping pass');
        return { liveFixtures: 0, relevant: 0, events: 0, devicesNotified: 0, skipped: true };
    }

    // 3. All live fixtures in one call
    const { data } = await axios.get(`${BASE_URL}/fixtures`, {
        params: { live: 'all' },
        headers: { 'x-apisports-key': API_KEY },
        timeout: 15000,
    });
    const fixtures = data?.response || [];

    const currentActive = {};
    let relevant = 0;
    let events = 0;
    let devicesNotified = 0;

    // 4. In-play events (goals/kickoffs) + build the current active snapshot
    for (const match of fixtures) {
        const homeId = match.teams?.home?.id;
        const awayId = match.teams?.away?.id;
        const homeDocId = apiIdToDocId.get(homeId);
        const awayDocId = apiIdToDocId.get(awayId);
        if (!homeDocId && !awayDocId) continue;
        relevant++;

        const fixtureId = String(match.fixture.id);
        const meta = {
            hId: homeId,
            aId: awayId,
            hName: match.teams.home.name,
            aName: match.teams.away.name,
            h: match.goals?.home ?? 0,
            a: match.goals?.away ?? 0,
            elapsed: match.fixture.status?.elapsed ?? null,
        };

        const event = detectInPlayEvent(prevActive[fixtureId], meta);
        // Persist without `elapsed` — it's only meaningful for the live message
        currentActive[fixtureId] = {
            hId: meta.hId,
            aId: meta.aId,
            hName: meta.hName,
            aName: meta.aName,
            h: meta.h,
            a: meta.a,
        };

        if (event) {
            events++;
            const { title, body } = buildMessage(meta, event);
            devicesNotified += await notifyTeamFollowers(
                [homeDocId, awayDocId].filter(Boolean),
                match.fixture.id,
                title,
                body
            );
            console.log(`⚽ match_alert ${event.kind} → fixture ${fixtureId}`);
        }
    }

    // 5. Full time: followed fixtures present last pass but gone from live now
    for (const [fixtureId, meta] of Object.entries(prevActive)) {
        if (currentActive[fixtureId]) continue; // still live
        const teamDocIds = [apiIdToDocId.get(meta.hId), apiIdToDocId.get(meta.aId)].filter(Boolean);
        if (teamDocIds.length === 0) continue; // nobody follows these teams anymore
        events++;
        const { title, body } = buildMessage(meta, { kind: 'fulltime' });
        devicesNotified += await notifyTeamFollowers(teamDocIds, Number(fixtureId), title, body);
        console.log(`⚽ match_alert fulltime → fixture ${fixtureId}`);
    }

    // 6. Persist the current snapshot for the next pass
    try {
        await redis.set(ACTIVE_KEY, JSON.stringify(currentActive), 'EX', STATE_TTL_SECONDS);
    } catch {
        // Non-fatal — next pass just re-baselines
    }

    return { liveFixtures: fixtures.length, relevant, events, devicesNotified };
}

module.exports = { pollLiveMatchAlerts, detectInPlayEvent, buildMessage, collectTokens };
