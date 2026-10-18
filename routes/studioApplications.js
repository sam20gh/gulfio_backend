/**
 * Publisher applications — the review desk (/api/studio/applications, admin only).
 *
 * Mounted inside routes/studio.js, after requireStudio, so `req.studio` is set.
 * Approval is the only place that turns an application into Sources + publisher
 * access; it claims the application atomically so two admins can't approve twice.
 */
const express = require('express');

const PublisherApplication = require('../models/PublisherApplication');
const Source = require('../models/Source');
const User = require('../models/User');
const { invalidateScopeCache } = require('../middleware/studioAuth');
const { invalidateSourceCache } = require('../utils/sourceCache');
const { verifyDomain, probeFeed, instructionsFor } = require('../utils/publisherChecks');
const { readiness } = require('./publisherPortal');

const router = express.Router();

const REVIEWABLE = ['submitted', 'in_review'];
const FREQUENCIES = ['hourly', '3hours', '6hours', '9hours', '12hours', 'daily', 'weekly'];
const isId = (v) => typeof v === 'string' && /^[a-f0-9]{24}$/i.test(v);
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

router.use((req, res, next) => {
    if (!req.studio?.isAdmin) return res.status(403).json({ message: 'Only admins can review publisher applications.' });
    next();
});

const actor = (req) => ({
    by: req.studio.user?._id,
    byName: req.studio.user?.name || req.studio.user?.email || 'Gulfio service',
});

const fail = (res, err, fallback) => {
    console.error('studioApplications:', err);
    res.status(err.name === 'ValidationError' ? 400 : 500).json({ message: err.name === 'ValidationError' ? err.message : fallback });
};

/** Sources already on Gulfio for this domain, and groups that look like this publication. */
async function conflictsFor(app) {
    const host = app.domain?.host;
    const name = app.organization?.publicationName?.trim();
    const hostRx = host ? new RegExp(`^https?://([a-z0-9-]+\\.)*${escapeRegex(host)}(?=[/:?#]|$)`, 'i') : null;

    const [sources, groups, others] = await Promise.all([
        hostRx
            ? Source.find({ $or: [{ url: hostRx }, { baseUrl: hostRx }] }).select('name groupName status type url').limit(30).lean()
            : [],
        Source.distinct('groupName'),
        host
            ? PublisherApplication.find({ _id: { $ne: app._id }, 'domain.host': host })
                .select('status organization.publicationName applicant submittedAt').populate('applicant', 'email').lean()
            : [],
    ]);
    const sourceGroups = new Set(sources.map((s) => s.groupName).filter(Boolean));
    const matchingGroups = groups.filter(Boolean).filter((g) => sourceGroups.has(g) || (name && g.trim().toLowerCase() === name.toLowerCase()));
    return {
        sources,
        groups: matchingGroups,
        otherApplications: others.map((o) => ({
            _id: o._id, status: o.status, publicationName: o.organization?.publicationName, email: o.applicant?.email, submittedAt: o.submittedAt,
        })),
    };
}

const summary = (a) => ({
    _id: a._id,
    status: a.status,
    publicationName: a.organization?.publicationName || '(untitled)',
    logoUrl: a.organization?.logoUrl || null,
    host: a.domain?.host || null,
    verified: Boolean(a.domain?.verifiedAt),
    country: a.organization?.country || null,
    languages: a.organization?.languages || [],
    feeds: (a.feeds || []).length,
    feedsOk: (a.feeds || []).filter((f) => f.lastTest?.ok).length,
    applicant: a.applicant && typeof a.applicant === 'object' ? { _id: a.applicant._id, email: a.applicant.email, name: a.applicant.name || '' } : null,
    submittedAt: a.submittedAt || null,
    updatedAt: a.updatedAt,
    createdAt: a.createdAt,
});

// ----------------------------------------------------------------------------
// reads
// ----------------------------------------------------------------------------

