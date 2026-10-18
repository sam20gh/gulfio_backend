/**
 * Source doctor — powers Studio's admin-only "Diagnose & fix" panel.
 *
 * Fetches a source's listing and a couple of its articles the way production does, works
 * out WHY it isn't producing stories, and, when the cause is selectors, proposes
 * replacements verified against the live pages. Read-only: nothing is saved here; the
 * admin applies a fix through the normal source update.
 *
 * Most broken sources are not selector problems (WAF blocks, JavaScript-only listings,
 * sites that stopped publishing), so the verdict is decided first and selector
 * suggestions are only offered when they can actually help.
 */

const axios = require('axios');
const cheerio = require('cheerio');
const Article = require('../models/Article');
const T = require('./selectorTools');
const testSingleSource = require('./testSingleSource');

const {
    isElementVisible, normalizeImages, resolveHref, getListApiConfig, fetchApiListingLinks,
    extractPublishedAt, assessFreshness,
} = testSingleSource.helpers;

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
};

const CONTENT_OK = 200;   // chars; below this a story reads as a stub
const CONTENT_MIN = 50;   // production's save gate
const MAX_ARTICLES = 2;   // second article guards against one-off layouts

async function fetchPage(url) {
    const started = Date.now();
    try {
        const res = await axios.get(url, {
            timeout: 15000,
            maxContentLength: 10 * 1024 * 1024,
            validateStatus: () => true,
            responseType: 'text',
            transformResponse: [(d) => d],
            headers: HEADERS,
        });
        const body = typeof res.data === 'string' ? res.data : '';
        return {
            url,
            ok: res.status < 400,
            status: res.status,
            bytes: body.length,
            ms: Date.now() - started,
            block: T.detectBlock({ status: res.status, headers: res.headers || {}, body }),
            body,
        };
    } catch (err) {
        return { url, ok: false, status: null, bytes: 0, ms: Date.now() - started, block: null, error: { ...T.classifyFetchError(err), message: err.message }, body: '' };
    }
}

const publicFetch = ({ body, ...rest }) => rest;

// ─────────────────────────────── listing ───────────────────────────────

/** Links a list/link selector pair yields — same rules as production's parseLinks. */
function linksFor($, source, listSelector, linkSelector) {
    const sel = T.safeSelect($, listSelector);
    if (!sel.ok) return { valid: false, error: sel.error, matches: 0, links: [] };
    const links = [];
    sel.$els.each((_, el) => {
        const $el = $(el);
        let href = null;
        try {
            href = $el.is('a') ? $el.attr('href') : ($el.find(linkSelector || 'a').first().attr('href') || $el.attr('href'));
        } catch { /* bad link selector → no href */ }
        const url = resolveHref(href, source);
        if (url && !links.includes(url)) links.push(url);
    });
    return { valid: true, error: null, matches: sel.$els.length, links };
}

function anchorIndex($, pageUrl) {
    const byUrl = new Map();
    $('a[href]').each((_, a) => {
        let url;
        try { url = new URL($(a).attr('href'), pageUrl).toString().split('#')[0]; } catch { return; }
        const text = T.squash($(a).text()) || $(a).find('img').attr('alt') || '';
        const prev = byUrl.get(url);
        if (!prev || text.length > prev.length) byUrl.set(url, text);
    });
    return byUrl;
}

function signature($, el) {
    const chain = [];
    let cur = el;
    for (let i = 0; cur && cur.type === 'tag' && i < 4; i++, cur = cur.parent) chain.push(T.simpleSelector(cur, $));
    return chain.reverse().join(' > ');
}

// Whole class/id words only — "widget" or "promo" often wrap real content, and a bare
// "nav" substring would hit "canvas".
const NOT_BODY = /(^|[\s_-])(nav|navbar|menu|footer|sidebar|side-bar|breadcrumbs?|comments?|related|newsletter|subscribe|cookie|social|share|sharing|most-?read|most-?popular|trending|recommended|advert\w*|ads?)([\s_-]|$)/i;

/** Page chrome (header/nav/footer/aside or sidebar-ish blocks) — never the story list. */
function inChrome($, el) {
    if ($(el).closest('header, nav, footer, aside').length) return true;
    for (let cur = el.parent, i = 0; cur && cur.type === 'tag' && i < 6; i++, cur = cur.parent) {
        if (NOT_BODY.test(`${cur.attribs.class || ''} ${cur.attribs.id || ''}`)) return true;
    }
    return false;
}

