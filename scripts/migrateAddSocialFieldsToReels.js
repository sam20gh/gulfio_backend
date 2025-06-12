const mongoose = require('mongoose');
const Reel = require('../models/Reel');
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/YOUR_DB_NAME';

async function run() {
    await mongoose.connect(MONGO_URI);

    const updates = [
        Reel.updateMany({ likes: { $exists: false } }, { $set: { likes: 0 } }),
        Reel.updateMany({ likedBy: { $exists: false } }, { $set: { likedBy: [] } }),
        Reel.updateMany({ dislikes: { $exists: false } }, { $set: { dislikes: 0 } }),
        Reel.updateMany({ dislikedBy: { $exists: false } }, { $set: { dislikedBy: [] } }),
        Reel.updateMany({ viewCount: { $exists: false } }, { $set: { viewCount: 0 } }),
        Reel.updateMany({ viewedBy: { $exists: false } }, { $set: { viewedBy: [] } }),
    ];

    const results = await Promise.all(updates);
    results.forEach((result, idx) => {
        console.log(`Updated ${result.modifiedCount || result.nModified} reels for update #${idx + 1}`);
    });
    mongoose.disconnect();
}

run().catch(err => {
    console.error('Migration error:', err);
    mongoose.disconnect();
});
