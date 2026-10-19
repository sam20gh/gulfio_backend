/**
 * Selector tooling shared by the source test (testSingleSource) and the Studio
 * "Diagnose & fix" doctor (sourceDoctor).
 *
 * Content extraction here mirrors scraper-job/scraper/scrape.js — keep
 * isMultiElementContentSelector in sync with it. The test used to join every matching <p>
 * regardless of selector shape while production took only the first match of a
 * "container" selector, so a source could pass the test and save nothing (The Peninsula,
 * Nov 2025 – Oct 2026).
 */
const { decodeEmailCloaks } = require('../utils/emailCloak');

// ─────────────────────────────── production extraction parity ───────────────────────────────

/** Same rule as scraper-job: comma lists or a block-tag/combinator tail collect every match. */
function isMultiElementContentSelector(selector) {
    if (selector.includes(',')) return true;
    let bare = selector;
    for (let prev = null; prev !== bare;) {
        prev = bare;
        bare = bare.replace(/\([^()]*\)/g, '');
    }
    bare = bare.replace(/\[[^\]]*\]/g, '').replace(/::?[\w-]+/g, '').trim();
    if (/[>+~*]$/.test(bare)) return true;
    return /\s+(p|li|div|span|h[1-6]|blockquote)$/i.test(bare);
}

/** Run a selector without letting a malformed one throw (cheerio throws on bad CSS). */
function safeSelect($, selector) {
    if (!selector || typeof selector !== 'string' || !selector.trim()) return { ok: false, error: 'No selector set', $els: null };
    try {
        return { ok: true, error: null, $els: $(selector) };
    } catch (err) {
        return { ok: false, error: `Invalid selector: ${err.message}`, $els: null };
    }
}

const STRIP = 'script, style, noscript, img, figure, iframe, .advertisement, .ad, .social-share, .comments';

