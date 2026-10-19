/**
 * Checks behind the Publisher Portal: proving a publication controls its domain,
 * and looking at the feeds it submits before a person reviews them.
 *
 * Every outbound request goes through utils/safeFetch (applicant-supplied URLs).
 */
const crypto = require('crypto');
const dns = require('dns').promises;
const cheerio = require('cheerio');
const { safeGet, describeFetchError } = require('./safeFetch');
const { looksTruncated } = require('./rssTeaser');

const TOKEN_PREFIX = 'gulfio-site-verification';
const META_NAME = 'gulfio-site-verification';
const FILE_PATH = '/.well-known/gulfio-verification.txt';

const newVerificationToken = () => crypto.randomBytes(16).toString('hex');

/** "https://www.Example.ae/news" → "example.ae". Null when it isn't a usable public host. */
const normaliseHost = (raw) => {
    if (!raw) return null;
    let s = String(raw).trim();
    if (!/^[a-z]+:\/\//i.test(s)) s = `https://${s}`;
    try {
        const host = new URL(s).hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
        if (!host.includes('.') || host.length > 253 || !/^[a-z0-9.-]+$/.test(host)) return null;
        return host;
    } catch {
        return null;
    }
};

/** True when `url` is on `host` or one of its subdomains. */
const isOnDomain = (url, host) => {
    const h = normaliseHost(url);
    return Boolean(h && host && (h === host || h.endsWith(`.${host}`)));
};

const instructionsFor = (host, token) => ({
    dns: { type: 'TXT', name: host, alt: `_gulfio.${host}`, value: `${TOKEN_PREFIX}=${token}` },
    meta: { tag: `<meta name="${META_NAME}" content="${token}" />`, url: `https://${host}/` },
    file: { url: `https://${host}${FILE_PATH}`, contents: `${TOKEN_PREFIX}=${token}` },
});

async function checkDns(host, token) {
    const expected = `${TOKEN_PREFIX}=${token}`;
    const names = [host, `_gulfio.${host}`];
    const found = [];
    for (const name of names) {
        try {
            const records = await dns.resolveTxt(name);
            const flat = records.map((chunks) => chunks.join(''));
            if (flat.some((r) => r.trim() === expected)) return { ok: true, detail: `TXT record found on ${name}.` };
            found.push(...flat.filter((r) => r.startsWith(TOKEN_PREFIX)));
        } catch {
            // NXDOMAIN / no TXT on this name — try the next one.
        }
    }
    return {
        ok: false,
        detail: found.length
            ? 'A Gulfio TXT record exists but its token doesn’t match this application.'
            : 'No matching TXT record yet. DNS changes can take up to an hour to appear.',
    };
}

async function checkMeta(host, token) {
    const tried = [];
    for (const url of [`https://${host}/`, `https://www.${host}/`]) {
        try {
            const res = await safeGet(url, { timeout: 8000, maxBytes: 3_000_000, accept: 'text/html' });
            tried.push(`${url} → ${res.status}`);
            if (res.status >= 400) continue;
            const $ = cheerio.load(res.body);
            const values = $(`meta[name="${META_NAME}"]`).map((_, el) => ($(el).attr('content') || '').trim()).get();
            if (values.includes(token)) return { ok: true, detail: `Meta tag found on ${url}.` };
            if (values.length) return { ok: false, detail: `The meta tag on ${url} has a different token.` };
        } catch (err) {
            tried.push(`${url} → ${describeFetchError(err)}`);
        }
    }
    return { ok: false, detail: `No matching meta tag on the home page. (${tried.join('; ')})` };
}

async function checkFile(host, token) {
    const expected = `${TOKEN_PREFIX}=${token}`;
    const tried = [];
    for (const url of [`https://${host}${FILE_PATH}`, `https://www.${host}${FILE_PATH}`]) {
        try {
            const res = await safeGet(url, { timeout: 8000, maxBytes: 20_000, accept: 'text/plain' });
            tried.push(`${url} → ${res.status}`);
            if (res.status >= 400) continue;
            if (res.body.includes(expected) || res.body.trim() === token) return { ok: true, detail: `Verification file found at ${url}.` };
        } catch (err) {
            tried.push(`${url} → ${describeFetchError(err)}`);
        }
    }
    return { ok: false, detail: `No matching verification file. (${tried.join('; ')})` };
}

/** Runs all three methods; any one passing verifies the domain. */
async function verifyDomain(host, token) {
    const [dnsResult, meta, file] = await Promise.all([
        checkDns(host, token).catch((e) => ({ ok: false, detail: e.message })),
        checkMeta(host, token).catch((e) => ({ ok: false, detail: e.message })),
        checkFile(host, token).catch((e) => ({ ok: false, detail: e.message })),
    ]);
    const method = dnsResult.ok ? 'dns' : meta.ok ? 'meta' : file.ok ? 'file' : null;
    return { verified: Boolean(method), method, checks: { dns: dnsResult, meta, file }, checkedAt: new Date() };
}

// ----------------------------------------------------------------------------
// feeds
// ----------------------------------------------------------------------------

const text = ($el) => ($el.first().text() || '').replace(/\s+/g, ' ').trim();
/** An item's body field (escaped or CDATA HTML) as plain text, plus whether it carries an <img>. */
const bodyOf = ($el) => {
    const html = $el.first().text() || '';
    const $b = cheerio.load(html);
    return { text: $b.text().replace(/\s+/g, ' ').trim(), hasImg: $b('img[src]').length > 0 };
};
const toDate = (s) => {
    if (!s) return null;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
};

function parseFeed(body) {
    const $ = cheerio.load(body, { xmlMode: true });
    const rss = $('rss channel item, rdf\\:RDF item, RDF item');
    const atom = $('feed > entry');
    let items = [];
    let format = null;

    if (rss.length) {
        format = 'rss';
        items = rss.map((_, el) => {
            const $i = $(el);
            return {
                title: text($i.find('title')),
                url: text($i.find('link')) || $i.find('guid').first().text().trim(),
                publishedAt: toDate(text($i.find('pubDate')) || text($i.find('dc\\:date'))),
                ...(() => {
                    const full = bodyOf($i.find('content\\:encoded'));
                    const desc = bodyOf($i.find('description'));
                    const main = full.text ? full : desc;
                    return {
                        hasImage: $i.find('enclosure[type^="image"], media\\:content, media\\:thumbnail').length > 0 || full.hasImg || desc.hasImg,
                        hasFullText: main.text.length > 600 && !looksTruncated(main.text),
                        isTeaser: looksTruncated(main.text),
                    };
                })(),
            };
        }).get();
    } else if (atom.length) {
        format = 'atom';
        items = atom.map((_, el) => {
            const $i = $(el);
            const link = $i.find('link[rel="alternate"]').attr('href') || $i.find('link').attr('href') || '';
            return {
                title: text($i.find('title')),
                url: link,
                publishedAt: toDate(text($i.find('published')) || text($i.find('updated'))),
                ...(() => {
                    const content = bodyOf($i.find('content'));
                    const main = content.text ? content : bodyOf($i.find('summary'));
                    return {
                        hasImage: $i.find('media\\:content, media\\:thumbnail').length > 0 || main.hasImg,
                        hasFullText: main.text.length > 600 && !looksTruncated(main.text),
                        isTeaser: looksTruncated(main.text),
                    };
                })(),
            };
        }).get();
    } else {
        const urls = $('urlset > url');
        if (urls.length) {
            format = 'sitemap';
            items = urls.map((_, el) => {
                const $u = $(el);
                return {
                    title: text($u.find('news\\:title')),
                    url: text($u.find('loc')),
                    publishedAt: toDate(text($u.find('news\\:publication_date')) || text($u.find('lastmod'))),
                    hasImage: $u.find('image\\:image').length > 0,
                    hasFullText: false,
                };
            }).get();
        } else if ($('sitemapindex > sitemap').length) {
            format = 'sitemap-index';
            items = $('sitemapindex > sitemap').map((_, el) => ({
                title: '', url: text($(el).find('loc')), publishedAt: toDate(text($(el).find('lastmod'))), hasImage: false, hasFullText: false,
            })).get();
        }
    }
    return { format, items };
}

const summarise = (items) => {
    const dated = items.map((i) => i.publishedAt).filter(Boolean).sort((a, b) => b - a);
    return {
        items: items.length,
        newestAt: dated[0] || null,
        withImages: items.filter((i) => i.hasImage).length,
        withFullText: items.filter((i) => i.hasFullText).length,
        teasers: items.filter((i) => i.isTeaser).length,
        sample: items.slice(0, 5).map((i) => ({ title: i.title.slice(0, 200), url: i.url.slice(0, 500), publishedAt: i.publishedAt })),
    };
};

/**
 * Look at one submitted feed. Never throws: the result is stored on the application
 * so the applicant and the reviewer see the same thing.
 */
async function probeFeed({ kind, url }, verifiedHost) {
    const base = { ok: false, checkedAt: new Date(), onDomain: isOnDomain(url, verifiedHost), warnings: [] };

    if (kind === 'youtube') {
        const ok = /^UC[\w-]{22}$/.test(String(url || '').trim());
        return { ...base, onDomain: null, ok, format: 'youtube', error: ok ? null : 'Enter the channel ID — it starts with “UC” and is 24 characters long.' };
    }
    if (kind === 'instagram') {
        const ok = /^[a-z0-9._]{1,30}$/i.test(String(url || '').replace(/^@/, '').trim());
        return { ...base, onDomain: null, ok, format: 'instagram', error: ok ? null : 'Enter the Instagram username without the @.' };
    }

    let res;
    try {
        res = await safeGet(url, { timeout: 10000, maxBytes: kind === 'website' ? 3_000_000 : 6_000_000 });
    } catch (err) {
        return { ...base, error: describeFetchError(err) };
    }
    const result = { ...base, status: res.status, finalUrl: res.url };
    if (res.status >= 400) return { ...result, error: `The server answered ${res.status}.` };
    if (!base.onDomain && verifiedHost) result.warnings.push(`This link isn’t on ${verifiedHost}. We may ask you to confirm you control it.`);

    if (kind === 'api') {
        try {
            const json = JSON.parse(res.body);
            const list = Array.isArray(json) ? json : Object.values(json || {}).find(Array.isArray);
            return {
                ...result,
                ok: true,
                format: 'json',
                items: Array.isArray(list) ? list.length : 0,
                keys: Array.isArray(json) ? Object.keys(json[0] || {}).slice(0, 12) : Object.keys(json || {}).slice(0, 12),
                warnings: Array.isArray(list) ? result.warnings : [...result.warnings, 'The response has no list of items at the top level.'],
            };
        } catch {
            const feed = parseFeed(res.body);
            if (feed.format) return { ...result, ok: feed.items.length > 0, format: feed.format, ...summarise(feed.items) };
            return { ...result, error: 'The endpoint didn’t return JSON or XML. If it needs a key, leave the endpoint and docs link and we’ll arrange access with you.' };
        }
    }

    if (kind === 'website') {
        const $ = cheerio.load(res.body);
        const feeds = $('link[rel="alternate"][type="application/rss+xml"], link[rel="alternate"][type="application/atom+xml"]')
            .map((_, el) => { try { return new URL($(el).attr('href'), res.url).toString(); } catch { return null; } }).get().filter(Boolean);
        return {
            ...result,
            ok: true,
            format: 'html',
            title: ($('meta[property="og:site_name"]').attr('content') || $('title').text() || '').trim().slice(0, 200),
            discoveredFeeds: [...new Set(feeds)].slice(0, 10),
            warnings: feeds.length ? result.warnings : [...result.warnings, 'No RSS feed is advertised on this page. Website-only sources take longer to set up.'],
        };
    }

    // rss / atom / sitemap
    const feed = parseFeed(res.body);
    if (!feed.format) return { ...result, error: 'This doesn’t look like an RSS, Atom or sitemap feed.' };
    const summary = summarise(feed.items);
    const warnings = [...result.warnings];
    if (!summary.items) warnings.push('The feed is empty.');
    if (summary.newestAt && Date.now() - summary.newestAt.getTime() > 14 * 24 * 3600 * 1000) warnings.push('The newest item is more than two weeks old.');
    if (summary.items && !summary.newestAt) warnings.push('Items have no publish dates.');
    if (summary.items && summary.teasers >= Math.ceil(summary.items / 2)) {
        warnings.push('Items are summaries that end in “read more”, not full stories. We’ll read each story from your website instead, which takes a little extra setup. A full-text feed (content:encoded) goes live faster.');
    }
    if (feed.format === 'sitemap-index') warnings.push('This is a sitemap index. Submit the news sitemap it links to instead.');
    return { ...result, ok: summary.items > 0 && feed.format !== 'sitemap-index', format: feed.format, ...summary, warnings };
}

const COMMON_FEED_PATHS = ['/feed', '/rss', '/rss.xml', '/feed.xml', '/news-sitemap.xml', '/sitemap-news.xml'];

/** Feeds a site advertises on its home page, plus common paths that answer as feeds. */
async function discoverFeeds(host) {
    const found = new Map();
    const home = await probeFeed({ kind: 'website', url: `https://${host}/` }, host);
    for (const url of home.discoveredFeeds || []) found.set(url, { url, kind: 'rss', via: 'home page' });

    const probes = await Promise.all(COMMON_FEED_PATHS.map(async (p) => {
        const url = `https://${host}${p}`;
        if ([...found.keys()].some((u) => u.replace(/\/$/, '') === url)) return null;
        const r = await probeFeed({ kind: 'rss', url }, host);
        return r.ok ? { url, kind: r.format === 'sitemap' ? 'sitemap' : 'rss', via: 'common path', items: r.items } : null;
    }));
    probes.filter(Boolean).forEach((p) => found.set(p.url, p));
    return { reachable: home.ok, error: home.error || null, feeds: [...found.values()].slice(0, 12) };
}

module.exports = {
    TOKEN_PREFIX,
    META_NAME,
    FILE_PATH,
    newVerificationToken,
    normaliseHost,
    isOnDomain,
    instructionsFor,
    verifyDomain,
    probeFeed,
    discoverFeeds,
};
