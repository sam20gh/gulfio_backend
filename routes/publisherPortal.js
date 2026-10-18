/**
 * Gulfio Publisher Portal — the applicant side (/api/publisher-portal).
 *
 * Anyone with a verified Supabase session may apply; they don't need Studio access
 * yet (that is what they're applying for). The admin review side lives in
 * routes/studioApplications.js under /api/studio/applications.
 *
 * Every URL here is applicant-supplied, so all fetching goes through utils/safeFetch
 * and the expensive checks are throttled per account.
 */
const express = require('express');
const NodeCache = require('node-cache');

const User = require('../models/User');
const PublisherApplication = require('../models/PublisherApplication');
const { verifySupabaseToken } = require('../middleware/studioAuth');
const {
    newVerificationToken, normaliseHost, instructionsFor, verifyDomain, probeFeed, discoverFeeds,
} = require('../utils/publisherChecks');

const router = express.Router();
const throttle = new NodeCache({ stdTTL: 600, checkperiod: 120 });

const EDITABLE = ['draft', 'changes_requested'];
const MAX_FEEDS = 20;
const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const URL_KINDS = ['rss', 'atom', 'sitemap', 'api', 'website'];
const LIMITS = { verify: 12, test: 40, discover: 6, save: 120 };

const str = (v, max = 500) => (v === undefined || v === null ? undefined : String(v).trim().slice(0, max));
const isHttpUrl = (v) => {
    try { return ['http:', 'https:'].includes(new URL(v).protocol); } catch { return false; }
};
const strList = (v, max = 12) => (Array.isArray(v) ? [...new Set(v.map((x) => String(x).trim().toLowerCase()).filter(Boolean))].slice(0, max) : undefined);

/** At most `LIMITS[action]` calls per account per 10 minutes. */
const allow = (userId, action) => {
    const key = `${userId}:${action}`;
    const expires = throttle.getTtl(key);
    const n = (throttle.get(key) || 0) + 1;
    // Keep the window's original expiry; set() would otherwise restart it.
    throttle.set(key, n, expires ? Math.max(1, Math.ceil((expires - Date.now()) / 1000)) : 600);
    return n <= LIMITS[action];
};

const tooMany = (res) => res.status(429).json({ message: 'Too many checks in a short time. Wait a few minutes and try again.' });

// ----------------------------------------------------------------------------
// identity: any verified account; the Mongo user is created on first visit
// ----------------------------------------------------------------------------

router.use(async (req, res, next) => {
    try {
        const header = req.headers.authorization || '';
        const token = header.startsWith('Bearer ') ? header.slice(7) : null;
        const identity = await verifySupabaseToken(token);
        if (!identity) return res.status(401).json({ message: 'Your session has expired. Sign in again.' });

        let user = await User.findOne({ supabase_id: identity.id }).select('email name type publisher_group supabase_id').lean();
        if (!user) {
            try {
                user = (await User.create({ supabase_id: identity.id, email: identity.email || '', name: '' })).toObject();
            } catch (err) {
                // Raced with the app's ensureMongoUser creating the same account.
                if (err.code !== 11000) throw err;
                user = await User.findOne({ supabase_id: identity.id }).select('email name type publisher_group supabase_id').lean();
            }
        }
        req.applicant = { user, email: identity.email || user.email };
        next();
    } catch (err) {
        console.error('publisherPortal auth:', err.message);
        res.status(500).json({ message: 'Could not verify your account.' });
    }
});

// ----------------------------------------------------------------------------
// serialisation + completeness
// ----------------------------------------------------------------------------

