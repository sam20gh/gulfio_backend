/**
 * Gulfio Studio API — the admin + publisher panel.
 *
 * Every route here is gated by requireStudio and every query is scoped through
 * req.studio: admins see everything (sourceIds === null), publishers see only
 * sources whose groupName is in their publisher_group, and everything keyed off
 * those sources (articles, reels, ad revenue, payouts).
 *
 * Mounted at /api/studio. The mobile app never calls these routes.
 */
const express = require('express');
const mongoose = require('mongoose');
const NodeCache = require('node-cache');

const Article = require('../models/Article');
const Source = require('../models/Source');
const Reel = require('../models/Reel');
const User = require('../models/User');
const Comment = require('../models/Comment');
const AdRevenueEvent = require('../models/AdRevenueEvent');
const Payout = require('../models/Payout');

const {
    requireStudio,
    requireAdmin,
    scopeFilter,
    canAccessSource,
    canAccessGroup,
    assertSource,
    invalidateScopeCache,
} = require('../middleware/studioAuth');
const { clearArticlesCache } = require('../utils/articleCache');
const { invalidateSourceCache } = require('../utils/sourceCache');
const { searchArticles } = require('../utils/atlasSearch');
const { getDeepSeekEmbedding } = require('../utils/deepseek');
const { toVector } = require('../utils/vector');

const router = express.Router();
const statsCache = new NodeCache({ stdTTL: 600, checkperiod: 120 });

const TZ = 'Asia/Dubai';
const MICRO = 1_000_000;
const DAY = 24 * 60 * 60 * 1000;

// ----------------------------------------------------------------------------
// helpers
// ----------------------------------------------------------------------------

const isId = (v) => typeof v === 'string' && mongoose.Types.ObjectId.isValid(v) && /^[a-f0-9]{24}$/i.test(v);
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const clampInt = (v, def, min, max) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};
const round = (n, dp = 2) => Math.round((n || 0) * 10 ** dp) / 10 ** dp;
const pick = (obj, keys) => keys.reduce((acc, k) => (obj[k] !== undefined ? { ...acc, [k]: obj[k] } : acc), {});

/** Midnight in Dubai (UTC+4, no DST) for the day containing `d`. */
const dubaiMidnight = (d) => {
    const shifted = new Date(d.getTime() + 4 * 60 * 60 * 1000);
    return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - 4 * 60 * 60 * 1000);
};

/**
 * Whole Dubai days: "7 days" = today so far + the 6 full days before it. A rolling
 * now-minus-N window made the first day a partial one and drew a fake ramp-up on charts.
 */
const windowFor = (days) => {
    const now = new Date();
    const start = new Date(dubaiMidnight(now).getTime() - (days - 1) * DAY);
    const prevStart = new Date(start.getTime() - days * DAY);
    return { now, start, prevStart };
};

const parseRange = (query, defaultDays = 30) => {
    const to = query.to ? new Date(query.to) : new Date();
    const from = query.from ? new Date(query.from) : new Date(to.getTime() - defaultDays * DAY);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) return null;
    return { from, to };
};

const delta = (cur, prev) => (prev > 0 ? round(((cur - prev) / prev) * 100, 1) : null);

const ARTICLE_LIST_FIELDS =
    'title image sourceId category language publishedAt viewCount likes dislikes commentCount ' +
    'isBreakingNews breakingNewsExpiry breakingNewsPriority contentFormat url featuredAt featurePreviousCategory';

/** The app's home carousel: GET /articles/feature → the newest N by featuredAt, per language. */
const FEATURE_CATEGORY = 'feature';
const CAROUSEL_SLOTS = 5;

const SOURCE_EDITABLE = [
    'name', 'groupName', 'url', 'baseUrl', 'type', 'category', 'frequency', 'language', 'icon',
    'listSelector', 'linkSelector', 'titleSelector', 'imageSelector', 'contentSelector', 'listApi',
    'instagramUsername', 'youtubeChannelId', 'bioSection', 'bioLink', 'status', 'articleType',
];
const SOURCE_ADMIN_ONLY = ['revSharePercent', 'payoutCurrency'];
const ARTICLE_EDITABLE = ['title', 'content', 'contentFormat', 'category', 'image', 'publishedAt', 'language', 'url', 'sourceId'];

const normaliseImages = (image) => {
    if (image === undefined) return undefined;
    const list = Array.isArray(image) ? image : [image];
    return list.map((s) => String(s || '').trim()).filter(Boolean);
};

const fail = (res, err, fallback = 'Something went wrong.') => {
    console.error('studio:', err);
    const status = err.name === 'ValidationError' || err.name === 'CastError' ? 400 : err.code === 11000 ? 409 : 500;
    const message = err.code === 11000 ? 'A record with the same unique value already exists.' : status === 400 ? err.message : fallback;
    res.status(status).json({ message });
};

/** Source ids for a group filter, intersected with the caller's scope. */
async function sourceIdsForFilter(studio, { source, group }) {
    if (source) {
        if (!isId(source) || !canAccessSource(studio, source)) return [];
        return [new mongoose.Types.ObjectId(source)];
    }
    if (group) {
        if (!canAccessGroup(studio, group)) return [];
        const ids = (await Source.find({ groupName: group }).select('_id').lean()).map((s) => s._id);
        return ids;
    }
    return studio.sourceIds; // null = unrestricted
}

/** { [sourceId]: { name, icon, groupName, revSharePercent, language } } */
async function sourceMap(ids) {
    const docs = await Source.find(ids ? { _id: { $in: ids } } : {})
        .select('name icon groupName revSharePercent payoutCurrency language status')
        .lean();
    return Object.fromEntries(docs.map((d) => [String(d._id), d]));
}

/**
 * Relevance search for the studio. Deliberately leaner than utils/atlasSearch's
 * searchArticles: that helper's $facet/$count materialises every match (30s for a
 * common word), while a lowerBound count via $$SEARCH_META returns in ~150ms.
 */
async function studioSearch({ q, sourceIds, language, category, limit, skip }) {
    const filter = [];
    if (sourceIds) filter.push({ in: { path: 'sourceId', value: sourceIds } });
    if (language) filter.push({ text: { query: language, path: 'language' } });
    if (category) filter.push({ text: { query: category, path: 'category' } });

    const project = Object.fromEntries(ARTICLE_LIST_FIELDS.split(/\s+/).filter(Boolean).map((f) => [f, 1]));
    try {
        const rows = await Article.aggregate([
            {
                $search: {
                    index: 'articles_search',
                    compound: {
                        should: [
                            { text: { query: q, path: 'title', score: { boost: { value: 3 } } } },
                            { text: { query: q, path: 'content' } },
                        ],
                        minimumShouldMatch: 1,
                        ...(filter.length ? { filter } : {}),
                    },
                    count: { type: 'lowerBound', threshold: 1000 },
                },
            },
            { $skip: skip },
            { $limit: limit },
            { $project: { ...project, meta: '$$SEARCH_META' } },
        ]).option({ maxTimeMS: 15000 });
        const map = await sourceMap([...new Set(rows.map((r) => String(r.sourceId)))].filter(isId));
        const total = rows[0]?.meta?.count?.lowerBound ?? rows.length;
        const items = rows.map(({ meta, ...a }) => ({ ...a, sourceId: map[String(a.sourceId)] ? { _id: a.sourceId, ...map[String(a.sourceId)] } : a.sourceId }));
        return { items, total };
    } catch (err) {
        // No Atlas Search (local dev / index missing): fall back to the shared helper.
        const { articles, total } = await searchArticles({ searchTerm: q, language, category, sourceIds: sourceIds || undefined, limit, skip });
        const items = articles.map((a) => ({ ...a, sourceId: { _id: a.sourceId, name: a.sourceName, icon: a.sourceIcon, groupName: a.sourceGroupName } }));
        return { items, total };
    }
}

