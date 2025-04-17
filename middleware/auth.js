const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;
const SUPABASE_ISSUER = process.env.SUPABASE_JWT_ISSUER;
const ADMIN_KEY = process.env.ADMIN_API_KEY;

module.exports = async (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey === ADMIN_KEY) return next();

    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ message: 'Unauthorized: Missing token' });
    }

    const token = authHeader.split(' ')[1];

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
