const jwt = require('jsonwebtoken');
const axios = require('axios');
const jwkToPem = require('jwk-to-pem');

const SUPABASE_JWT_ISSUER = 'https://uwbxhxsqisplrnvrltzv.supabase.co/auth/v1';
const JWKS_URL = `${SUPABASE_JWT_ISSUER}/.well-known/jwks.json`;

let cachedJWKS = null;

async function getJWKS() {
    if (!cachedJWKS) {
        const { data } = await axios.get(JWKS_URL);
        cachedJWKS = data;
    }
    return cachedJWKS;
}

module.exports = async (req, res, next) => {
    const apiKey = req.headers['x-api-key'];

    // Allow requests using x-api-key (used by frontend, scrapers, etc.)
    if (apiKey === process.env.ADMIN_API_KEY) {
        return next();
    }

    // Otherwise, try Supabase JWT Auth for the Expo app
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ message: 'Unauthorized' });
    }

    const token = authHeader.split(' ')[1];

    try {
        const jwks = await getJWKS();
        const [header] = token.split('.');
        const kid = JSON.parse(Buffer.from(header, 'base64').toString()).kid;
        const key = jwks.keys.find(k => k.kid === kid);

        if (!key) throw new Error('Key not found in JWKS');

        const pubKey = jwkToPem(key);
        const decoded = jwt.verify(token, pubKey, {
            issuer: SUPABASE_JWT_ISSUER,
            algorithms: ['RS256'],
        });

        req.user = decoded;
        next();
    } catch (err) {
        console.error('Supabase Auth error:', err.message);
        return res.status(403).json({ message: 'Forbidden: Invalid Supabase token' });
    }
};
