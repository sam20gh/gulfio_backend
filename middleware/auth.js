const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;
const SUPABASE_ISSUER = process.env.SUPABASE_JWT_ISSUER;
const ADMIN_KEY = process.env.ADMIN_API_KEY;

module.exports = async (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey === ADMIN_KEY) return next();

    let token = null;

    if (req.headers['authorization']?.startsWith('Bearer ')) {
        token = req.headers['authorization'].split(' ')[1];
    } else if (req.headers['x-access-token']) {
        token = req.headers['x-access-token'];
    }

    if (!token) {
        return res.status(401).json({ message: 'Unauthorized: Missing token' });
    }


    try {
        const decoded = jwt.verify(token, JWT_SECRET, {
            algorithms: ['HS256'],
            issuer: SUPABASE_ISSUER,
        });

        req.user = decoded;
        next();
    } catch (err) {
        console.error('JWT verification failed:', err.message);
        return res.status(403).json({ message: 'Forbidden: Invalid Supabase token' });
    }
};