router.get('/', async (req, res) => {
    try {
        const filter = {};
        const status = String(req.query.status || '');
        if (status === 'open') filter.status = { $in: REVIEWABLE };
        else if (PublisherApplication.STATUSES.includes(status)) filter.status = status;
        if (req.query.q) {
            const rx = new RegExp(escapeRegex(String(req.query.q).trim()), 'i');
            filter.$or = [{ 'organization.publicationName': rx }, { 'organization.legalName': rx }, { 'domain.host': rx }, { 'contact.email': rx }];
        }

        const [items, counts] = await Promise.all([
            PublisherApplication.find(filter)
                .select('status organization.publicationName organization.logoUrl organization.country organization.languages domain.host domain.verifiedAt feeds.lastTest.ok feeds.kind applicant submittedAt updatedAt createdAt')
                .populate('applicant', 'email name')
                .sort({ submittedAt: -1, updatedAt: -1 })
                .limit(200)
                .lean(),
            PublisherApplication.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
        ]);
        const byStatus = Object.fromEntries(PublisherApplication.STATUSES.map((s) => [s, 0]));
        counts.forEach((c) => { byStatus[c._id] = c.count; });
        res.json({ items: items.map(summary), byStatus });
    } catch (err) {
        fail(res, err, 'Could not load applications.');
    }
});

/** Cheap count for the sidebar badge. */
router.get('/count', async (req, res) => {
    try {
        res.json({ open: await PublisherApplication.countDocuments({ status: { $in: REVIEWABLE } }) });
    } catch (err) {
        fail(res, err, 'Could not count applications.');
    }
});

async function detail(id) {
    const app = await PublisherApplication.findById(id)
        .populate('applicant', 'email name type publisher_group createdAt')
        .populate('decidedBy', 'email name')
        .lean();
    if (!app) return null;
    const conflicts = await conflictsFor(app).catch(() => ({ sources: [], groups: [], otherApplications: [] }));
    return {
        ...app,
        domain: { ...(app.domain || {}), instructions: app.domain?.host && app.domain?.token ? instructionsFor(app.domain.host, app.domain.token) : null },
        readiness: readiness(app),
        conflicts,
    };
}

router.get('/:id', async (req, res) => {
    try {
        if (!isId(req.params.id)) return res.status(404).json({ message: 'Application not found.' });
        const out = await detail(req.params.id);
        if (!out) return res.status(404).json({ message: 'Application not found.' });
        res.json(out);
    } catch (err) {
        fail(res, err, 'Could not load the application.');
    }
});

// ----------------------------------------------------------------------------
// review actions
// ----------------------------------------------------------------------------

/** Atomically move between statuses; 409 if someone else moved it first. */
async function transition(req, res, from, to, { note, set = {} } = {}) {
    if (!isId(req.params.id)) return res.status(404).json({ message: 'Application not found.' });
    const app = await PublisherApplication.findOneAndUpdate(
        { _id: req.params.id, status: { $in: from } },
        { $set: { status: to, ...set }, $push: { history: { at: new Date(), ...actor(req), action: to, note } } },
        { new: true },
    );
    if (!app) {
        const exists = await PublisherApplication.exists({ _id: req.params.id });
        return res.status(exists ? 409 : 404).json({ message: exists ? 'The application has moved on since you opened it. Reload to see its current state.' : 'Application not found.' });
    }
    res.json(await detail(req.params.id));
}

router.post('/:id/start-review', (req, res) =>
    transition(req, res, ['submitted'], 'in_review').catch((err) => fail(res, err, 'Could not start the review.')));

router.post('/:id/request-changes', (req, res) => {
    const message = String(req.body?.message || '').trim().slice(0, 4000);
    if (message.length < 10) return res.status(400).json({ message: 'Tell the applicant what to change (at least a sentence).' });
    return transition(req, res, ['submitted', 'in_review', 'rejected'], 'changes_requested', { note: message, set: { reviewerMessage: message } })
        .catch((err) => fail(res, err, 'Could not send the request.'));
});

router.post('/:id/reject', (req, res) => {
    const message = String(req.body?.message || '').trim().slice(0, 4000);
    if (message.length < 10) return res.status(400).json({ message: 'Give the applicant a reason (at least a sentence).' });
    return transition(req, res, ['submitted', 'in_review', 'changes_requested'], 'rejected', {
        note: message,
        set: { reviewerMessage: message, decidedAt: new Date(), decidedBy: req.studio.user?._id },
    }).catch((err) => fail(res, err, 'Could not reject the application.'));
});

router.patch('/:id/notes', async (req, res) => {
    try {
        if (!isId(req.params.id)) return res.status(404).json({ message: 'Application not found.' });
        const notes = String(req.body?.internalNotes ?? '').slice(0, 8000);
        const app = await PublisherApplication.findByIdAndUpdate(req.params.id, { $set: { internalNotes: notes } }, { new: true }).select('_id').lean();
        if (!app) return res.status(404).json({ message: 'Application not found.' });
        res.json({ internalNotes: notes });
    } catch (err) {
        fail(res, err, 'Could not save the notes.');
    }
});