/**
 * Top-N by an engagement counter within a window. $project before $sort keeps the
 * blocking sort to tiny docs — sorting full articles (content + vectors) spills to
 * disk and takes seconds. Covered entirely by the index in scripts/createStudioIndexes.js.
 */
async function topArticleIds(match, field, skip, limit) {
    const rows = await Article.aggregate([
        { $match: match },
        { $project: { [field]: 1, publishedAt: 1 } },
        { $sort: { [field]: -1, publishedAt: -1 } },
        { $skip: skip },
        { $limit: limit },
    ]).option({ maxTimeMS: 20000 });
    return rows.map((r) => r._id);
}

async function articlesByIds(ids) {
    const docs = await Article.find({ _id: { $in: ids } })
        .select(ARTICLE_LIST_FIELDS).populate('sourceId', 'name icon groupName').lean();
    const byId = Object.fromEntries(docs.map((d) => [String(d._id), d]));
    return ids.map((id) => byId[String(id)]).filter(Boolean);
}

const scopeKey = (studio) => (studio.sourceIds === null ? 'all' : studio.groups.slice().sort().join('|'));

router.use(requireStudio('admin', 'publisher'));

// ----------------------------------------------------------------------------
// identity + metadata
// ----------------------------------------------------------------------------

router.get('/me', async (req, res) => {
    const { user, role, groups, sourceIds, service } = req.studio;
    res.json({
        user: user && {
            id: user._id,
            email: user.email,
            name: user.name || '',
            avatar: user.profile_image || user.avatar_url || null,
        },
        role,
        groups,
        sourceCount: sourceIds === null ? await Source.estimatedDocumentCount() : sourceIds.length,
        service,
    });
});

router.get('/meta', async (req, res) => {
    try {
        const match = req.studio.isAdmin ? {} : { groupName: { $in: req.studio.groups } };
        const [categories, languages, groups] = await Promise.all([
            Source.distinct('category', match),
            Source.distinct('language', match),
            Source.distinct('groupName', match),
        ]);
        const clean = (arr) => arr.filter(Boolean).map(String).sort((a, b) => a.localeCompare(b));
        res.json({ categories: clean(categories), languages: clean(languages), groups: clean(groups) });
    } catch (err) {
        fail(res, err);
    }
});

/** Publisher groups: sources, publishers assigned and average rev share. */
router.get('/groups', async (req, res) => {
    try {
        const match = req.studio.isAdmin ? {} : { groupName: { $in: req.studio.groups } };
        const [groups, publishers] = await Promise.all([
            Source.aggregate([
                { $match: { ...match, groupName: { $nin: [null, ''] } } },
                {
                    $group: {
                        _id: '$groupName',
                        sources: { $sum: 1 },
                        active: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } },
                        avgRevShare: { $avg: { $ifNull: ['$revSharePercent', 70] } },
                        icon: { $first: '$icon' },
                        languages: { $addToSet: '$language' },
                    },
                },
                { $sort: { _id: 1 } },
            ]),
            req.studio.isAdmin
                ? User.find({ type: 'publisher' }).select('email name publisher_group').lean()
                : Promise.resolve([]),
        ]);

        res.json(groups.map((g) => ({
            name: g._id,
            sources: g.sources,
            active: g.active,
            avgRevShare: round(g.avgRevShare, 1),
            icon: g.icon || null,
            languages: g.languages.filter(Boolean),
            publishers: publishers
                .filter((p) => (p.publisher_group || []).includes(g._id))
                .map((p) => ({ id: p._id, email: p.email, name: p.name || '' })),
        })));
    } catch (err) {
        fail(res, err);
    }
});

// ----------------------------------------------------------------------------
// overview
// ----------------------------------------------------------------------------