/**
 * Candidate list selectors: group story-looking links by their local DOM structure, then
 * find the shortest selector that captures a group (≥80%) while staying on stories (≥85%).
 * A broader variant is kept too when it adds a lot more stories — admins pick from samples.
 */
function listCandidates($, source, storedShapes) {
    const host = T.hostOf(source.url);
    const texts = anchorIndex($, source.url);
    const groups = new Map();
    const chromeUrls = new Set();
    $('a[href]').each((_, a) => {
        let url;
        try { url = new URL($(a).attr('href'), source.url).toString().split('#')[0]; } catch { return; }
        if (!T.articleLikeUrl(url, host)) return;
        if (inChrome($, a)) { chromeUrls.add(url); return; }
        const key = signature($, a);
        if (!groups.has(key)) groups.set(key, { first: a, urls: new Set() });
        groups.get(key).urls.add(url);
    });

    // Links that only appear in page chrome don't count as stories for precision.
    const isStory = (u) => T.articleLikeUrl(u, host) && !chromeUrls.has(u);
    const out = new Map();
    for (const g of groups.values()) {
        if (g.urls.size < 3) continue;
        const own = T.simpleSelector(g.first, $);
        const tries = own !== 'a' ? [own] : [];
        let cur = g.first.parent;
        for (let d = 0; cur && cur.type === 'tag' && cur.tagName !== 'body' && d < 6; d++, cur = cur.parent) {
            const anc = T.simpleSelector(cur, $);
            if (anc !== cur.tagName) tries.push(`${anc} ${own}`);
        }
        const accepted = [];
        for (const sel of tries) {
            const r = linksFor($, source, sel, 'a');
            if (!r.valid || r.links.length < 3 || r.links.length > 150) continue;
            const stories = r.links.filter(isStory);
            const precision = stories.length / r.links.length;
            const covered = [...g.urls].filter((u) => r.links.includes(u)).length / g.urls.size;
            if (precision < 0.85 || covered < 0.8) continue;
            const union = new Set([...r.links, ...g.urls]).size;
            accepted.push({ sel, links: r.links, stories: stories.length, focus: covered * g.urls.size / union });
        }
        if (!accepted.length) continue;
        const focused = [...accepted].sort((a, b) => b.focus - a.focus || a.sel.length - b.sel.length)[0];
        const broad = [...accepted].sort((a, b) => b.stories - a.stories)[0];
        for (const c of broad.stories >= focused.stories * 1.3 ? [focused, broad] : [focused]) {
            if (out.has(c.sel)) continue;
            const shapeHits = storedShapes.size ? c.links.filter((u) => storedShapes.has(T.urlShape(u))).length / c.links.length : null;
            out.set(c.sel, {
                listSelector: c.sel,
                linkSelector: 'a',
                links: c.links.length,
                stories: c.stories,
                matchesPastUrls: shapeHits,
                focus: Math.round(c.focus * 100) / 100,
                sample: c.links.slice(0, 3).map((u) => ({ url: u, text: (texts.get(u) || '').slice(0, 120) })),
                _links: c.links,
            });
        }
    }
    return [...out.values()]
        // Past-URL match first (it's the strongest signal), then stories × how tightly the
        // selector fits one list — a page-wide "a.photo" also sweeps sliders and side boxes.
        .sort((a, b) => (b.matchesPastUrls ?? 0) - (a.matchesPastUrls ?? 0) || b.stories * b.focus - a.stories * a.focus)
        .slice(0, 5);
}

// ─────────────────────────────── article fields ───────────────────────────────

const firstVisible = ($, sel) => {
    const r = T.safeSelect($, sel);
    return r.ok ? r.$els.filter((_, el) => isElementVisible($, el)).first() : null;
};

function readTitle($, sel) {
    const r = T.safeSelect($, sel);
    if (!r.ok) return { valid: false, error: r.error, value: '' };
    return { valid: true, error: null, value: T.squash(r.$els.filter((_, el) => isElementVisible($, el)).first().text()) };
}