/** What still blocks submission, per wizard step. */
function readiness(app) {
    const missing = [];
    const need = (step, field, message) => missing.push({ step, field, message });
    const o = app.organization || {};
    const c = app.contact || {};

    if (!o.publicationName) need('publication', 'publicationName', 'Publication name');
    if (!o.legalName) need('publication', 'legalName', 'Legal entity name');
    if (!o.website || !normaliseHost(o.website)) need('publication', 'website', 'Website');
    if (!o.country) need('publication', 'country', 'Country of registration');
    if (!o.description || o.description.length < 40) need('publication', 'description', 'A short description (at least 40 characters)');
    if (!o.languages?.length) need('publication', 'languages', 'At least one publishing language');
    if (!o.categories?.length) need('publication', 'categories', 'At least one coverage area');

    if (!c.name) need('contact', 'name', 'Contact name');
    if (!c.email || !EMAIL_RX.test(c.email)) need('contact', 'email', 'Contact email');
    if (!c.phone) need('contact', 'phone', 'Contact phone');

    if (!app.domain?.verifiedAt) need('domain', 'domain', 'Verify that you control your domain');

    if (!app.feeds?.length) need('feeds', 'feeds', 'Add at least one feed or content source');
    (app.feeds || []).forEach((f, i) => {
        if (URL_KINDS.includes(f.kind) && !isHttpUrl(f.url)) need('feeds', `feeds.${i}`, `Feed ${i + 1}: a valid http(s) link`);
    });

    const a = app.agreements || {};
    if (!a.contentRights || !a.editorialStandards || !a.terms) need('agreements', 'agreements', 'Accept the publisher agreements');

    return { ready: missing.length === 0, missing };
}

const PUBLIC_ACTIONS = new Set(['created', 'submitted', 'withdrawn', 'in_review', 'changes_requested', 'approved', 'rejected', 'resubmitted']);

function forApplicant(app) {
    if (!app) return null;
    const o = typeof app.toObject === 'function' ? app.toObject() : app;
    const { internalNotes, decidedBy, history, ...rest } = o;
    return {
        ...rest,
        domain: {
            ...(o.domain || {}),
            instructions: o.domain?.host && o.domain?.token ? instructionsFor(o.domain.host, o.domain.token) : null,
        },
        history: (history || [])
            .filter((h) => PUBLIC_ACTIONS.has(h.action))
            .map((h) => ({ at: h.at, action: h.action, note: ['changes_requested', 'rejected', 'approved'].includes(h.action) ? h.note : undefined })),
        readiness: readiness(o),
        editable: EDITABLE.includes(o.status),
    };
}

const account = (req) => ({
    email: req.applicant.email,
    role: req.applicant.user.type || 'user',
    groups: req.applicant.user.publisher_group || [],
});

const loadOwn = (req) => PublisherApplication.findOne({ applicant: req.applicant.user._id });

// ----------------------------------------------------------------------------
// routes
// ----------------------------------------------------------------------------

router.get('/application', async (req, res) => {
    try {
        const app = await loadOwn(req).lean();
        res.json({ account: account(req), application: forApplicant(app) });
    } catch (err) {
        console.error('publisherPortal get:', err);
        res.status(500).json({ message: 'Could not load your application.' });
    }
});

