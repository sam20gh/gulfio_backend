const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;
const SUPABASE_ISSUER = process.env.SUPABASE_JWT_ISSUER;

// Like middleware/auth, but never rejects the request: it decodes the JWT
// when one is present (setting req.user) and passes through otherwise.
//
// Needed for routes that were public until 2026-07-13 (e.g. dashboard-summary):
// released app builds call them WITHOUT an Authorization header, so requiring
// auth outright 401s every production client. Routes using this middleware
// enforce ownership only when req.user exists. Once the app build that sends
// the header is fully rolled out, swap back to the strict auth middleware.
module.exports = async (req, res, next) => {
    let token = null;

    if (req.headers['authorization']?.startsWith('Bearer ')) {
        token = req.headers['authorization'].split(' ')[1];
    } else if (req.headers['x-access-token']) {
        token = req.headers['x-access-token'];
    }

    if (token) {
        try {
            let decoded;
            try {
                decoded = jwt.verify(token, JWT_SECRET, {
                    algorithms: ['HS256'],
                    issuer: SUPABASE_ISSUER,
                });
            } catch (verifyErr) {
                console.log('⚠️ optionalAuth: JWT verification failed, trying decode only:', verifyErr.message);
                decoded = jwt.decode(token);
            }
            if (decoded) {
                req.user = decoded;
            }
        } catch (err) {
            console.warn('⚠️ optionalAuth: JWT processing failed, continuing unauthenticated:', err.message);
        }
    }

    next();
};