router.post('/:id/recheck-domain', async (req, res) => {
    try {
        if (!isId(req.params.id)) return res.status(404).json({ message: 'Application not found.' });
        const app = await PublisherApplication.findById(req.params.id);
        if (!app) return res.status(404).json({ message: 'Application not found.' });
        if (!app.domain?.host || !app.domain.token) return res.status(400).json({ message: 'The applicant hasn’t entered a website.' });
        const result = await verifyDomain(app.domain.host, app.domain.token);
        app.domain.lastCheckedAt = result.checkedAt;
        app.domain.checks = result.checks;
        // A re-check can confirm, never revoke: records get cleaned up after verification.
        if (result.verified && !app.domain.verifiedAt) {
            app.domain.verifiedAt = result.checkedAt;
            app.domain.method = result.method;
        }
        await app.save();
        res.json(await detail(req.params.id));
    } catch (err) {
        fail(res, err, 'Could not re-check the domain.');
    }
});

router.post('/:id/test-feed', async (req, res) => {
    try {
        if (!isId(req.params.id)) return res.status(404).json({ message: 'Application not found.' });
        const app = await PublisherApplication.findById(req.params.id);
        const feed = app?.feeds.id(req.body?.feedId);
        if (!feed) return res.status(404).json({ message: 'Feed not found.' });
        feed.lastTest = await probeFeed({ kind: feed.kind, url: feed.url }, app.domain?.host || null);
        await app.save();
        res.json(await detail(req.params.id));
    } catch (err) {
        fail(res, err, 'Could not test the feed.');
    }
});

// ----------------------------------------------------------------------------
// approval
// ----------------------------------------------------------------------------

const normUrl = (u) => String(u || '').trim().replace(/\/+$/, '').toLowerCase();

/**
 * POST /:id/approve
 * { groupName, revSharePercent?, frequency?, message?, feeds: [{ id, include, name?, category?, language? }] }
 *
 * RSS/Atom feeds become live `rss` sources. Website, sitemap and API entries become
 * suspended `website` sources for an admin to configure (Diagnose & fix). YouTube and
 * Instagram attach to the first source created, or to a media-only source if that's all
 * there is. Feeds whose URL is already a Source are skipped, never duplicated.
 */