function squash(text) {
    return (text || '')
        .replace(/[ \t\r\f\v ]+/g, ' ')
        .replace(/ *\n */g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * Article text as production extracts it: multi-element selectors collect every visible
 * match (dropping matches nested in another match); container selectors take the FIRST
 * match only. Lengths track what the scraper stores closely enough for health checks.
 */
function extractContentText($, selector, isVisible = () => true) {
    decodeEmailCloaks($);
    const sel = safeSelect($, selector);
    if (!sel.ok || sel.$els.length === 0) return '';
    if (isMultiElementContentSelector(selector)) {
        const els = sel.$els.toArray().filter((el) => isVisible($, el));
        const picked = new Set(els);
        const top = els.filter((el) => {
            for (let p = el.parent; p; p = p.parent) if (picked.has(p)) return false;
            return true;
        });
        return squash(top.map((el) => {
            const $c = $(el).clone();
            $c.find(STRIP).remove();
            return squash($c.text());
        }).filter(Boolean).join('\n\n'));
    }
    const $c = sel.$els.first().clone();
    $c.find(STRIP).remove();
    return squash($c.text());
}

/** Site-wide graphic, not a story photo (logo/default/placeholder file, or any SVG) — mirrors scraper-job. */
function isSiteChromeImage(url) {
    const file = String(url || '').split(/[?#]/)[0].split('/').pop() || '';
    return /(^|[-_.])(logo|default|placeholder)([-_.]|$)/i.test(file) || /\.svg$/i.test(file);
}

/** The Article node's own JSON-LD `image` (never publisher.logo) — mirrors scraper-job. */
function jsonLdImage($) {
    const found = [];
    const urlOf = (v) => (typeof v === 'string' ? v : v && typeof v === 'object' ? v.url || v.contentUrl || v['@id'] : null);
    $('script[type="application/ld+json"]').each((_, el) => {
        let data;
        try { data = JSON.parse($(el).contents().text()); } catch { return; }
        const stack = [data];
        while (stack.length) {
            const node = stack.pop();
            if (!node || typeof node !== 'object') continue;
            if (Array.isArray(node)) { stack.push(...node); continue; }
            if (node['@graph']) stack.push(node['@graph']);
            const type = [].concat(node['@type'] || []).join(' ');
            if (!/Article|BlogPosting|NewsArticle|Report/i.test(type)) continue;
            for (const v of [].concat(node.image || [], node.thumbnailUrl || [])) {
                const u = urlOf(v);
                if (u && /^https?:\/\//i.test(u) && !isSiteChromeImage(u)) found.push(u);
            }
        }
    });
    return found[0] || null;
}

/**
 * Production's image fallback when the selector finds nothing usable: JSON-LD article
 * image, then og:image, skipping site logos. Returns { url, via } or null.
 */
function fallbackImage($, { preferOgImage = false } = {}) {
    if (!preferOgImage) {
        const ld = jsonLdImage($);
        if (ld) return { url: ld, via: 'jsonld' };
    }
    const og = $('meta[property="og:image"]').attr('content') || $('meta[name="twitter:image"]').attr('content');
    if (og && !isSiteChromeImage(og)) return { url: og, via: 'og' };
    return null;
}

/** schema.org JSON-LD articleBody (longest found), as plain text — mirrors scraper-job. */
function jsonLdArticleBody($) {
    let best = '';
    $('script[type="application/ld+json"]').each((_, el) => {
        let data;
        try { data = JSON.parse($(el).contents().text()); } catch { return; }
        const stack = [data];
        while (stack.length) {
            const node = stack.pop();
            if (!node || typeof node !== 'object') continue;
            if (Array.isArray(node)) { stack.push(...node); continue; }
            if (typeof node.articleBody === 'string' && node.articleBody.length > best.length) best = node.articleBody;
            if (node['@graph']) stack.push(node['@graph']);
        }
    });
    return best.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n\n').trim();
}

/**
 * Production's content: the selector's text, unless it found only a stub/summary
 * (<1000 chars) and the page's JSON-LD articleBody is at least twice as long.
 */
function extractContentWithFallback($, selector, isVisible) {
    const text = extractContentText($, selector, isVisible);
    if (text.length < 1000) {
        const ld = jsonLdArticleBody($);
        if (ld.length >= 300 && ld.length >= text.length * 2) return { text: ld, viaJsonLd: true };
    }
    return { text, viaJsonLd: false };
}

// ─────────────────────────────── why a fetch failed ───────────────────────────────

const TLS_CODES = new Set([
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_GET_ISSUER_CERT',
    'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
    'ERR_TLS_CERT_ALTNAME_INVALID',
]);
const NETWORK_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EHOSTUNREACH', 'ERR_FR_TOO_MANY_REDIRECTS']);

// mode: "challenge" = a browser can often pass it (production retries 403s in headless
// Chrome); "captcha"/"block" = a human puzzle or an outright refusal — nothing to fix in config.
const BLOCK_SIGNATURES = [
    { vendor: 'Cloudflare', mode: 'challenge', test: (b, h) => h['cf-mitigated'] === 'challenge' || /<title>Just a moment\.\.\.<\/title>|cf_chl_opt/i.test(b) },
    { vendor: 'Cloudflare', mode: 'block', test: (b) => /Sorry, you have been blocked|Attention Required! \| Cloudflare/i.test(b) },
    { vendor: 'AWS WAF', mode: 'captcha', test: (b) => /awsWafCookieDomainList|AwsWafIntegration|gokuProps/i.test(b) },
    { vendor: 'F5 BIG-IP', mode: 'block', test: (b) => /The requested URL was rejected\. Please consult with your administrator/i.test(b) },
    { vendor: 'Akamai', mode: 'block', test: (b) => /<title>Access Denied<\/title>/i.test(b) && /Reference #/i.test(b) },
    { vendor: 'Imperva', mode: 'block', test: (b) => /Incapsula incident|_Incapsula_Resource/i.test(b) },
    { vendor: 'DataDome', mode: 'captcha', test: (b) => /captcha-delivery\.com/i.test(b) },
    { vendor: 'Sucuri', mode: 'block', test: (b) => /Sucuri WebSite Firewall/i.test(b) },
    { vendor: 'CloudFront', mode: 'block', test: (b) => /Generated by cloudfront \(CloudFront\)/i.test(b) && /Request blocked/i.test(b) },
];

/**
 * Bot-protection page? Only small or error responses are checked — a real 200 page can
 * mention a vendor in its scripts and still be perfectly scrapable. (F5 answers 200.)
 */
function detectBlock({ status, headers = {}, body = '' }) {
    if (typeof body !== 'string') return null;
    if (!(status >= 400 || body.length < 30000)) return null;
    for (const s of BLOCK_SIGNATURES) {
        if (s.test(body, headers)) return { vendor: s.vendor, mode: s.mode, status };
    }
    return null;
}

function classifyFetchError(err) {
    const code = err && (err.code || (err.cause && err.cause.code));
    if (code && TLS_CODES.has(code)) return { kind: 'tls', code };
    if (code && NETWORK_CODES.has(code)) return { kind: 'network', code };
    return { kind: 'network', code: code || null };
}

/** HTML that is just an app shell: the articles only exist after JavaScript runs. */
function looksJsRendered($, html) {
    const textLen = squash($('body').text()).length;
    const anchors = $('a[href]').length;
    const shell = /<app-root|<div id="(app|root|__next|__nuxt)"[^>]*>\s*<\/div>|__NUXT__|ng-version=/i.test(html);
    return anchors < 15 && (textLen < 600 || shell);
}

// ─────────────────────────────── building selectors ───────────────────────────────

// Layout / state utility classes say nothing about content and churn with redesigns.
const UTILITY_CLASS = /^(active|show|open|selected|current|first|last|odd|even|clearfix|row|container(-fluid)?|col(-[a-z]{2})?(-\d+)?|d-|w-\d|h-\d|[mp][trblxyse]?-\d|g-\d|gap-|text-(left|right|center|start|end)|float-|flex|justify-|align-|order-|aos|animate|lazy|loaded|swiper|slick|owl-|is-|has-|js-|wow|fade|uk-(width|grid|margin|padding|flex|text)|pointer|w-100|h-100|d-block)/i;

function cssEscape(ident) {
    return ident.replace(/([^a-zA-Z0-9_-])/g, '\\$1');
}

function goodClasses(el) {
    return String((el.attribs && el.attribs.class) || '')
        .split(/\s+/)
        .filter((c) => c && c.length <= 40 && /^[a-zA-Z_-]/.test(c) && /[a-zA-Z]/.test(c)
            && !/\d{4,}/.test(c) && !/^(css|sc|jsx|styled|emotion)-/.test(c) && !UTILITY_CLASS.test(c)
            // Build-hashed names (Times of India: "HNMDR" → "cMyCH" between builds) change on
            // every deploy of the site; hand-written classes are lowercase/kebab or longer.
            && !(/^[A-Za-z0-9]{4,7}$/.test(c) && /[A-Z]/.test(c)));
}

/**
 * One compound selector for an element: a readable #id, else tag + up to two stable
 * classes. Pass `$` to skip ids the page reuses (invalid HTML, but common in CMS templates).
 */
function simpleSelector(el, $) {
    const tag = el.tagName || el.name;
    const id = el.attribs && el.attribs.id;
    if (id && /^[A-Za-z][\w-]{1,40}$/.test(id) && !/\d{3,}/.test(id) && (!$ || $(`[id="${id}"]`).length === 1)) return `#${cssEscape(id)}`;
    const classes = goodClasses(el).slice(0, 2);
    return classes.length ? `${tag}${classes.map((c) => `.${cssEscape(c)}`).join('')}` : tag;
}

/**
 * Shortest selector for `el` that `accept` approves, scoping by up to `maxDepth`
 * meaningful ancestors (bare tag ancestors are skipped to keep selectors short).
 */
function selectorFor($, el, { accept, maxDepth = 5 }) {
    const own = simpleSelector(el, $);
    const check = (sel) => {
        try { return accept(sel); } catch { return false; }
    };
    if (own !== el.tagName && check(own)) return own;
    let cur = el.parent;
    for (let depth = 0; cur && cur.type === 'tag' && cur.tagName !== 'html' && cur.tagName !== 'body' && depth < maxDepth; depth++, cur = cur.parent) {
        const anc = simpleSelector(cur, $);
        if (anc === cur.tagName) continue;
        const sel = `${anc} ${own}`;
        if (check(sel)) return sel;
    }
    return null;
}

// ─────────────────────────────── recognising articles ───────────────────────────────

const NAV_SEGMENT = /^(category|categories|tag|tags|author|authors|section|sections|page|search|login|register|signin|signup|about|about-us|contact|contact-us|privacy|terms|subscribe|newsletter|videos?|photos?|gallery|live|topics?|news|latest|archive|feed|rss)$/i;

function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
}

/** Does this URL look like a single story rather than a section, tag or utility page? */
function articleLikeUrl(u, host) {
    let url;
    try { url = new URL(u); } catch { return false; }
    if (!/^https?:$/.test(url.protocol)) return false;
    if (host && url.hostname.replace(/^www\./, '').toLowerCase() !== host) return false;
    if (/\.(jpe?g|png|gif|webp|svg|pdf|mp4|mp3|zip)$/i.test(url.pathname)) return false;
    const segs = url.pathname.split('/').filter(Boolean);
    if (!segs.length) return false;
    let last = segs[segs.length - 1];
    try { last = decodeURIComponent(last); } catch { /* keep raw */ }
    if (segs.length === 1 && NAV_SEGMENT.test(last)) return false;
    if (segs.some((s) => /^(tag|tags|author|authors|category|search|login)$/i.test(s)) && !/\d{3,}/.test(url.pathname)) return false;
    const sluggy = (last.match(/-/g) || []).length >= 3 || last.length >= 30;
    const idish = segs.some((s) => /^\d{3,}$/.test(s)) || /\d{4,}/.test(last);
    const dated = /\/20\d\d\/\d{1,2}\//.test(url.pathname) || /\/\d{1,2}\/\d{1,2}\/20\d\d\//.test(url.pathname);
    const queryId = /[?&](id|cms|p|article|news|nid|aid)=/i.test(url.search);
    return sluggy || idish || dated || queryId;
}

/** Path shape with ids and slugs wildcarded: /article/15/10/2026/some-slug → article/#/#/#/*. */
function urlShape(u) {
    try {
        return new URL(u).pathname.split('/').filter(Boolean)
            .map((s) => (/^\d+$/.test(s) ? '#' : s.length > 20 || (s.match(/-/g) || []).length >= 2 ? '*' : s.toLowerCase()))
            .join('/');
    } catch {
        return '';
    }
}

function tokens(s) {
    return new Set(String(s || '').toLowerCase().normalize('NFKC').split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 1));
}

/** Share of the smaller title's words found in the other (h1 vs "Title | Site Name"). */
function titleOverlap(a, b) {
    const A = tokens(a);
    const B = tokens(b);
    if (!A.size || !B.size) return 0;
    let n = 0;
    for (const t of A) if (B.has(t)) n++;
    return n / Math.min(A.size, B.size);
}

module.exports = {
    isMultiElementContentSelector,
    safeSelect,
    squash,
    extractContentText,
    jsonLdArticleBody,
    isSiteChromeImage,
    jsonLdImage,
    fallbackImage,
    extractContentWithFallback,
    detectBlock,
    classifyFetchError,
    looksJsRendered,
    cssEscape,
    simpleSelector,
    selectorFor,
    hostOf,
    articleLikeUrl,
    urlShape,
    titleOverlap,
};
