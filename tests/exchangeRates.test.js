/**
 * FX provider-chain tests (pure logic — no Mongo, no real network).
 * Run: node tests/exchangeRates.test.js
 *
 * Covers the part that actually decides whether the currency feature works:
 * which provider is trusted, what counts as an unusable payload, and what we
 * fall back to when the free endpoints are down or rate limiting us.
 */

const axios = require('axios');
const { fetchLiveRates, PEG_FALLBACK, todayKey } = require('../services/exchangeRates');

let passed = 0;
let failed = 0;
function assert(cond, msg) {
    if (cond) {
        passed++;
        console.log(`  ✓ ${msg}`);
    } else {
        failed++;
        console.error(`  ✗ ${msg}`);
    }
}

/** A realistic 60-currency payload — above the MIN_CURRENCIES floor. */
function wideRates(overrides = {}) {
    const rates = { AED: 3.6725, SAR: 3.75, INR: 95.4, PKR: 277.73, EGP: 50.26 };
    for (let i = 0; i < 60; i++) rates[`C${i}`] = 1 + i / 100;
    return { ...rates, ...overrides };
}

const realGet = axios.get;
/** Queue one handler per expected call, in order. */
function stubAxios(handlers) {
    let call = 0;
    axios.get = async (url) => {
        const handler = handlers[Math.min(call, handlers.length - 1)];
        call++;
        return handler(url);
    };
    return () => call;
}
function restoreAxios() {
    axios.get = realGet;
}

// Silence the service's expected warn/error chatter during failure-path tests.
const realWarn = console.warn;
const realError = console.error;
function muteLogs() {
    console.warn = () => {};
    console.error = () => {};
}
function unmuteLogs() {
    console.warn = realWarn;
    console.error = realError;
}

(async () => {
    console.log('todayKey');
    {
        assert(/^\d{4}-\d{2}-\d{2}$/.test(todayKey()), 'returns a YYYY-MM-DD key');
        assert(
            todayKey(new Date('2026-08-04T23:59:00Z')) === '2026-08-04',
            'keys off UTC, not local time'
        );
    }

    console.log('\nprimary provider');
    {
        stubAxios([
            async () => ({
                data: {
                    result: 'success',
                    time_last_update_unix: 1785801751,
                    rates: wideRates(),
                },
            }),
        ]);
        const r = await fetchLiveRates();
        restoreAxios();

        assert(r.source === 'open.er-api.com', 'uses the primary provider when it answers');
        assert(r.rates.AED === 3.6725, 'passes rates through unchanged');
        assert(r.rates.USD === 1, 'adds an explicit USD=1 base entry');
        assert(
            r.providerUpdatedAt.getTime() === 1785801751 * 1000,
            'converts the provider timestamp from unix seconds'
        );
    }

    console.log('\nunusable primary payloads fall through to the fallback');
    {
        const cases = [
            ['non-success result', { result: 'error', rates: wideRates() }],
            ['too few currencies', { result: 'success', rates: { AED: 3.6725, SAR: 3.75 } }],
            [
                'missing a Gulf currency',
                { result: 'success', rates: wideRates({ AED: undefined }) },
            ],
            [
                'missing a remittance currency',
                { result: 'success', rates: wideRates({ INR: undefined }) },
            ],
        ];

        for (const [label, data] of cases) {
            muteLogs();
            stubAxios([
                async () => ({ data }),
                async () => ({ data: { date: '2026-08-04', usd: { aed: 3.6725, sar: 3.75, inr: 95.4, ...Object.fromEntries(Object.entries(wideRates()).map(([k, v]) => [k.toLowerCase(), v])) } } }),
            ]);
            const r = await fetchLiveRates();
            restoreAxios();
            unmuteLogs();
            assert(r.source === 'jsdelivr/currency-api', `rejects primary: ${label}`);
        }
    }

    console.log('\nfallback provider');
    {
        muteLogs();
        stubAxios([
            async () => {
                throw new Error('429 rate limited');
            },
            async () => ({
                data: {
                    date: '2026-08-04',
                    usd: Object.fromEntries(
                        Object.entries(wideRates()).map(([k, v]) => [k.toLowerCase(), v])
                    ),
                },
            }),
        ]);
        const r = await fetchLiveRates();
        restoreAxios();
        unmuteLogs();

        assert(r.source === 'jsdelivr/currency-api', 'falls back when the primary throws');
        assert(r.rates.AED === 3.6725, 'upper-cases the fallback provider lowercase codes');
        assert(r.rates.USD === 1, 'fallback also carries an explicit USD base');
        assert(
            r.providerUpdatedAt.toISOString().startsWith('2026-08-04'),
            'parses the fallback date field'
        );
    }

    console.log('\nboth providers down');
    {
        muteLogs();
        stubAxios([
            async () => {
                throw new Error('primary down');
            },
            async () => {
                throw new Error('fallback down');
            },
        ]);
        const r = await fetchLiveRates();
        restoreAxios();
        unmuteLogs();

        assert(r.source === 'peg-fallback', 'degrades to hard pegs rather than throwing');
        assert(r.rates.AED === PEG_FALLBACK.AED, 'peg values are the official USD pegs');
        assert(r.rates.INR === undefined, 'does not invent rates for floating currencies');
    }

    console.log('\nsanitisation');
    {
        stubAxios([
            async () => ({
                data: {
                    result: 'success',
                    rates: wideRates({ BAD: 'x', ZERO: 0, NEG: -1, NAN: NaN, NUL: null }),
                },
            }),
        ]);
        const r = await fetchLiveRates();
        restoreAxios();

        for (const bad of ['BAD', 'ZERO', 'NEG', 'NAN', 'NUL']) {
            assert(r.rates[bad] === undefined, `drops a non-positive/non-numeric rate: ${bad}`);
        }
        assert(r.rates.SAR === 3.75, 'keeps the good rates alongside');
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
})();
