/**
 * Studio (admin + publisher panel) authentication and scoping.
 *
 * Unlike middleware/auth.js this NEVER falls back to an unverified jwt.decode:
 * a forged token with an admin's `sub` would otherwise be accepted. Tokens are
 * verified locally with the HS256 project secret, and if that fails (e.g. the
 * project moved to asymmetric signing keys) Supabase itself is asked via
 * auth.getUser — authoritative, and cached briefly so it is not a round trip
 * per request.
 *
 * Roles live on the Mongo user (`type` + `publisher_group`), not in Supabase
 * claims. A publisher's reach is every Source whose `groupName` is in their
 * `publisher_group`.
 *
 * The ADMIN_API_KEY header is still accepted as an admin service actor so
 * cron jobs and scripts keep working. It must never be shipped to a browser.
 */
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const NodeCache = require('node-cache');
const mongoose = require('mongoose');
const User = require('../models/User');
const Source = require('../models/Source');

const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;
const SUPABASE_ISSUER = process.env.SUPABASE_JWT_ISSUER;

const tokenCache = new NodeCache({ stdTTL: 300, checkperiod: 120 });
const scopeCache = new NodeCache({ stdTTL: 60, checkperiod: 60 });

let supabaseAdmin = null;
const getSupabaseAdmin = () => {
    if (!supabaseAdmin && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
        const { createClient } = require('@supabase/supabase-js');
        supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
            auth: { persistSession: false, autoRefreshToken: false },
        });
    }
    return supabaseAdmin;
};

const readToken = (req) => {
    const header = req.headers['authorization'];
    if (header?.startsWith('Bearer ')) return header.slice(7);
    return req.headers['x-access-token'] || null;
};

/** Resolve a bearer token to a verified Supabase user id, or null. */
async function verifySupabaseToken(token) {
    if (!token) return null;

    if (JWT_SECRET) {
        try {
            const options = { algorithms: ['HS256'] };
            if (SUPABASE_ISSUER) options.issuer = SUPABASE_ISSUER;
            const decoded = jwt.verify(token, JWT_SECRET, options);
            return decoded?.sub ? { id: decoded.sub, email: decoded.email } : null;
        } catch (err) {
            // Expired is final; anything else (alg mismatch on asymmetric keys) falls through.
            if (err.name === 'TokenExpiredError') return null;
        }
    }

    const key = crypto.createHash('sha256').update(token).digest('hex');
    const cached = tokenCache.get(key);
    if (cached !== undefined) return cached;

    const client = getSupabaseAdmin();
    if (!client) return null;
    const { data, error } = await client.auth.getUser(token);
    const identity = !error && data?.user ? { id: data.user.id, email: data.user.email } : null;

    // Never cache past the token's own expiry.
    const exp = jwt.decode(token)?.exp;
    const ttl = exp ? Math.max(1, Math.min(300, exp - Math.floor(Date.now() / 1000))) : 60;
    tokenCache.set(key, identity, ttl);
    return identity;
}

/** Source ids a publisher may act on. Cached per group set for a minute. */
async function sourceIdsForGroups(groups) {
    const key = `groups:${[...groups].sort().join('|')}`;
    const cached = scopeCache.get(key);
    if (cached) return cached;
    const sources = await Source.find({ groupName: { $in: groups } }).select('_id').lean();
    const ids = sources.map((s) => s._id);
    scopeCache.set(key, ids);
    return ids;
}

const invalidateScopeCache = () => scopeCache.flushAll();

/**
 * Gate a route to studio roles and attach `req.studio`:
 *   { user, role, isAdmin, groups, sourceIds (null = unrestricted), service }
 */
const requireStudio = (...roles) => {
    const allowed = roles.length ? roles : ['admin', 'publisher'];

    return async (req, res, next) => {
        try {
            const token = readToken(req);
            const hasAdminKey = Boolean(process.env.ADMIN_API_KEY) &&
                req.headers['x-api-key'] === process.env.ADMIN_API_KEY;

            if (!token && hasAdminKey) {
                req.studio = { user: null, role: 'admin', isAdmin: true, groups: [], sourceIds: null, service: true };
                return next();
            }

            const identity = await verifySupabaseToken(token);
            if (!identity) {
                return res.status(401).json({ message: 'Your session has expired. Sign in again.' });
            }

            const user = await User.findOne({ supabase_id: identity.id })
                .select('email name type publisher_group profile_image avatar_url supabase_id createdAt')
                .lean();
            const role = user?.type || 'user';

            if (!user || !allowed.includes(role)) {
                return res.status(403).json({ message: 'This account does not have access to Gulfio Studio.' });
            }

            const groups = role === 'publisher' ? (user.publisher_group || []) : [];
            const sourceIds = role === 'admin' ? null : await sourceIdsForGroups(groups);

            req.studio = { user, role, isAdmin: role === 'admin', groups, sourceIds, service: false };
            // Keep older handlers that read req.mongoUser / req.user working.
            req.mongoUser = user;
            req.user = req.user || { sub: identity.id, email: identity.email };
            next();
        } catch (err) {
            console.error('studioAuth error:', err.message);
            res.status(500).json({ message: 'Could not verify your access.' });
        }
    };
};

const requireAdmin = requireStudio('admin');

/** Mongo filter fragment restricting a source-keyed field to the caller's scope. */
const scopeFilter = (studio, field = 'sourceId') =>
    studio.sourceIds === null ? {} : { [field]: { $in: studio.sourceIds } };

const canAccessSource = (studio, sourceId) => {
    if (studio.sourceIds === null) return true;
    if (!sourceId || !mongoose.Types.ObjectId.isValid(String(sourceId))) return false;
    return studio.sourceIds.some((id) => String(id) === String(sourceId));
};

const canAccessGroup = (studio, groupName) =>
    studio.isAdmin || (Boolean(groupName) && studio.groups.includes(groupName));

/** Express-friendly guard: 403 unless the caller can act on `sourceId`. */
const assertSource = (req, res, sourceId) => {
    if (canAccessSource(req.studio, sourceId)) return true;
    res.status(403).json({ message: 'That source belongs to another publisher.' });
    return false;
};

module.exports = {
    requireStudio,
    requireAdmin,
    verifySupabaseToken,
    scopeFilter,
    canAccessSource,
    canAccessGroup,
    assertSource,
    invalidateScopeCache,
};