/** Whitelisted draft fields. Unknown keys are ignored. */
function cleanDraft(body, existing) {
    const out = {};
    const o = body.organization;
    if (o && typeof o === 'object') {
        const year = o.foundedYear === '' || o.foundedYear === null ? undefined : Number(o.foundedYear);
        out.organization = {
            publicationName: str(o.publicationName, 120),
            legalName: str(o.legalName, 200),
            website: str(o.website, 500),
            country: str(o.country, 60),
            city: str(o.city, 80),
            registrationNumber: str(o.registrationNumber, 80),
            foundedYear: Number.isFinite(year) ? year : undefined,
            description: str(o.description, 2000),
            logoUrl: str(o.logoUrl, 1000),
            languages: strList(o.languages),
            categories: strList(o.categories, 15),
            monthlyReach: ['', 'lt_100k', '100k_1m', '1m_10m', 'gt_10m'].includes(o.monthlyReach) ? o.monthlyReach : '',
            editorialPolicyUrl: str(o.editorialPolicyUrl, 1000),
            socials: o.socials && typeof o.socials === 'object' ? {
                x: str(o.socials.x, 200), instagram: str(o.socials.instagram, 200), youtube: str(o.socials.youtube, 200),
                tiktok: str(o.socials.tiktok, 200), facebook: str(o.socials.facebook, 200),
            } : existing?.organization?.socials,
        };
        if (out.organization.logoUrl && !isHttpUrl(out.organization.logoUrl)) out.organization.logoUrl = '';
    }

    const c = body.contact;
    if (c && typeof c === 'object') {
        out.contact = {
            name: str(c.name, 120), role: str(c.role, 120), email: str(c.email, 200)?.toLowerCase(),
            phone: str(c.phone, 40), correctionsEmail: str(c.correctionsEmail, 200)?.toLowerCase(),
        };
    }

    if (Array.isArray(body.feeds)) {
        const prev = new Map((existing?.feeds || []).map((f) => [String(f._id), f]));
        out.feeds = body.feeds.slice(0, MAX_FEEDS).map((f) => {
            const kind = PublisherApplication.FEED_KINDS.includes(f?.kind) ? f.kind : null;
            let url = str(f?.url, 1000) || '';
            if (kind === 'instagram') url = url.replace(/^@/, '');
            if (!kind || !url) return null;
            const old = f._id && prev.get(String(f._id));
            const unchanged = old && old.kind === kind && old.url === url;
            return {
                ...(old ? { _id: old._id } : {}),
                kind,
                url,
                label: str(f.label, 120),
                language: str(f.language, 30)?.toLowerCase(),
                category: str(f.category, 60)?.toLowerCase(),
                api: kind === 'api' ? {
                    docsUrl: str(f.api?.docsUrl, 1000),
                    authType: ['none', 'api_key', 'bearer', 'basic', 'oauth', 'other', ''].includes(f.api?.authType) ? f.api.authType : '',
                    notes: str(f.api?.notes, 2000),
                } : undefined,
                lastTest: unchanged ? old.lastTest : null,
            };
        }).filter(Boolean);
    }

    const a = body.agreements;
    if (a && typeof a === 'object') {
        out.agreements = { contentRights: a.contentRights === true, editorialStandards: a.editorialStandards === true, terms: a.terms === true };
    }
    return out;
}

/** Create or update the caller's draft. */
router.put('/application', async (req, res) => {
    try {
        if (!allow(req.applicant.user._id, 'save')) return tooMany(res);
        let app = await loadOwn(req);
        if (app && !EDITABLE.includes(app.status)) {
            return res.status(409).json({ message: 'This application is with the review team and can’t be edited right now.' });
        }
        const data = cleanDraft(req.body || {}, app);

        if (!app) {
            app = new PublisherApplication({
                applicant: req.applicant.user._id,
                contact: { email: req.applicant.email },
                history: [{ by: req.applicant.user._id, byName: req.applicant.email, action: 'created' }],
            });
        }

        if (data.organization) {
            app.organization = { ...(app.toObject().organization || {}), ...data.organization };
            // A new website means a new domain to prove; the old proof doesn't carry over.
            const host = normaliseHost(app.organization.website);
            if (host !== (app.domain?.host || null)) {
                app.domain = { host, token: host ? newVerificationToken() : undefined, verifiedAt: undefined, method: null, lastCheckedAt: undefined, checks: undefined };
            }
        }
        if (data.contact) app.contact = { ...(app.toObject().contact || {}), ...data.contact };
        if (data.feeds) app.feeds = data.feeds;
        if (data.agreements) {
            const all = data.agreements.contentRights && data.agreements.editorialStandards && data.agreements.terms;
            app.agreements = { ...data.agreements, acceptedAt: all ? new Date() : undefined, acceptedBy: all ? req.applicant.email : undefined };
        }

        await app.save();
        res.json({ account: account(req), application: forApplicant(app) });
    } catch (err) {
        if (err.code === 11000) return res.status(409).json({ message: 'You already have an application. Reload the page.' });
        if (err.name === 'ValidationError') return res.status(400).json({ message: err.message });
        console.error('publisherPortal save:', err);
        res.status(500).json({ message: 'Could not save your application.' });
    }
});