function readImages($, sel, baseUrl) {
    const r = T.safeSelect($, sel);
    if (!r.ok) return { valid: false, error: r.error, value: [] };
    const srcs = r.$els.map((_, img) => $(img).attr('src') || $(img).attr('data-src')).get().filter(Boolean);
    return { valid: true, error: null, value: normalizeImages(srcs, baseUrl) };
}

function referenceTitle($) {
    const og = $('meta[property="og:title"]').attr('content') || $('meta[name="twitter:title"]').attr('content');
    const doc = $('title').first().text();
    return T.squash(og || doc || '').replace(/\s+[|\-–—]\s+[^|\-–—]{2,40}$/, '');
}

function titleCandidates($) {
    const ref = referenceTitle($);
    if (!ref) return [];
    const out = new Map();
    $('h1, h2, [itemprop="headline"], [class*="title"], [class*="headline"]').slice(0, 400).each((_, el) => {
        const text = T.squash($(el).text());
        if (text.length < 10 || text.length > 300) return;
        const sim = T.titleOverlap(text, ref);
        if (sim < 0.6) return;
        const sel = T.selectorFor($, el, { accept: (s) => { const f = firstVisible($, s); return f && f[0] === el; } });
        if (!sel || out.has(sel)) return;
        out.set(sel, { selector: sel, value: text.slice(0, 200), score: sim + (el.tagName === 'h1' ? 0.25 : 0) });
    });
    return [...out.values()].sort((a, b) => b.score - a.score).slice(0, 4);
}

function contentCandidates($) {
    const scored = [];
    $('article, main, section, div, [itemprop="articleBody"]').slice(0, 4000).each((_, el) => {
        const ps = $(el).children('p').toArray().map((p) => T.squash($(p).text()).length).filter((n) => n >= 30);
        const total = ps.reduce((a, b) => a + b, 0);
        if (ps.length < 2 && total < 300) return;
        let bad = false;
        for (let cur = el, i = 0; cur && cur.type === 'tag' && i < 3; i++, cur = cur.parent) {
            if (NOT_BODY.test(`${cur.attribs.class || ''} ${cur.attribs.id || ''}`)) { bad = true; break; }
        }
        if (!bad) scored.push({ el, total });
    });
    scored.sort((a, b) => b.total - a.total);
    const out = new Map();
    for (const { el } of scored.slice(0, 6)) {
        const container = T.selectorFor($, el, { accept: (s) => { const m = $(s); return m.length <= 3 && m.toArray().includes(el); } });
        if (!container) continue;
        const selector = `${container} p`;
        if (out.has(selector)) continue;
        const text = T.extractContentText($, selector, isElementVisible);
        if (text.length < CONTENT_OK) continue;
        out.set(selector, { selector, length: text.length, preview: text.slice(0, 280), _el: el });
    }
    return [...out.values()].sort((a, b) => b.length - a.length).slice(0, 4);
}

function imageCandidates($, baseUrl) {
    const og = $('meta[property="og:image"]').attr('content') || $('meta[name="twitter:image"]').attr('content') || '';
    let ogName = '';
    try { ogName = decodeURIComponent(new URL(og, baseUrl).pathname.split('/').pop() || ''); } catch { /* no og */ }
    const out = new Map();
    $('img').slice(0, 300).each((_, img) => {
        const src = img.attribs.src || img.attribs['data-src'] || String(img.attribs.srcset || '').split(/[\s,]/)[0];
        if (!src || /^data:/i.test(src) || /\.svg(\?|$)/i.test(src) || /(logo|icon|avatar|author|sprite|placeholder|pixel|blank)/i.test(src)) return;
        if (inChrome($, img)) return;
        let score = 0;
        let decoded = src;
        try { decoded = decodeURIComponent(src); } catch { /* keep raw */ }
        if (ogName && ogName.length > 4 && decoded.includes(ogName)) score += 3;
        if (Number(img.attribs.width) >= 400) score += 1;
        if ($(img).closest('article, main, [class*="article"], [class*="post"], [class*="story"], [class*="news-detail"], [class*="content"]').length) score += 1;
        if (score < 1) return;
        let sel = T.selectorFor($, img, { accept: (s) => { const m = $(s); return m.length <= 6 && m[0] === img; } });
        if (!sel) return;
        // Drop icons that share the container (Gulf Today's play-button.svg sits beside the photo).
        if ($(sel).toArray().some((m) => /\.svg(\?|$)/i.test(m.attribs.src || ''))) sel = `${sel}:not([src$=".svg"])`;
        if (out.has(sel)) return;
        const value = readImages($, sel, baseUrl).value;
        if (!value.length) return;
        out.set(sel, { selector: sel, value: value[0], score });
    });
    return { og: og ? normalizeImages([og], baseUrl)[0] || null : null, candidates: [...out.values()].sort((a, b) => b.score - a.score).slice(0, 4) };
}

