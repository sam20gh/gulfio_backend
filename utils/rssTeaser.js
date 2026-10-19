/**
 * Spot RSS items that carry only a teaser of the story ("…continue reading on X")
 * rather than the story itself, so the scraper knows to read the article page.
 *
 * Mirror of scraper-job/utils/rssTeaser.js (the production RSS scraper). Used here by
 * the Studio test scrape and the Publisher Portal feed check. Keep the two in sync.
 */

// Matched against the last ~160 characters only: these phrases close a teaser, they
// don't appear at the end of a finished story.
const READ_MORE = [
    /read more/i,
    /continue reading/i,
    /read the full (story|article)/i,
    /(the post\b.{0,140}?)?appeared first on/i, // WordPress: "The post X appeared first on Y."
    /أكمل\s+(ال)?قراءة/, // Arabic: "continue reading"
    /اقرأ\s+المزيد/, // Arabic: "read more"
    /(تابع|واصل)\s+(ال)?قراءة/, // Arabic: "keep reading"
    /ادامه\s+(مطلب|مطالب|خبر)/, // Farsi: "rest of the story"
    /بیشتر\s+بخوانید/, // Farsi: "read more"
    /مزید\s+پڑھیں/, // Urdu: "read more"
];

const ELLIPSIS_END = /(\.{3}|…|\[\s*(…|\.{3})\s*\])\s*$/;

// A finished story can end on a quoted "…", so a bare ellipsis only counts on short text.
const ELLIPSIS_MAX_LENGTH = 1500;

function looksTruncated(text) {
    const t = String(text || '').trim();
    if (!t) return false;
    const tail = t.slice(-160);
    if (READ_MORE.some((rx) => rx.test(tail))) return true;
    return ELLIPSIS_END.test(t) && t.length < ELLIPSIS_MAX_LENGTH;
}

/** Drop a trailing "read more" line, leaving "…" to show the text stops early. */
function stripReadMore(text) {
    const t = String(text || '').trim();
    const tailStart = Math.max(0, t.length - 160);
    let cut = -1;
    for (const rx of READ_MORE) {
        const m = rx.exec(t.slice(tailStart));
        if (m && (cut === -1 || tailStart + m.index < cut)) cut = tailStart + m.index;
    }
    if (cut === -1) return t;
    const head = t.slice(0, cut).replace(/[\s.…|:·•–—-]+$/u, '').trim();
    return head ? `${head}…` : t;
}

module.exports = { looksTruncated, stripReadMore };
