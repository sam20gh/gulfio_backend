const admin = require('firebase-admin');

let serviceAccount;
try {
    serviceAccount = JSON.parse(process.env.GOOGLE_CREDENTIALS || '{}');
} catch (error) {
    console.warn('Firebase credentials not found or invalid, using fallback');
    serviceAccount = {};
}

// Only initialize if we have valid credentials
if (serviceAccount.project_id) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
    });
} else {
    console.warn('Firebase admin not initialized - credentials missing');
}

module.exports = admin;