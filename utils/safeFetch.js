/**
 * GET a URL supplied by someone outside Gulfio (publisher applications: domain
 * verification, feed checks) without letting it reach our own network.
 *
 * The guard lives in the socket's DNS lookup, so it holds for every redirect hop
 * and can't be dodged by DNS rebinding between a "check" and the real request.
 * Only http/https on the default ports, small bodies, short timeouts.
 */
const axios = require('axios');
const dns = require('dns');
const http = require('http');
const https = require('https');
const net = require('net');

const blocked = new net.BlockList();
[
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
    ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
    ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
].forEach(([net4, prefix]) => blocked.addSubnet(net4, prefix, 'ipv4'));
[
    ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96], ['2001:db8::', 32],
].forEach(([net6, prefix]) => blocked.addSubnet(net6, prefix, 'ipv6'));

const isPublicAddress = (address, family) => {
    const fam = family === 6 || family === 'IPv6' ? 'ipv6' : 'ipv4';
    // ::ffff:10.0.0.1 is an IPv4 address wearing an IPv6 coat.
    const mapped = fam === 'ipv6' && /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) return !blocked.check(mapped[1], 'ipv4');
    return !blocked.check(address, fam);
};

const guardedLookup = (hostname, options, callback) => {
    dns.lookup(hostname, options, (err, address, family) => {
        if (err) return callback(err);
        const list = Array.isArray(address) ? address : [{ address, family }];
        const bad = list.find((a) => !isPublicAddress(a.address, a.family));
        if (bad) {
            const e = new Error(`${hostname} resolves to a private address`);
            e.code = 'EPRIVATE';
            return callback(e);
        }
        callback(null, address, family);
    });
};

const httpAgent = new http.Agent({ lookup: guardedLookup, keepAlive: false });
const httpsAgent = new https.Agent({ lookup: guardedLookup, keepAlive: false });

const UA = 'Mozilla/5.0 (compatible; GulfioPublisherCheck/1.0; +https://gulfio.app/publishers)';

const assertUrl = (raw) => {
    let url;
    try { url = new URL(raw); } catch { throw Object.assign(new Error('That is not a valid URL.'), { code: 'EBADURL' }); }
    if (!['http:', 'https:'].includes(url.protocol)) throw Object.assign(new Error('Only http and https links are supported.'), { code: 'EBADURL' });
    if (url.port && !['80', '443'].includes(url.port)) throw Object.assign(new Error('Only standard ports (80/443) are supported.'), { code: 'EBADURL' });
    if (url.username || url.password) throw Object.assign(new Error('Links must not contain credentials.'), { code: 'EBADURL' });
    if (net.isIP(url.hostname.replace(/^\[|\]$/g, ''))) throw Object.assign(new Error('Use a domain name, not an IP address.'), { code: 'EBADURL' });
    return url;
};

/**
 * @returns {Promise<{ status:number, url:string, headers:object, body:string }>}
 *   Non-2xx responses resolve (callers decide); network/guard failures reject.
 */
async function safeGet(rawUrl, { timeout = 8000, maxBytes = 2_000_000, accept } = {}) {
    const url = assertUrl(rawUrl);
    const res = await axios.get(url.toString(), {
        httpAgent,
        httpsAgent,
        proxy: false,
        timeout,
        maxRedirects: 4,
        maxContentLength: maxBytes,
        maxBodyLength: maxBytes,
        responseType: 'text',
        transformResponse: [(d) => d],
        validateStatus: () => true,
        decompress: true,
        headers: {
            'User-Agent': UA,
            Accept: accept || 'text/html,application/xhtml+xml,application/xml,application/rss+xml,application/atom+xml,application/json;q=0.9,*/*;q=0.8',
        },
        beforeRedirect: (options) => {
            if (!['http:', 'https:'].includes(options.protocol)) throw new Error('Redirected to an unsupported protocol.');
            if (options.port && !['80', '443', 80, 443].includes(options.port)) throw new Error('Redirected to a non-standard port.');
        },
    });
    const finalUrl = res.request?.res?.responseUrl || url.toString();
    return { status: res.status, url: finalUrl, headers: res.headers || {}, body: typeof res.data === 'string' ? res.data : String(res.data ?? '') };
}

/** A short, human reason for a fetch failure. */
const describeFetchError = (err) => {
    if (!err) return 'Unknown error.';
    if (err.code === 'EBADURL' || err.code === 'EPRIVATE') return err.message;
    if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') return 'The domain could not be found (DNS).';
    if (err.code === 'ECONNREFUSED') return 'The server refused the connection.';
    if (err.code === 'ECONNABORTED' || /timeout/i.test(err.message)) return 'The server took too long to respond.';
    if (/maxContentLength/i.test(err.message)) return 'The response was too large.';
    if (/certificate|SSL|TLS/i.test(err.message)) return 'The site’s HTTPS certificate could not be verified.';
    return err.message || 'The request failed.';
};

module.exports = { safeGet, describeFetchError, assertUrl, isPublicAddress };
