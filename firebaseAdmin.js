const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

let serviceAccount;
try {
    // First try environment variable
    if (process.env.GOOGLE_CREDENTIALS) {
        serviceAccount = JSON.parse(process.env.GOOGLE_CREDENTIALS);
    } else {
        // Fallback to local file (for local dev or if file is bundled)
        const credPath = path.join(__dirname, 'firebase-credentials.json');
        if (fs.existsSync(credPath)) {
            serviceAccount = JSON.parse(fs.readFileSync(credPath, 'utf8'));
        } else {
            serviceAccount = {};
        }
    }
} catch (error) {
    console.warn('Firebase credentials not found or invalid:', error.message);
    serviceAccount = {};
}

// Only initialize if we have valid credentials
if (serviceAccount.project_id) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
    });
    console.log('✅ Firebase admin initialized successfully');
} else {
    console.warn('Firebase admin not initialized - credentials missing');
}

module.exports = admin;