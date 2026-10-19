/**
 * Joomla's "Email Cloaking" plugin hides addresses from scrapers: the page carries a
 * placeholder ("This email address is being protected from spambots…" / Arabic
 * "عنوان البريد الإلكتروني هذا محمي من روبوتات السبام…") plus an inline <script> that
 * writes the real address in. Taking .text() of the paragraph saved both the placeholder
 * and the script source into articles (Neda El Watan, 2026-10-19).
 *
 * decodeEmailCloaks() rebuilds the address from the script's string pieces — never by
 * running it — puts it in place of the placeholder, and removes the script.
 *
 * Mirror of scraper-job/utils/emailCloak.js (production scraper). Used here by the Studio
 * test scrape and Diagnose & fix so they show what production saves. Keep the two in sync.
 */
const EMAIL_RX = /^[^\s@<>"']+@[^\s@<>"']+\.[a-z]{2,}$/i;

/** Decode &#109; / &#x6d; / &amp; style entities without a DOM. */
const decodeEntities = (s) =>
    s
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'");

/** The statement starting at `from`, up to the first `;` outside a quoted string. */
function statementAt(js, from) {
    let quote = null;
    for (let i = from; i < js.length; i++) {
        const c = js[i];
        if (quote) {
            if (c === '\\') i++;
            else if (c === quote) quote = null;
        } else if (c === "'" || c === '"') quote = c;
        else if (c === ';') return js.slice(from, i);
    }
    return js.slice(from);
}

/**
 * Value of `var <name> = '…' + '…';`, following later `<name> = <name> + '…'` and
 * `<name> += '…'` statements. Only string literals count; anything else is ignored.
 */
function concatLiterals(js, name) {
    let value = '';
    const rx = new RegExp(`(?:var\\s+)?\\b${name}\\s*(\\+?=)(?!=)`, 'g');
    let m;
    while ((m = rx.exec(js))) {
        const expr = statementAt(js, m.index + m[0].length);
        const selfRef = new RegExp(`^\\s*${name}\\s*\\+`).test(expr);
        const pieces = (expr.match(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g) || [])
            .map((q) => q.slice(1, -1).replace(/\\(.)/g, '$1'))
            .join('');
        value = m[1] === '+=' || selfRef ? value + pieces : pieces;
    }
    return value;
}

/** @param $ a cheerio root for the whole page. Mutates it; returns how many it decoded. */
function decodeEmailCloaks($) {
    let decoded = 0;

    // Joomla 3: <span id="cloakHEX">placeholder</span><script>…addy_textHEX = '…';</script>
    $('script').each((_, el) => {
        const js = $(el).html() || '';
        const m = js.match(/getElementById\(\s*['"](cloak([0-9a-f]+))['"]\s*\)/i);
        if (!m) return;
        const [, id, hex] = m;
        const text = decodeEntities(concatLiterals(js, `addy_text${hex}`));
        const addy = decodeEntities(concatLiterals(js, `addy${hex}`));
        const email = EMAIL_RX.test(text) ? text : EMAIL_RX.test(addy) ? addy : '';
        $(`[id="${id}"]`).text(email);
        $(el).remove();
        if (email) decoded++;
    });

    // Joomla 4/5: <joomla-hidden-mail first="base64" last="base64" text="base64">placeholder</joomla-hidden-mail>
    $('joomla-hidden-mail').each((_, el) => {
        const $el = $(el);
        const b64 = (v) => { try { return v ? Buffer.from(v, 'base64').toString('utf8') : ''; } catch { return ''; } };
        const isLink = $el.attr('is-link') === '1';
        const shown = b64($el.attr('text'));
        const email = `${b64($el.attr('first'))}@${b64($el.attr('last'))}`;
        const out = isLink && shown ? shown : email;
        $el.replaceWith(EMAIL_RX.test(email) ? out : '');
        if (EMAIL_RX.test(email)) decoded++;
    });

    return decoded;
}

module.exports = { decodeEmailCloaks };