router.post('/:id/approve', async (req, res) => {
    if (!isId(req.params.id)) return res.status(404).json({ message: 'Application not found.' });
    const body = req.body || {};

    const pct = body.revSharePercent === undefined || body.revSharePercent === '' ? 70 : Number(body.revSharePercent);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) return res.status(400).json({ message: 'Rev share must be between 0 and 100.' });
    const frequency = FREQUENCIES.includes(body.frequency) ? body.frequency : '3hours';
    const requested = String(body.groupName || '').trim().slice(0, 120);
    if (!requested) return res.status(400).json({ message: 'Choose the publisher group name.' });

    const existing = await PublisherApplication.findById(req.params.id).lean();
    if (!existing) return res.status(404).json({ message: 'Application not found.' });
    if (!REVIEWABLE.includes(existing.status)) return res.status(409).json({ message: 'Only submitted applications can be approved.' });
    if (!existing.domain?.verifiedAt) return res.status(400).json({ message: 'The domain isn’t verified yet. Re-check it before approving.' });

    // Re-use a group's canonical casing if it already exists ("arab news" vs "Arab News").
    const groups = (await Source.distinct('groupName')).filter(Boolean);
    const groupName = groups.find((g) => g.trim().toLowerCase() === requested.toLowerCase()) || requested;
    const joinedExisting = groups.includes(groupName);

    const choices = new Map((Array.isArray(body.feeds) ? body.feeds : []).map((f) => [String(f.id), f]));
    const selected = existing.feeds
        .map((f) => ({ feed: f, choice: choices.get(String(f._id)) || {} }))
        .filter(({ choice }) => choice.include !== false);

    // Claim it first so a second approve (double click, two admins) gets a 409.
    const claimed = await PublisherApplication.findOneAndUpdate(
        { _id: existing._id, status: { $in: REVIEWABLE } },
        { $set: { status: 'approved', decidedAt: new Date(), decidedBy: req.studio.user?._id } },
        { new: true },
    );
    if (!claimed) return res.status(409).json({ message: 'Someone else has just decided this application. Reload to see it.' });

    const created = [];
    const skipped = [];
    try {
        const org = existing.organization || {};
        const host = existing.domain.host;
        const base = {
            groupName,
            baseUrl: `https://${host}`,
            icon: org.logoUrl || undefined,
            frequency,
            revSharePercent: pct,
            articleType: 'mainPage',
        };
        const defaults = { language: org.languages?.[0] || 'english', category: org.categories?.[0] || 'news' };
        const existingUrls = new Set(
            (await Source.find({ url: { $in: selected.map(({ feed }) => feed.url) } }).select('url').lean()).map((s) => normUrl(s.url)),
        );
        // Also catch trailing-slash / case variants the $in above misses.
        const hostRx = new RegExp(`^https?://([a-z0-9-]+\\.)*${escapeRegex(host)}`, 'i');
        (await Source.find({ url: hostRx }).select('url').lean()).forEach((s) => existingUrls.add(normUrl(s.url)));

        let youtube = null;
        let instagram = null;
        const docs = [];
        for (const { feed, choice } of selected) {
            if (feed.kind === 'youtube') { if (!youtube) youtube = feed.url; else skipped.push({ url: feed.url, reason: 'Only one YouTube channel is attached automatically.' }); continue; }
            if (feed.kind === 'instagram') { if (!instagram) instagram = feed.url; else skipped.push({ url: feed.url, reason: 'Only one Instagram account is attached automatically.' }); continue; }
            if (existingUrls.has(normUrl(feed.url))) { skipped.push({ url: feed.url, reason: 'Already a Gulfio source.' }); continue; }
            existingUrls.add(normUrl(feed.url));

            const live = feed.kind === 'rss' || feed.kind === 'atom';
            const label = String(choice.name || '').trim() || feed.label || '';
            docs.push({
                ...base,
                name: label || (docs.length ? `${org.publicationName} · ${feed.kind.toUpperCase()}` : org.publicationName),
                url: feed.url,
                type: live ? 'rss' : 'website',
                status: live ? 'active' : 'suspended',
                language: String(choice.language || feed.language || defaults.language).toLowerCase(),
                category: String(choice.category || feed.category || defaults.category).toLowerCase(),
            });
        }

        if (!docs.length && (youtube || instagram)) {
            // Video-only applicant: a media-only source so reels/videos still flow.
            docs.push({ ...base, ...defaults, name: org.publicationName, url: `https://${host}`, type: 'website', status: 'active', skipArticles: true });
        }
        if (docs.length) {
            if (youtube) docs[0].youtubeChannelId = youtube;
            if (instagram) docs[0].instagramUsername = instagram.replace(/^@/, '');
        } else if (youtube || instagram) {
            skipped.push({ url: youtube || instagram, reason: 'No source to attach the social account to.' });
        }

        for (const doc of docs) {
            const s = await Source.create(doc);
            created.push({ _id: s._id, name: s.name, type: s.type, status: s.status, url: s.url });
        }

        const message = String(body.message || '').trim().slice(0, 4000);
        claimed.result = { groupName, sourceIds: created.map((c) => c._id), revSharePercent: pct };
        claimed.reviewerMessage = message || undefined;
        claimed.history.push({
            at: new Date(),
            ...actor(req),
            action: 'approved',
            note: message || `Group “${groupName}”${joinedExisting ? ' (existing)' : ''} · ${created.length} source${created.length === 1 ? '' : 's'} created`,
        });
        await claimed.save();

        // Promote last, without ever demoting an admin, keeping any groups they already act for.
        const applicant = await User.findById(existing.applicant).select('type').lean();
        await User.updateOne(
            { _id: existing.applicant },
            { ...(applicant?.type === 'admin' ? {} : { $set: { type: 'publisher' } }), $addToSet: { publisher_group: groupName } },
        );

        await invalidateSourceCache().catch(() => {});
        invalidateScopeCache();
        res.json({ application: await detail(req.params.id), created, skipped, groupName, joinedExisting });
    } catch (err) {
        // Undo: these sources are seconds old and have no content.
        if (created.length) await Source.deleteMany({ _id: { $in: created.map((c) => c._id) } }).catch(() => {});
        await PublisherApplication.updateOne(
            { _id: existing._id },
            { $set: { status: existing.status }, $unset: { decidedAt: 1, decidedBy: 1, result: 1 } },
        ).catch(() => {});
        fail(res, err, 'Approval failed and was rolled back. Nothing was created.');
    }
});

module.exports = router;