router.get('/overview', async (req, res) => {
    try {
        const days = clampInt(req.query.days, 7, 1, 90);
        const cacheKey = `overview:${scopeKey(req.studio)}:${days}`;
        const cached = statsCache.get(cacheKey);
        if (cached) return res.json(cached);

        const { now, start, prevStart } = windowFor(days);
        const scope = scopeFilter(req.studio);
        const inWindow = { ...scope, publishedAt: { $gte: start, $lte: now } };

        const [facets, prevTotals, topArticles, latest, revenueAgg, reelCount, freshSources, scopeSourceCount] =
            await Promise.all([
                Article.aggregate([
                    { $match: inWindow },
                    // Only counter fields from here on: keeps $facet's buffers small and lets the
                    // studio covering index answer the whole pipeline without fetching documents.
                    { $project: { _id: 0, publishedAt: 1, sourceId: 1, viewCount: 1, likes: 1, dislikes: 1, commentCount: 1, category: 1, language: 1 } },
                    {
                        $facet: {
                            totals: [{
                                $group: {
                                    _id: null,
                                    articles: { $sum: 1 },
                                    views: { $sum: '$viewCount' },
                                    likes: { $sum: '$likes' },
                                    dislikes: { $sum: '$dislikes' },
                                    comments: { $sum: { $ifNull: ['$commentCount', 0] } },
                                },
                            }],
                            byDay: [
                                {
                                    $group: {
                                        _id: { $dateToString: { format: '%Y-%m-%d', date: '$publishedAt', timezone: TZ } },
                                        articles: { $sum: 1 },
                                        views: { $sum: '$viewCount' },
                                        likes: { $sum: '$likes' },
                                    },
                                },
                                { $sort: { _id: 1 } },
                            ],
                            bySource: [
                                { $group: { _id: '$sourceId', articles: { $sum: 1 }, views: { $sum: '$viewCount' }, likes: { $sum: '$likes' } } },
                                { $sort: { views: -1 } },
                                { $limit: 8 },
                            ],
                            byCategory: [
                                { $group: { _id: '$category', articles: { $sum: 1 }, views: { $sum: '$viewCount' } } },
                                { $sort: { articles: -1 } },
                                { $limit: 8 },
                            ],
                            byLanguage: [
                                { $group: { _id: '$language', articles: { $sum: 1 } } },
                                { $sort: { articles: -1 } },
                            ],
                        },
                    },
                ]).option({ maxTimeMS: 20000 }),
                Article.aggregate([
                    { $match: { ...scope, publishedAt: { $gte: prevStart, $lt: start } } },
                    { $project: { _id: 0, viewCount: 1, likes: 1 } },
                    { $group: { _id: null, articles: { $sum: 1 }, views: { $sum: '$viewCount' }, likes: { $sum: '$likes' } } },
                ]).option({ maxTimeMS: 15000 }),
                topArticleIds(inWindow, 'viewCount', 0, 6).then(articlesByIds),
                Article.find(scope).sort({ publishedAt: -1 }).limit(10)
                    .select(ARTICLE_LIST_FIELDS).populate('sourceId', 'name icon groupName').lean(),
                AdRevenueEvent.aggregate([
                    { $match: { ...scopeFilter(req.studio), ts: { $gte: start, $lte: now } } },
                    {
                        $group: {
                            _id: {
                                day: { $dateToString: { format: '%Y-%m-%d', date: '$ts', timezone: TZ } },
                                sourceId: '$sourceId',
                            },
                            value: { $sum: '$value' },
                            impressions: { $sum: 1 },
                        },
                    },
                ]),
                Reel.countDocuments({ ...scopeFilter(req.studio, 'source'), scrapedAt: { $gte: start } }),
                Article.aggregate([
                    { $match: { ...scope, publishedAt: { $gte: new Date(now.getTime() - 3 * DAY) } } },
                    { $group: { _id: '$sourceId' } },
                ]),
                Source.countDocuments({
                    // Legacy sources have no status field at all; they scrape like active ones.
                    status: { $nin: ['suspended', 'blocked'] },
                    ...(req.studio.sourceIds === null ? {} : { _id: { $in: req.studio.sourceIds } }),
                }),
            ]);

        const f = facets[0] || {};
        const totals = f.totals?.[0] || { articles: 0, views: 0, likes: 0, dislikes: 0, comments: 0 };
        const prev = prevTotals[0] || { articles: 0, views: 0, likes: 0 };

        const ids = [...new Set([...(f.bySource || []).map((s) => String(s._id)), ...revenueAgg.map((r) => String(r._id.sourceId))])];
        const sources = await sourceMap(ids.filter(isId));

        const revenueByDay = {};
        let gross = 0;
        let payout = 0;
        let impressions = 0;
        for (const r of revenueAgg) {
            const usd = r.value / MICRO;
            const share = (sources[String(r._id.sourceId)]?.revSharePercent ?? 70) / 100;
            gross += usd;
            payout += usd * share;
            impressions += r.impressions;
            revenueByDay[r._id.day] = (revenueByDay[r._id.day] || 0) + usd;
        }

        // Dense day axis so charts don't skip quiet days.
        const dayKeys = [];
        for (let t = start.getTime(); t <= now.getTime(); t += DAY) {
            dayKeys.push(new Date(t).toLocaleDateString('en-CA', { timeZone: TZ }));
        }
        const byDayMap = Object.fromEntries((f.byDay || []).map((d) => [d._id, d]));
        const series = [...new Set(dayKeys)].map((day) => ({
            date: day,
            articles: byDayMap[day]?.articles || 0,
            views: byDayMap[day]?.views || 0,
            likes: byDayMap[day]?.likes || 0,
            revenue: round(revenueByDay[day] || 0, 4),
        }));

        const payload = {
            days,
            range: { start, end: now },
            kpis: {
                articles: { value: totals.articles, delta: delta(totals.articles, prev.articles) },
                views: { value: totals.views, delta: delta(totals.views, prev.views) },
                likes: { value: totals.likes, delta: delta(totals.likes, prev.likes) },
                comments: { value: totals.comments, delta: null },
                reels: { value: reelCount, delta: null },
                revenue: { value: round(gross, 2), payout: round(payout, 2), impressions },
                engagementRate: totals.views > 0 ? round(((totals.likes + totals.comments) / totals.views) * 100, 2) : null,
            },
            series,
            topArticles,
            latest,
            topSources: (f.bySource || []).map((s) => ({
                sourceId: s._id,
                name: sources[String(s._id)]?.name || 'Unknown source',
                icon: sources[String(s._id)]?.icon || null,
                groupName: sources[String(s._id)]?.groupName || null,
                articles: s.articles,
                views: s.views,
                likes: s.likes,
            })),
            categories: (f.byCategory || []).map((c) => ({ name: c._id || 'uncategorised', articles: c.articles, views: c.views })),
            languages: (f.byLanguage || []).map((l) => ({ name: l._id || 'unknown', articles: l.articles })),
            health: {
                activeSources: scopeSourceCount,
                freshSources: freshSources.length,
                staleSources: Math.max(0, scopeSourceCount - freshSources.length),
            },
            generatedAt: new Date(),
        };
        statsCache.set(cacheKey, payload, 300);
        res.json(payload);
    } catch (err) {
        fail(res, err, 'Could not load the overview.');
    }
});

// ----------------------------------------------------------------------------
// articles
// ----------------------------------------------------------------------------