function fieldStatus(kind, current, best) {
    if (!current.valid) return 'invalid';
    if (kind === 'content') {
        // A "first match only" selector that misses most of the body — the bug class that
        // silently cut Peninsula to 0 chars and Entekhab to one paragraph.
        if (current.mode === 'first match only' && best && best.length >= current.length * 2 && best.length >= CONTENT_OK) return 'truncated';
        return current.length >= CONTENT_OK ? 'ok' : current.length > CONTENT_MIN ? 'thin' : 'missing';
    }
    if (kind === 'image') return current.value.length ? 'ok' : 'missing';
    return current.value.length > 5 ? 'ok' : 'missing';
}

/** Evaluate a candidate on every fetched article; kept only if it works on all of them. */
function confirmOnAll(pages, check) {
    return pages.every(($) => {
        try { return check($); } catch { return false; }
    });
}

async function diagnoseArticles(source, urls, apiCfg) {
    const baseUrl = source.baseUrl || source.url;
    const pages = [];
    const fetches = [];
    for (const url of urls.slice(0, MAX_ARTICLES)) {
        const f = await fetchPage(url);
        fetches.push(publicFetch(f));
        if (f.ok && !f.block) pages.push({ url, $: cheerio.load(f.body) });
    }
    if (!pages.length) return { fetches, blocked: fetches.find((f) => f.block || f.error || !f.ok) || null };

    const { $ } = pages[0];
    const $all = pages.map((p) => p.$);
    const titleCur = readTitle($, source.titleSelector);
    const { text: contentText, viaJsonLd } = source.contentSelector
        ? T.extractContentWithFallback($, source.contentSelector, isElementVisible)
        : { text: '', viaJsonLd: false };
    const contentSel = T.safeSelect($, source.contentSelector);
    const contentCur = {
        valid: contentSel.ok,
        error: contentSel.error,
        length: contentText.length,
        preview: contentText.slice(0, 280),
        mode: viaJsonLd ? 'JSON-LD articleBody (selector found only a stub)'
            : source.contentSelector && contentSel.ok ? (T.isMultiElementContentSelector(source.contentSelector) ? 'all matches' : 'first match only') : null,
    };
    let imageCur = source.imageSelector ? readImages($, source.imageSelector, baseUrl) : { valid: false, error: 'No selector set', value: [] };
    // Production uses og:image for API-listed sources that prefer it, and as their fallback.
    if (apiCfg && (apiCfg.preferOgImage || !imageCur.value.length)) {
        const og = $('meta[property="og:image"]').attr('content') || $('meta[name="twitter:image"]').attr('content');
        if (og) imageCur = { valid: true, error: null, value: normalizeImages([og], baseUrl), viaOgImage: true };
    }

    const titles = titleCandidates($).filter((c) => confirmOnAll($all, (p) => readTitle(p, c.selector).value.length > 5));
    const contents = contentCandidates($)
        .filter((c) => confirmOnAll($all, (p) => T.extractContentText(p, c.selector, isElementVisible).length >= CONTENT_OK * 0.6))
        .map(({ _el, ...c }) => c);
    const images = imageCandidates($, baseUrl);
    images.candidates = images.candidates.filter((c) => confirmOnAll($all, (p) => readImages(p, c.selector, baseUrl).value.length > 0));

    return {
        fetches,
        blocked: null,
        publishDates: pages.map((p) => extractPublishedAt(p.$)).filter(Boolean),
        sampleUrl: pages[0].url,
        fields: {
            title: { selector: source.titleSelector || '', current: { ...titleCur, value: titleCur.value.slice(0, 200) }, status: fieldStatus('title', titleCur), candidates: titles },
            content: { selector: source.contentSelector || '', current: contentCur, status: fieldStatus('content', contentCur, contents[0]), candidates: contents },
            image: {
                selector: source.imageSelector || '',
                current: { ...imageCur, value: imageCur.value.slice(0, 3) },
                status: fieldStatus('image', imageCur),
                candidates: images.candidates,
                ogImage: images.og,
            },
        },
    };
}