router.post('/application/domain/verify', async (req, res) => {
    try {
        const app = await loadOwn(req);
        if (!app?.domain?.host || !app.domain.token) return res.status(400).json({ message: 'Add your website first.' });
        if (app.domain.verifiedAt) return res.json({ account: account(req), application: forApplicant(app) });
        if (!EDITABLE.includes(app.status)) return res.status(409).json({ message: 'This application can’t be changed right now.' });
        if (!allow(req.applicant.user._id, 'verify')) return tooMany(res);

        const result = await verifyDomain(app.domain.host, app.domain.token);
        app.domain.lastCheckedAt = result.checkedAt;
        app.domain.checks = result.checks;
        if (result.verified) {
            app.domain.verifiedAt = result.checkedAt;
            app.domain.method = result.method;
        }
        await app.save();
        res.json({ account: account(req), application: forApplicant(app), verified: result.verified });
    } catch (err) {
        console.error('publisherPortal verify:', err);
        res.status(500).json({ message: 'The domain check failed. Try again in a minute.' });
    }
});

/** Look at one feed. With `feedId`, the result is saved on that feed too. */
router.post('/application/feeds/test', async (req, res) => {
    try {
        if (!allow(req.applicant.user._id, 'test')) return tooMany(res);
        const app = await loadOwn(req);
        const { feedId } = req.body || {};
        let { kind, url } = req.body || {};
        const feed = feedId && app ? app.feeds.id(feedId) : null;
        if (feed) ({ kind, url } = feed);
        if (!PublisherApplication.FEED_KINDS.includes(kind) || !url) return res.status(400).json({ message: 'Choose a feed type and enter its link.' });

        const result = await probeFeed({ kind, url: String(url).trim() }, app?.domain?.host || null);
        if (feed && EDITABLE.includes(app.status)) {
            feed.lastTest = result;
            await app.save();
        }
        res.json({ result });
    } catch (err) {
        console.error('publisherPortal test:', err);
        res.status(500).json({ message: 'Could not check that feed.' });
    }
});

router.post('/application/feeds/discover', async (req, res) => {
    try {
        const app = await loadOwn(req).lean();
        if (!app?.domain?.host) return res.status(400).json({ message: 'Add your website first.' });
        if (!allow(req.applicant.user._id, 'discover')) return tooMany(res);
        res.json(await discoverFeeds(app.domain.host));
    } catch (err) {
        console.error('publisherPortal discover:', err);
        res.status(500).json({ message: 'Could not look for feeds on your site.' });
    }
});

router.post('/application/submit', async (req, res) => {
    try {
        const app = await loadOwn(req);
        if (!app) return res.status(404).json({ message: 'Start an application first.' });
        if (!EDITABLE.includes(app.status)) return res.status(409).json({ message: 'This application has already been submitted.' });
        const check = readiness(app.toObject());
        if (!check.ready) return res.status(400).json({ message: 'A few things are still missing.', missing: check.missing });

        const again = app.status === 'changes_requested';
        app.status = 'submitted';
        app.submittedAt = new Date();
        app.history.push({ by: req.applicant.user._id, byName: req.applicant.email, action: again ? 'resubmitted' : 'submitted' });
        await app.save();
        res.json({ account: account(req), application: forApplicant(app) });
    } catch (err) {
        console.error('publisherPortal submit:', err);
        res.status(500).json({ message: 'Could not submit your application.' });
    }
});

/** Pull a submitted application back to draft before review starts. */
router.post('/application/withdraw', async (req, res) => {
    try {
        const app = await PublisherApplication.findOneAndUpdate(
            { applicant: req.applicant.user._id, status: 'submitted' },
            {
                $set: { status: 'draft' },
                $push: { history: { at: new Date(), by: req.applicant.user._id, byName: req.applicant.email, action: 'withdrawn' } },
            },
            { new: true },
        );
        if (!app) return res.status(409).json({ message: 'Only a submitted application that isn’t in review yet can be withdrawn.' });
        res.json({ account: account(req), application: forApplicant(app) });
    } catch (err) {
        console.error('publisherPortal withdraw:', err);
        res.status(500).json({ message: 'Could not withdraw your application.' });
    }
});

module.exports = router;
module.exports.readiness = readiness;