router.get('/articles', async (req, res) => {
    try {
        const page = clampInt(req.query.page, 1, 1, 10000);
        const limit = clampInt(req.query.limit, 25, 1, 100);
        const skip = (page - 1) * limit;
        const q = String(req.query.q || '').trim();

        const sourceIds = await sourceIdsForFilter(req.studio, req.query);
        if (Array.isArray(sourceIds) && sourceIds.length === 0) {
            return res.json({ items: [], page, limit, total: 0, hasMore: false });
        }

        // Free-text search goes through Atlas Search (relevance-ranked, regex fallback).
        if (q && !isId(q) && !/^https?:\/\//i.test(q)) {
            const { items, total } = await studioSearch({
                q,
                sourceIds,
                language: req.query.language || undefined,
                category: req.query.category || undefined,
                limit,
                skip,
            });
            return res.json({ items, page, limit, total, hasMore: skip + items.length < total, mode: 'search' });
        }

        const filter = sourceIds ? { sourceId: { $in: sourceIds } } : {};
        if (q && isId(q)) filter._id = new mongoose.Types.ObjectId(q);
        if (q && /^https?:\/\//i.test(q)) filter.url = q;
        if (req.query.category) filter.category = String(req.query.category);
        if (req.query.language) filter.language = String(req.query.language);
        if (req.query.breaking === '1') filter.isBreakingNews = true;
        if (req.query.featured === '1') filter.category = FEATURE_CATEGORY;
        // Category is only indexed behind language ({ language, category, publishedAt }), so
        // a category filter on its own scans all ~550k articles and times out. Spelling out
        // the known languages lets the index serve it, one range per language.
        if (filter.category && !filter.language) {
            const languages = (await Source.distinct('language')).filter(Boolean);
            filter.language = { $in: [...new Set([...languages, 'english'])] };
        }
        if (req.query.from || req.query.to) {
            filter.publishedAt = {};
            if (req.query.from) filter.publishedAt.$gte = new Date(req.query.from);
            if (req.query.to) filter.publishedAt.$lte = new Date(req.query.to);
        }

        const ENGAGEMENT = { views: 'viewCount', likes: 'likes', comments: 'commentCount' };
        const engagementField = ENGAGEMENT[req.query.sort];

        if (engagementField && !filter._id) {
            // Ranking the whole corpus by a counter is a cold-disk scan; rank within a window
            // (default 7 days, max 30 unless the caller passes explicit dates).
            if (!filter.publishedAt) {
                const windowDays = clampInt(req.query.window, 7, 1, 30);
                filter.publishedAt = { $gte: new Date(Date.now() - windowDays * DAY) };
            }
            const [ids, total] = await Promise.all([
                topArticleIds(filter, engagementField, skip, limit),
                Article.countDocuments(filter).maxTimeMS(4000).catch(() => null),
            ]);
            const items = await articlesByIds(ids);
            return res.json({ items, page, limit, total, hasMore: total === null ? ids.length === limit : skip + ids.length < total, mode: 'ranked' });
        }

        // Featured view is listed in carousel order, exactly as the app shows it.
        const sort = req.query.featured === '1'
            ? { featuredAt: -1, publishedAt: -1 }
            : req.query.sort === 'oldest' ? { publishedAt: 1 } : { publishedAt: -1 };
        const unfiltered = Object.keys(filter).length === 0;
        const [items, total] = await Promise.all([
            Article.find(filter).sort(sort).skip(skip).limit(limit)
                .select(ARTICLE_LIST_FIELDS).populate('sourceId', 'name icon groupName').lean()
                .maxTimeMS(15000),
            unfiltered
                ? Article.estimatedDocumentCount()
                : Article.countDocuments(filter).maxTimeMS(4000).catch(() => null),
        ]);

        res.json({
            items,
            page,
            limit,
            total,
            hasMore: total === null ? items.length === limit : skip + items.length < total,
            mode: 'list',
        });
    } catch (err) {
        fail(res, err, 'Could not load articles.');
    }
});

router.get('/articles/:id', async (req, res) => {
    try {
        if (!isId(req.params.id)) return res.status(404).json({ message: 'Article not found.' });
        const article = await Article.findById(req.params.id)
            .select('-embedding -embedding_pca -likedBy -dislikedBy -relatedIds')
            .populate('sourceId', 'name icon groupName language category')
            .lean();
        if (!article) return res.status(404).json({ message: 'Article not found.' });
        if (!assertSource(req, res, article.sourceId?._id)) return;
        res.json(article);
    } catch (err) {
        fail(res, err);
    }
});

router.post('/articles', async (req, res) => {
    try {
        const body = pick(req.body || {}, ARTICLE_EDITABLE);
        if (!body.title?.trim() || !body.content?.trim() || !body.sourceId) {
            return res.status(400).json({ message: 'Title, body and source are required.' });
        }
        if (!isId(String(body.sourceId))) return res.status(400).json({ message: 'Choose a valid source.' });
        if (!assertSource(req, res, body.sourceId)) return;

        const source = await Source.findById(body.sourceId).select('language category').lean();
        if (!source) return res.status(400).json({ message: 'That source no longer exists.' });
        if (body.category === FEATURE_CATEGORY && !req.studio.isAdmin) {
            return res.status(403).json({ message: 'Only admins can put stories on the home carousel.' });
        }

        let embedding;
        try {
            embedding = toVector(await getDeepSeekEmbedding(`${body.title}\n\n${body.content.slice(0, 512)}`));
        } catch (e) {
            console.warn('studio: embedding failed, saving without one:', e.message);
        }

        const article = await Article.create({
            title: body.title.trim(),
            content: body.content,
            contentFormat: body.contentFormat === 'text' ? 'text' : 'markdown',
            category: body.category || source.category || 'general',
            language: body.language || source.language || 'english',
            image: normaliseImages(body.image) || [],
            url: body.url?.trim() || undefined,
            sourceId: body.sourceId,
            publishedAt: body.publishedAt ? new Date(body.publishedAt) : new Date(),
            ...(body.category === FEATURE_CATEGORY ? { featuredAt: new Date(), featurePreviousCategory: source.category || 'general' } : {}),
            ...(embedding ? { embedding } : {}),
        });

        await clearArticlesCache();
        res.status(201).json({ _id: article._id });
    } catch (err) {
        fail(res, err, 'Could not create the article.');
    }
});

router.patch('/articles/:id', async (req, res) => {
    try {
        if (!isId(req.params.id)) return res.status(404).json({ message: 'Article not found.' });
        const existing = await Article.findById(req.params.id).select('sourceId category').lean();
        if (!existing) return res.status(404).json({ message: 'Article not found.' });
        if (!assertSource(req, res, existing.sourceId)) return;

        const update = pick(req.body || {}, ARTICLE_EDITABLE);
        // Keep the carousel bookkeeping consistent when the category moves in or out of 'feature'.
        if (update.category !== undefined && update.category !== existing.category) {
            if (update.category === FEATURE_CATEGORY) {
                if (!req.studio.isAdmin) return res.status(403).json({ message: 'Only admins can put stories on the home carousel.' });
                update.featuredAt = new Date();
                update.featurePreviousCategory = existing.category || 'general';
            } else if (existing.category === FEATURE_CATEGORY) {
                if (!req.studio.isAdmin) return res.status(403).json({ message: 'Only admins can take stories off the home carousel.' });
                update.$unset = { featuredAt: '', featurePreviousCategory: '' };
            }
        }
        if (update.sourceId !== undefined) {
            if (!isId(String(update.sourceId))) return res.status(400).json({ message: 'Choose a valid source.' });
            if (!assertSource(req, res, update.sourceId)) return;
        }
        if (update.image !== undefined) update.image = normaliseImages(update.image);
        if (update.publishedAt) update.publishedAt = new Date(update.publishedAt);
        if (update.title !== undefined && !String(update.title).trim()) {
            return res.status(400).json({ message: 'Title cannot be empty.' });
        }

        const { $unset, ...fields } = update;
        const article = await Article.findByIdAndUpdate(
            req.params.id,
            { $set: fields, ...($unset ? { $unset } : {}) },
            { new: true, runValidators: true },
        )
            .select('-embedding -embedding_pca -likedBy -dislikedBy -relatedIds')
            .populate('sourceId', 'name icon groupName language category')
            .lean();
        await clearArticlesCache();
        res.json(article);
    } catch (err) {
        fail(res, err, 'Could not save the article.');
    }
});

router.delete('/articles/:id', async (req, res) => {
    try {
        if (!isId(req.params.id)) return res.status(404).json({ message: 'Article not found.' });
        const existing = await Article.findById(req.params.id).select('sourceId').lean();
        if (!existing) return res.status(404).json({ message: 'Article not found.' });
        if (!assertSource(req, res, existing.sourceId)) return;

        await Promise.all([
            Article.deleteOne({ _id: req.params.id }),
            Comment.deleteMany({ articleId: String(req.params.id) }),
        ]);
        await clearArticlesCache();
        res.json({ deleted: true });
    } catch (err) {
        fail(res, err, 'Could not delete the article.');
    }
});

/**
 * Put a story on the home carousel (or bump it back to slot 1). Admin only: the
 * carousel is shared by every reader. The app shows the newest CAROUSEL_SLOTS by
 * featuredAt, so this pushes the oldest live story off the end.
 */
router.post('/articles/:id/feature', requireAdmin, async (req, res) => {
    try {
        if (!isId(req.params.id)) return res.status(404).json({ message: 'Article not found.' });
        const article = await Article.findById(req.params.id).select('category language').lean();
        if (!article) return res.status(404).json({ message: 'Article not found.' });

        const set = { category: FEATURE_CATEGORY, featuredAt: new Date() };
        if (article.category !== FEATURE_CATEGORY) set.featurePreviousCategory = article.category || 'general';
        await Article.updateOne({ _id: article._id }, { $set: set });
        await clearArticlesCache();

        const live = await Article.find({ category: FEATURE_CATEGORY, language: article.language || 'english' })
            .sort({ featuredAt: -1, publishedAt: -1 }).limit(CAROUSEL_SLOTS + 1).select('title').lean();
        res.json({
            featured: true,
            slot: live.findIndex((a) => String(a._id) === String(article._id)) + 1,
            bumped: live.length > CAROUSEL_SLOTS ? { _id: live[CAROUSEL_SLOTS]._id, title: live[CAROUSEL_SLOTS].title } : null,
        });
    } catch (err) {
        fail(res, err, 'Could not feature the article.');
    }
});

/** Take a story off the carousel, into the given category or back to where it came from. */
router.post('/articles/:id/unfeature', requireAdmin, async (req, res) => {
    try {
        if (!isId(req.params.id)) return res.status(404).json({ message: 'Article not found.' });
        const article = await Article.findById(req.params.id).select('category featurePreviousCategory sourceId').lean();
        if (!article) return res.status(404).json({ message: 'Article not found.' });

        let category = String(req.body?.category || '').trim().toLowerCase();
        if (!category || category === FEATURE_CATEGORY) {
            category = article.featurePreviousCategory
                || (await Source.findById(article.sourceId).select('category').lean())?.category
                || 'general';
        }
        await Article.updateOne(
            { _id: article._id },
            { $set: { category }, $unset: { featuredAt: '', featurePreviousCategory: '' } },
        );
        await clearArticlesCache();
        res.json({ featured: false, category });
    } catch (err) {
        fail(res, err, 'Could not take the article off the carousel.');
    }
});

/** Breaking news: admin only, and the push is opt-in — it reaches every user. */
router.post('/articles/:id/breaking', requireAdmin, async (req, res) => {
    try {
        if (!isId(req.params.id)) return res.status(404).json({ message: 'Article not found.' });
        const expiryHours = clampInt(req.body?.expiryHours, 2, 1, 72);
        const priority = clampInt(req.body?.priority, 8, 0, 10);
        const article = await Article.findByIdAndUpdate(
            req.params.id,
            {
                isBreakingNews: true,
                breakingNewsExpiry: new Date(Date.now() + expiryHours * 60 * 60 * 1000),
                breakingNewsPriority: priority,
            },
            { new: true }
        ).populate('sourceId');
        if (!article) return res.status(404).json({ message: 'Article not found.' });
        await clearArticlesCache();

        let push = null;
        if (req.body?.notify === true) {
            const NotificationService = require('../utils/notificationService');
            const result = await NotificationService.sendBreakingNewsToAllUsers(article);
            push = { sent: result?.totalSent || 0, failed: result?.totalFailed || 0 };
        }
        res.json({ breaking: true, expiresAt: article.breakingNewsExpiry, push });
    } catch (err) {
        fail(res, err, 'Could not mark the article as breaking.');
    }
});

router.delete('/articles/:id/breaking', requireAdmin, async (req, res) => {
    try {
        if (!isId(req.params.id)) return res.status(404).json({ message: 'Article not found.' });
        await Article.updateOne(
            { _id: req.params.id },
            { $set: { isBreakingNews: false, breakingNewsPriority: 0 }, $unset: { breakingNewsExpiry: '' } }
        );
        await clearArticlesCache();
        res.json({ breaking: false });
    } catch (err) {
        fail(res, err);
    }
});

// ----------------------------------------------------------------------------
// sources
// ----------------------------------------------------------------------------

async function sourceStats(ids) {
    const key = `srcstats:${ids ? ids.map(String).sort().join(',').slice(0, 2000) + ids.length : 'all'}`;
    const cached = statsCache.get(key);
    if (cached) return cached;

    // Last 7 days only: all-time per-source counts are a full scan of ~550k articles (20s+).
    // The source detail endpoint gives the exact all-time count for one source.
    const match = ids ? { sourceId: { $in: ids } } : {};
    const since7 = new Date(Date.now() - 7 * DAY);
    const recent = await Article.aggregate([
        { $match: { ...match, publishedAt: { $gte: since7 } } },
        { $project: { _id: 0, sourceId: 1, publishedAt: 1, viewCount: 1 } },
        { $group: { _id: '$sourceId', count: { $sum: 1 }, last: { $max: '$publishedAt' }, views: { $sum: '$viewCount' } } },
    ]).option({ maxTimeMS: 15000 });
    const stats = {};
    for (const r of recent) stats[String(r._id)] = { week: r.count, lastPublished: r.last, weekViews: r.views };
    statsCache.set(key, stats);
    return stats;
}

router.get('/sources', async (req, res) => {
    try {
        const filter = req.studio.sourceIds === null ? {} : { _id: { $in: req.studio.sourceIds } };
        if (req.query.status) filter.status = String(req.query.status);
        else filter.status = { $ne: 'blocked' };
        if (req.query.group) filter.groupName = String(req.query.group);
        if (req.query.type) filter.type = String(req.query.type);
        if (req.query.q) {
            const rx = new RegExp(escapeRegex(String(req.query.q).trim()), 'i');
            filter.$or = [{ name: rx }, { groupName: rx }, { url: rx }, { category: rx }];
        }

        const sources = await Source.find(filter).sort({ groupName: 1, name: 1 }).lean();
        // Counts are decoration; a slow aggregate must not take the list down with it.
        const stats = await sourceStats(req.studio.sourceIds).catch(() => ({}));
        res.json(sources.map((s) => ({
            ...s,
            stats: stats[String(s._id)] || { week: 0, lastPublished: null, weekViews: 0 },
        })));
    } catch (err) {
        fail(res, err, 'Could not load sources.');
    }
});

router.get('/sources/:id', async (req, res) => {
    try {
        if (!isId(req.params.id)) return res.status(404).json({ message: 'Source not found.' });
        if (!assertSource(req, res, req.params.id)) return;
        const source = await Source.findById(req.params.id).lean();
        if (!source) return res.status(404).json({ message: 'Source not found.' });

        const [recent, reels, total] = await Promise.all([
            Article.find({ sourceId: source._id }).sort({ publishedAt: -1 }).limit(8).select(ARTICLE_LIST_FIELDS).lean(),
            Reel.countDocuments({ source: source._id }),
            Article.countDocuments({ sourceId: source._id }).maxTimeMS(8000).catch(() => null),
        ]);
        res.json({ ...source, recent, reelCount: reels, articleCount: total });
    } catch (err) {
        fail(res, err);
    }
});

const cleanSourceBody = (studio, body, { creating }) => {
    const data = pick(body || {}, studio.isAdmin ? [...SOURCE_EDITABLE, ...SOURCE_ADMIN_ONLY] : SOURCE_EDITABLE);
    if (data.revSharePercent !== undefined) {
        const pct = Number(data.revSharePercent);
        if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw Object.assign(new Error('Rev share must be between 0 and 100.'), { name: 'ValidationError' });
        data.revSharePercent = pct;
    }
    if (!studio.isAdmin) {
        // Publishers may pause their own sources but not block/unblock — that is moderation.
        if (data.status && !['active', 'suspended'].includes(data.status)) delete data.status;
        if (creating) data.groupName = data.groupName && studio.groups.includes(data.groupName) ? data.groupName : studio.groups[0];
        else if (data.groupName !== undefined && !studio.groups.includes(data.groupName)) {
            throw Object.assign(new Error('You can only move sources between your own groups.'), { name: 'ValidationError' });
        }
    }
    if (data.language) data.language = String(data.language).toLowerCase();
    return data;
};

router.post('/sources', async (req, res) => {
    try {
        if (!req.studio.isAdmin && req.studio.groups.length === 0) {
            return res.status(403).json({ message: 'Your account has no publisher group yet. Ask an admin to assign one.' });
        }
        const data = cleanSourceBody(req.studio, req.body, { creating: true });
        if (!data.name?.trim() || !data.url?.trim()) return res.status(400).json({ message: 'Name and URL are required.' });
        const source = await Source.create({ status: 'active', ...data });
        await invalidateSourceCache();
        invalidateScopeCache();
        statsCache.flushAll();
        res.status(201).json(source);
    } catch (err) {
        fail(res, err, 'Could not create the source.');
    }
});

router.patch('/sources/:id', async (req, res) => {
    try {
        if (!isId(req.params.id)) return res.status(404).json({ message: 'Source not found.' });
        if (!assertSource(req, res, req.params.id)) return;
        const data = cleanSourceBody(req.studio, req.body, { creating: false });
        const source = await Source.findByIdAndUpdate(req.params.id, data, { new: true, runValidators: true }).lean();
        if (!source) return res.status(404).json({ message: 'Source not found.' });
        await invalidateSourceCache();
        invalidateScopeCache();
        res.json(source);
    } catch (err) {
        fail(res, err, 'Could not save the source.');
    }
});

/**
 * Hard delete only for sources that never produced content. Anything with
 * articles would orphan them — those are suspended (publisher) or blocked (admin).
 */
router.delete('/sources/:id', async (req, res) => {
    try {
        if (!isId(req.params.id)) return res.status(404).json({ message: 'Source not found.' });
        if (!assertSource(req, res, req.params.id)) return;
        const [articles, reels] = await Promise.all([
            Article.countDocuments({ sourceId: req.params.id }).limit(1),
            Reel.countDocuments({ source: req.params.id }).limit(1),
        ]);
        if (articles || reels) {
            return res.status(409).json({
                message: 'This source has published content, so it can’t be deleted. Suspend it instead.',
            });
        }
        await Source.deleteOne({ _id: req.params.id });
        await invalidateSourceCache();
        invalidateScopeCache();
        statsCache.flushAll();
        res.json({ deleted: true });
    } catch (err) {
        fail(res, err, 'Could not delete the source.');
    }
});

router.post('/sources/:id/test', async (req, res) => {
    try {
        if (!isId(req.params.id)) return res.status(404).json({ message: 'Source not found.' });
        if (!assertSource(req, res, req.params.id)) return;
        const testSingleSource = require('../scraper/testSingleSource');
        const results = await testSingleSource(req.params.id);
        res.json(results);
    } catch (err) {
        fail(res, err, 'The test scrape failed to run.');
    }
});

router.post('/sources/:id/scrape-reels', async (req, res) => {
    try {
        if (!isId(req.params.id)) return res.status(404).json({ message: 'Source not found.' });
        if (!assertSource(req, res, req.params.id)) return;
        const source = await Source.findById(req.params.id).lean();
        if (!source?.instagramUsername) return res.status(400).json({ message: 'Add an Instagram username to this source first.' });
        const { scrapeReelsForSource } = require('../scraper/instagramReels');
        const reels = await scrapeReelsForSource(source._id, source.instagramUsername);
        res.json({ count: Array.isArray(reels) ? reels.length : 0 });
    } catch (err) {
        fail(res, err, 'Could not fetch reels from Instagram.');
    }
});

// ----------------------------------------------------------------------------
// reels
// ----------------------------------------------------------------------------

const REEL_FIELDS = 'source reelId videoUrl thumbnailUrl scrapedAt publishedAt caption likes dislikes viewCount saves ' +
    'categories completionRate avgWatchTime engagement_score createdAt';

router.get('/reels', async (req, res) => {
    try {
        const page = clampInt(req.query.page, 1, 1, 10000);
        const limit = clampInt(req.query.limit, 24, 1, 96);
        const ids = await sourceIdsForFilter(req.studio, req.query);
        if (Array.isArray(ids) && ids.length === 0) return res.json({ items: [], page, limit, total: 0, hasMore: false });

        const filter = ids ? { source: { $in: ids } } : {};
        if (req.query.q) filter.caption = new RegExp(escapeRegex(String(req.query.q).trim()), 'i');
        const SORTS = { recent: { scrapedAt: -1 }, views: { viewCount: -1 }, likes: { likes: -1 }, completion: { completionRate: -1 } };
        const sort = SORTS[req.query.sort] || SORTS.recent;

        const [items, total] = await Promise.all([
            Reel.find(filter).sort(sort).skip((page - 1) * limit).limit(limit)
                .select(REEL_FIELDS).populate('source', 'name icon groupName').lean().maxTimeMS(15000),
            Reel.countDocuments(filter).maxTimeMS(4000).catch(() => null),
        ]);
        res.json({ items, page, limit, total, hasMore: total === null ? items.length === limit : page * limit < total });
    } catch (err) {
        fail(res, err, 'Could not load reels.');
    }
});

router.patch('/reels/:id', async (req, res) => {
    try {
        if (!isId(req.params.id)) return res.status(404).json({ message: 'Reel not found.' });
        const reel = await Reel.findById(req.params.id).select('source').lean();
        if (!reel) return res.status(404).json({ message: 'Reel not found.' });
        if (!assertSource(req, res, reel.source)) return;

        const update = pick(req.body || {}, ['caption', 'categories', 'publishedAt']);
        if (update.categories) update.categories = [].concat(update.categories).map(String).filter(Boolean);
        const saved = await Reel.findByIdAndUpdate(req.params.id, update, { new: true })
            .select(REEL_FIELDS).populate('source', 'name icon groupName').lean();
        res.json(saved);
    } catch (err) {
        fail(res, err, 'Could not save the reel.');
    }
});

router.delete('/reels/:id', async (req, res) => {
    try {
        if (!isId(req.params.id)) return res.status(404).json({ message: 'Reel not found.' });
        const reel = await Reel.findById(req.params.id).select('source').lean();
        if (!reel) return res.status(404).json({ message: 'Reel not found.' });
        if (!assertSource(req, res, reel.source)) return;
        await Promise.all([
            Reel.deleteOne({ _id: req.params.id }),
            Comment.deleteMany({ reelId: String(req.params.id) }),
        ]);
        res.json({ deleted: true });
    } catch (err) {
        fail(res, err, 'Could not delete the reel.');
    }
});

router.get('/analytics/reels', async (req, res) => {
    try {
        const days = clampInt(req.query.days, 30, 1, 365);
        const { start } = windowFor(days);
        const scope = scopeFilter(req.studio, 'source');
        const inWindow = { ...scope, scrapedAt: { $gte: start } };

        const [totals, top, bySource] = await Promise.all([
            Reel.aggregate([
                { $match: inWindow },
                {
                    $group: {
                        _id: null,
                        reels: { $sum: 1 },
                        views: { $sum: '$viewCount' },
                        likes: { $sum: '$likes' },
                        saves: { $sum: '$saves' },
                        completion: { $avg: { $cond: [{ $gt: ['$completionRate', 0] }, '$completionRate', null] } },
                        watchMs: { $sum: '$totalWatchTime' },
                    },
                },
            ]),
            Reel.find(inWindow).sort({ viewCount: -1 }).limit(12).select(REEL_FIELDS).populate('source', 'name icon groupName').lean(),
            Reel.aggregate([
                { $match: inWindow },
                { $group: { _id: '$source', reels: { $sum: 1 }, views: { $sum: '$viewCount' }, likes: { $sum: '$likes' } } },
                { $sort: { views: -1 } },
                { $limit: 10 },
            ]),
        ]);
        const map = await sourceMap(bySource.map((s) => s._id));
        const t = totals[0] || { reels: 0, views: 0, likes: 0, saves: 0, completion: null, watchMs: 0 };
        res.json({
            days,
            totals: { ...t, _id: undefined, completion: t.completion === null ? null : round(t.completion, 1), watchHours: round(t.watchMs / 3_600_000, 1) },
            top,
            bySource: bySource.map((s) => ({ sourceId: s._id, name: map[String(s._id)]?.name || 'Unknown', icon: map[String(s._id)]?.icon || null, reels: s.reels, views: s.views, likes: s.likes })),
        });
    } catch (err) {
        fail(res, err, 'Could not load reel analytics.');
    }
});

// ----------------------------------------------------------------------------
// revenue + rev share
// ----------------------------------------------------------------------------

router.get('/revenue', async (req, res) => {
    try {
        const range = parseRange(req.query, 30);
        if (!range) return res.status(400).json({ message: 'Invalid date range.' });
        const match = { ...scopeFilter(req.studio), ts: { $gte: range.from, $lte: range.to } };

        const [bySourceRaw, byDayRaw, byPlatformRaw] = await Promise.all([
            AdRevenueEvent.aggregate([
                { $match: match },
                { $group: { _id: '$sourceId', value: { $sum: '$value' }, impressions: { $sum: 1 }, name: { $first: '$sourceName' } } },
                { $sort: { value: -1 } },
            ]),
            AdRevenueEvent.aggregate([
                { $match: match },
                {
                    $group: {
                        _id: { day: { $dateToString: { format: '%Y-%m-%d', date: '$ts', timezone: TZ } }, sourceId: '$sourceId' },
                        value: { $sum: '$value' },
                        impressions: { $sum: 1 },
                    },
                },
            ]),
            AdRevenueEvent.aggregate([
                { $match: match },
                { $group: { _id: '$platform', value: { $sum: '$value' }, impressions: { $sum: 1 } } },
            ]),
        ]);

        const map = await sourceMap(bySourceRaw.map((s) => s._id));
        const shareOf = (id) => (map[String(id)]?.revSharePercent ?? 70) / 100;

        const bySource = bySourceRaw.map((s) => {
            const gross = s.value / MICRO;
            return {
                sourceId: s._id,
                name: map[String(s._id)]?.name || s.name,
                icon: map[String(s._id)]?.icon || null,
                groupName: map[String(s._id)]?.groupName || null,
                impressions: s.impressions,
                grossUSD: round(gross, 4),
                revSharePercent: map[String(s._id)]?.revSharePercent ?? 70,
                payoutUSD: round(gross * shareOf(s._id), 4),
                ecpm: s.impressions ? round((gross / s.impressions) * 1000, 4) : 0,
            };
        });

        const days = {};
        for (const d of byDayRaw) {
            const gross = d.value / MICRO;
            const row = days[d._id.day] || (days[d._id.day] = { date: d._id.day, grossUSD: 0, payoutUSD: 0, impressions: 0 });
            row.grossUSD += gross;
            row.payoutUSD += gross * shareOf(d._id.sourceId);
            row.impressions += d.impressions;
        }
        const byDay = [];
        for (let t = range.from.getTime(); t <= range.to.getTime(); t += DAY) {
            const key = new Date(t).toLocaleDateString('en-CA', { timeZone: TZ });
            if (byDay.length && byDay[byDay.length - 1].date === key) continue;
            const row = days[key] || { date: key, grossUSD: 0, payoutUSD: 0, impressions: 0 };
            byDay.push({ ...row, grossUSD: round(row.grossUSD, 4), payoutUSD: round(row.payoutUSD, 4) });
        }

        const totals = bySource.reduce(
            (acc, s) => ({ grossUSD: acc.grossUSD + s.grossUSD, payoutUSD: acc.payoutUSD + s.payoutUSD, impressions: acc.impressions + s.impressions }),
            { grossUSD: 0, payoutUSD: 0, impressions: 0 }
        );

        res.json({
            range,
            totals: {
                grossUSD: round(totals.grossUSD, 2),
                payoutUSD: round(totals.payoutUSD, 2),
                platformUSD: round(totals.grossUSD - totals.payoutUSD, 2),
                impressions: totals.impressions,
                ecpm: totals.impressions ? round((totals.grossUSD / totals.impressions) * 1000, 3) : 0,
            },
            byDay,
            bySource,
            byPlatform: byPlatformRaw.map((p) => ({ platform: p._id, grossUSD: round(p.value / MICRO, 2), impressions: p.impressions })),
        });
    } catch (err) {
        fail(res, err, 'Could not load revenue.');
    }
});

/** Set the rev-share percent for a whole group or a list of sources. Admin only. */
router.patch('/revenue/share', requireAdmin, async (req, res) => {
    try {
        const pct = Number(req.body?.revSharePercent);
        if (!Number.isFinite(pct) || pct < 0 || pct > 100) return res.status(400).json({ message: 'Rev share must be between 0 and 100.' });
        const filter = req.body?.groupName
            ? { groupName: String(req.body.groupName) }
            : { _id: { $in: [].concat(req.body?.sourceIds || []).filter(isId) } };
        if (!filter.groupName && filter._id.$in.length === 0) return res.status(400).json({ message: 'Choose a group or sources.' });
        const result = await Source.updateMany(filter, { $set: { revSharePercent: pct } });
        await invalidateSourceCache();
        res.json({ updated: result.modifiedCount, revSharePercent: pct });
    } catch (err) {
        fail(res, err);
    }
});

// ----------------------------------------------------------------------------
// payouts
// ----------------------------------------------------------------------------

const PERIOD_RX = /^\d{4}-(0[1-9]|1[0-2])$/;
const periodBounds = (period) => {
    const [y, m] = period.split('-').map(Number);
    return { periodStart: new Date(Date.UTC(y, m - 1, 1)), periodEnd: new Date(Date.UTC(y, m, 1)) };
};

router.get('/payouts', async (req, res) => {
    try {
        const filter = req.studio.isAdmin ? {} : { groupName: { $in: req.studio.groups } };
        if (req.query.status) filter.status = String(req.query.status);
        if (req.query.group) {
            if (!canAccessGroup(req.studio, String(req.query.group))) return res.json([]);
            filter.groupName = String(req.query.group);
        }
        // Publishers never see drafts — those are still being reviewed.
        if (!req.studio.isAdmin) filter.status = filter.status && filter.status !== 'draft' ? filter.status : { $in: ['approved', 'paid'] };
        const payouts = await Payout.find(filter).select('-lines').sort({ periodStart: -1, groupName: 1 }).limit(500).lean();
        res.json(payouts);
    } catch (err) {
        fail(res, err, 'Could not load payouts.');
    }
});

router.get('/payouts/:id', async (req, res) => {
    try {
        if (!isId(req.params.id)) return res.status(404).json({ message: 'Statement not found.' });
        const payout = await Payout.findById(req.params.id).lean();
        if (!payout || !canAccessGroup(req.studio, payout.groupName) || (!req.studio.isAdmin && payout.status === 'draft')) {
            return res.status(404).json({ message: 'Statement not found.' });
        }
        res.json(payout);
    } catch (err) {
        fail(res, err);
    }
});

/**
 * Build (or rebuild) draft statements for a month. Approved, paid and void
 * statements are frozen and reported back as skipped.
 */
router.post('/payouts/generate', requireAdmin, async (req, res) => {
    try {
        const period = String(req.body?.period || '');
        if (!PERIOD_RX.test(period)) return res.status(400).json({ message: 'Period must look like 2026-09.' });
        const { periodStart, periodEnd } = periodBounds(period);
        if (periodStart > new Date()) return res.status(400).json({ message: 'That month hasn’t started yet.' });

        await Payout.createIndexes(); // autoIndex is off in prod; the unique index guards double-generation.

        const events = await AdRevenueEvent.aggregate([
            { $match: { ts: { $gte: periodStart, $lt: periodEnd } } },
            { $group: { _id: '$sourceId', value: { $sum: '$value' }, impressions: { $sum: 1 }, name: { $first: '$sourceName' } } },
        ]);
        const map = await sourceMap(events.map((e) => e._id));

        const groups = {};
        for (const e of events) {
            const src = map[String(e._id)];
            const groupName = src?.groupName || src?.name || e.name || 'Unassigned';
            const gross = e.value / MICRO;
            const pct = src?.revSharePercent ?? 70;
            const g = groups[groupName] || (groups[groupName] = { lines: [], impressions: 0, grossUSD: 0, payoutUSD: 0 });
            g.lines.push({ sourceId: e._id, sourceName: src?.name || e.name, impressions: e.impressions, grossUSD: round(gross, 6), revSharePercent: pct, payoutUSD: round(gross * (pct / 100), 6) });
            g.impressions += e.impressions;
            g.grossUSD += gross;
            g.payoutUSD += gross * (pct / 100);
        }

        const result = { period, created: 0, updated: 0, skipped: [] };
        for (const [groupName, g] of Object.entries(groups)) {
            const existing = await Payout.findOne({ groupName, period }).select('status').lean();
            if (existing && existing.status !== 'draft') {
                result.skipped.push({ groupName, status: existing.status });
                continue;
            }
            await Payout.updateOne(
                { groupName, period },
                {
                    $set: {
                        periodStart, periodEnd, currency: 'USD', lines: g.lines, impressions: g.impressions,
                        grossUSD: round(g.grossUSD, 4), payoutUSD: round(g.payoutUSD, 4), status: 'draft',
                        updatedBy: req.studio.user?.email || 'service',
                    },
                    $setOnInsert: { createdBy: req.studio.user?.email || 'service' },
                },
                { upsert: true }
            );
            existing ? result.updated++ : result.created++;
        }
        res.json(result);
    } catch (err) {
        fail(res, err, 'Could not generate statements.');
    }
});

const TRANSITIONS = {
    draft: ['approved', 'void'],
    approved: ['paid', 'draft', 'void'],
    paid: [],
    void: ['draft'],
};

router.patch('/payouts/:id', requireAdmin, async (req, res) => {
    try {
        if (!isId(req.params.id)) return res.status(404).json({ message: 'Statement not found.' });
        const payout = await Payout.findById(req.params.id);
        if (!payout) return res.status(404).json({ message: 'Statement not found.' });

        const { status } = req.body || {};
        if (status && status !== payout.status) {
            if (!TRANSITIONS[payout.status]?.includes(status)) {
                return res.status(409).json({ message: `A ${payout.status} statement can’t be moved to ${status}.` });
            }
            if (status === 'paid' && !String(req.body.reference || payout.reference || '').trim()) {
                return res.status(400).json({ message: 'Add the transfer reference before marking it paid.' });
            }
            payout.status = status;
            if (status === 'approved') payout.approvedAt = new Date();
            if (status === 'paid') payout.paidAt = req.body.paidAt ? new Date(req.body.paidAt) : new Date();
        }
        for (const k of ['method', 'reference', 'notes']) {
            if (req.body?.[k] !== undefined) payout[k] = String(req.body[k]).slice(0, 2000);
        }
        payout.updatedBy = req.studio.user?.email || 'service';
        await payout.save();
        res.json(payout.toObject());
    } catch (err) {
        fail(res, err, 'Could not update the statement.');
    }
});

// ----------------------------------------------------------------------------
// users (admin)
// ----------------------------------------------------------------------------

router.get('/users', requireAdmin, async (req, res) => {
    try {
        const page = clampInt(req.query.page, 1, 1, 10000);
        const limit = clampInt(req.query.limit, 25, 1, 100);
        const filter = { isSynthetic: { $ne: true } };
        if (req.query.type) filter.type = String(req.query.type);
        if (req.query.q) {
            const rx = new RegExp(escapeRegex(String(req.query.q).trim()), 'i');
            filter.$or = [{ email: rx }, { name: rx }];
        }

        const [items, total, counts] = await Promise.all([
            User.find(filter)
                .select('email name type publisher_group profile_image avatar_url city language createdAt supabase_id')
                .sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
            User.countDocuments(filter),
            User.aggregate([
                { $match: { isSynthetic: { $ne: true } } },
                { $group: { _id: { $ifNull: ['$type', 'user'] }, count: { $sum: 1 } } },
            ]),
        ]);
        const byType = { admin: 0, publisher: 0, user: 0 };
        for (const c of counts) byType[c._id || 'user'] = (byType[c._id || 'user'] || 0) + c.count;
        res.json({ items, page, limit, total, hasMore: page * limit < total, byType });
    } catch (err) {
        fail(res, err, 'Could not load accounts.');
    }
});

router.patch('/users/:id', requireAdmin, async (req, res) => {
    try {
        if (!isId(req.params.id)) return res.status(404).json({ message: 'Account not found.' });
        const { type, publisher_group: groups } = req.body || {};
        if (req.studio.user && String(req.studio.user._id) === req.params.id && type && type !== 'admin') {
            return res.status(400).json({ message: 'You can’t remove your own admin access.' });
        }

        const update = {};
        if (type !== undefined) {
            if (!['admin', 'publisher', 'user'].includes(type)) return res.status(400).json({ message: 'Unknown role.' });
            update.type = type;
        }
        if (groups !== undefined) {
            if (!Array.isArray(groups)) return res.status(400).json({ message: 'Groups must be a list.' });
            const known = new Set(await Source.distinct('groupName'));
            const unknown = groups.filter((g) => !known.has(g));
            if (unknown.length) return res.status(400).json({ message: `Unknown group: ${unknown.join(', ')}` });
            update.publisher_group = [...new Set(groups)];
        }
        if (update.type && update.type !== 'publisher' && groups === undefined) update.publisher_group = [];

        const user = await User.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true })
            .select('email name type publisher_group profile_image avatar_url city language createdAt').lean();
        if (!user) return res.status(404).json({ message: 'Account not found.' });
        invalidateScopeCache();
        res.json(user);
    } catch (err) {
        fail(res, err, 'Could not update the account.');
    }
});