// ─────────────────────────────── verdict ───────────────────────────────

function blockedVerdict(f, where) {
    if (f.error && f.error.kind === 'tls') {
        return {
            kind: 'tls', severity: 'bad', title: 'HTTPS certificate problem',
            detail: `The ${where} fails TLS verification (${f.error.code}). Browsers often load it anyway, but the scraper refuses the connection — usually the server leaves out an intermediate certificate. Selectors can't fix this; it needs a code-side certificate fix, or pause the source.`,
            actions: ['pause'],
        };
    }
    if (f.error) {
        return {
            kind: 'network', severity: 'bad', title: 'Site unreachable',
            detail: `Couldn't reach the ${where} (${f.error.code || f.error.message}). The site may be down, or the URL may have changed.`,
            actions: ['pause'],
        };
    }
    if (f.block) {
        const { vendor, mode, status } = f.block;
        if (mode === 'challenge') {
            return {
                kind: 'blocked', severity: 'warn', title: `${vendor} bot challenge`,
                detail: `The ${where} answers our servers with a ${vendor} challenge (HTTP ${status}). Production retries those pages in a headless browser, which sometimes gets through — check whether recent runs saved stories before changing anything.`,
                actions: ['pause', 'mediaOnly'],
            };
        }
        return {
            kind: 'blocked', severity: 'bad', title: `Blocked by ${vendor}`,
            detail: `The ${where} is behind ${vendor} ${mode === 'captcha' ? 'with a CAPTCHA' : 'and refuses our servers outright'} (HTTP ${status}). Selector changes can't fix this. Pause the source — or switch it to media-only if its videos and reels still work.`,
            actions: ['pause', 'mediaOnly'],
        };
    }
    return {
        kind: 'http', severity: 'bad', title: `HTTP ${f.status}`,
        detail: f.status === 404 || f.status === 410
            ? `The ${where} no longer exists (HTTP ${f.status}). The section URL has probably moved — update the source URL.`
            : `The ${where} returned HTTP ${f.status}.`,
        actions: ['pause'],
    };
}

/**
 * Diagnose one source. Returns { verdict, listing, article, freshness, suggestion } —
 * `suggestion` holds only the fields that are broken AND have a verified replacement.
 */
