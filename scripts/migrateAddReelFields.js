// scripts/migrateAddReelFields.js

const mongoose = require('mongoose');
const User = require('../models/User');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/YOUR_DB_NAME';

async function run() {
    await mongoose.connect(MONGO_URI);

    const updates = [
        User.updateMany({ liked_reels: { $exists: false } }, { $set: { liked_reels: [] } }),
        User.updateMany({ disliked_reels: { $exists: false } }, { $set: { disliked_reels: [] } }),
        User.updateMany({ saved_reels: { $exists: false } }, { $set: { saved_reels: [] } }),
        User.updateMany({ viewed_reels: { $exists: false } }, { $set: { viewed_reels: [] } }),
    ];

    const results = await Promise.all(updates);
    results.forEach((result, idx) => {
        console.log(`Updated ${result.modifiedCount || result.nModified} users for update #${idx + 1}`);
    });

    mongoose.disconnect();
}

run().catch(err => {
    console.error('Migration error:', err);
    mongoose.disconnect();
});