// ----------------------------------------------------------------------------
// command palette search
// ----------------------------------------------------------------------------

router.get('/search', async (req, res) => {
    try {
        const q = String(req.query.q || '').trim();
        if (q.length < 2) return res.json({ articles: [], sources: [], users: [] });
        const rx = new RegExp(escapeRegex(q), 'i');
        const sourceFilter = req.studio.sourceIds === null ? {} : { _id: { $in: req.studio.sourceIds } };

        const [articles, sources, users] = await Promise.all([
            studioSearch({ q, sourceIds: req.studio.sourceIds, limit: 6, skip: 0 })
                .then((r) => r.items.map((a) => ({ _id: a._id, title: a.title, sourceName: a.sourceId?.name || null, publishedAt: a.publishedAt, image: a.image?.[0] || null })))
                .catch(() => []),
            Source.find({ ...sourceFilter, $or: [{ name: rx }, { groupName: rx }] }).select('name groupName icon status').limit(6).lean(),
            req.studio.isAdmin
                ? User.find({ isSynthetic: { $ne: true }, $or: [{ email: rx }, { name: rx }] }).select('email name type').limit(5).lean()
                : Promise.resolve([]),
        ]);
        res.json({ articles, sources, users });
    } catch (err) {
        fail(res, err);
    }
});

module.exports = router;