async function diagnoseSource(source) {
    const report = { checkedAt: new Date().toISOString(), sourceType: source.type || 'website', listing: null, article: null, freshness: null, suggestion: {}, verdict: null };

    const listing = await fetchPage(source.url);
    report.listing = { fetch: publicFetch(listing) };

    if (source.type === 'rss') {
        if (!listing.ok || listing.block || listing.error) {
            report.verdict = blockedVerdict(listing, 'feed');
        } else {
            const items = (listing.body.match(/<(item|entry)[\s>]/gi) || []).length;
            report.listing.items = items;
            report.verdict = items
                ? { kind: 'healthy', severity: 'ok', title: 'Feed is reachable', detail: `The feed returned ${items} items. RSS sources don't use selectors — if stories still aren't saving, run the test for item-level errors.`, actions: [] }
                : { kind: 'http', severity: 'bad', title: 'Feed has no items', detail: 'The feed URL answered but contains no <item> or <entry> elements. The feed may have moved.', actions: ['pause'] };
        }
        return report;
    }

    if (!listing.ok || listing.block || listing.error) {
        report.verdict = blockedVerdict(listing, 'listing page');
        return report;
    }

    const $ = cheerio.load(listing.body);
    const stored = await Article.find({ sourceId: source._id }).sort({ _id: -1 }).limit(40).select('url').lean();
    const storedShapes = new Set(stored.map((a) => T.urlShape(a.url)).filter(Boolean));

    const apiCfg = getListApiConfig(source);
    let current;
    if (apiCfg) {
        let links = [];
        try { links = await fetchApiListingLinks($, source, apiCfg); } catch { /* reported as 0 links */ }
        current = { valid: true, error: null, matches: links.length, links, viaApi: true };
    } else {
        current = linksFor($, source, source.listSelector, source.linkSelector);
    }
    const candidates = apiCfg ? [] : listCandidates($, source, storedShapes);
    report.listing.current = {
        listSelector: source.listSelector || '',
        linkSelector: source.linkSelector || '',
        valid: current.valid,
        error: current.error,
        links: current.links.length,
        viaApi: Boolean(current.viaApi),
        sample: current.links.slice(0, 3),
    };
    report.listing.status = current.links.length ? 'ok' : current.valid ? 'missing' : 'invalid';
    report.listing.candidates = candidates.map(({ _links, ...c }) => c);
    report.listing.pastUrlPatterns = storedShapes.size;

    if (!current.links.length && !candidates.length) {
        report.verdict = T.looksJsRendered($, listing.body)
            ? {
                kind: 'js-rendered', severity: 'bad', title: 'Listing is built by JavaScript',
                detail: 'The HTML our scraper receives has no story links — the site renders them in the browser. Selectors can\'t fix this. It needs a JSON listing config (listApi) pointing at the site\'s data API; ask a developer.',
                actions: ['pause', 'mediaOnly'],
            }
            : {
                kind: 'selectors', severity: 'bad', title: 'No story links found',
                detail: 'Neither the current list selector nor anything on the page looks like a list of stories. Check that the source URL is a section or listing page.',
                actions: [],
            };
        return report;
    }

    const articleUrls = current.links.length ? current.links : candidates[0]._links;
    const art = await diagnoseArticles(source, articleUrls, apiCfg);
    if (art.blocked) {
        report.article = { fetches: art.fetches };
        report.verdict = blockedVerdict(art.blocked, 'article pages');
        return report;
    }
    report.article = { sampleUrl: art.sampleUrl, fetches: art.fetches, fields: art.fields };

    // Freshness — same rules as the test, judged on the links production would follow.
    const fresh = { warnings: [], steps: [], articles: [] };
    await assessFreshness(source, current.links.length ? current.links : [], art.publishDates, fresh);
    report.freshness = { ...fresh.freshness, warnings: fresh.warnings };

    // Suggest replacements only for fields that are broken and have a verified candidate.
    if (report.listing.status !== 'ok' && candidates[0]) {
        report.suggestion.listSelector = candidates[0].listSelector;
        report.suggestion.linkSelector = candidates[0].linkSelector;
    }
    const F = art.fields;
    if (F.title.status !== 'ok' && F.title.candidates[0]) report.suggestion.titleSelector = F.title.candidates[0].selector;
    if (F.content.status !== 'ok' && F.content.candidates[0]) report.suggestion.contentSelector = F.content.candidates[0].selector;
    if (F.image.status !== 'ok' && F.image.candidates[0]) report.suggestion.imageSelector = F.image.candidates[0].selector;

    const broken = [
        report.listing.status !== 'ok' && 'list',
        F.title.status !== 'ok' && 'title',
        F.content.status !== 'ok' && 'content',
        F.image.status !== 'ok' && 'image',
    ].filter(Boolean);
    const fixable = Object.keys(report.suggestion).length > 0;

    if (broken.length) {
        report.verdict = {
            kind: 'selectors', severity: broken.includes('list') || broken.includes('content') || broken.includes('title') ? 'bad' : 'warn',
            title: `Selectors need attention: ${broken.join(', ')}`,
            detail: fixable
                ? 'Suggested replacements below were checked against the live pages. Review them in the playground, preview, then apply.'
                : 'No reliable replacement was found automatically — try selectors by hand in the playground.',
            actions: fixable ? ['applySuggestion'] : [],
        };
    } else if (report.freshness && report.freshness.stale) {
        report.verdict = {
            kind: 'dormant', severity: 'warn', title: 'Site looks dormant',
            detail: `Selectors work, but: ${report.freshness.warnings.join(' ')}`,
            actions: ['pause'],
        };
    } else {
        report.verdict = { kind: 'healthy', severity: 'ok', title: 'Source looks healthy', detail: 'Links, titles, content and images all extract from the live pages.', actions: [] };
    }
    return report;
}

module.exports = { diagnoseSource };
