/**
 * Backfill user stats from UserActivity to UserPoints
 * This fixes the articlesRead and sharesCompleted stats
 */

const mongoose = require('mongoose');
require('dotenv').config();

async function backfillUserStats() {
    await mongoose.connect(process.env.MONGO_URI);
    
    const UserPoints = require('../models/UserPoints');
    const UserActivity = require('../models/UserActivity');
    
    const userId = '1d9861e0-db07-437b-8de9-8b8f1c8d8e6d';
    
    // Count unique article views (deduplicated by articleId)
    const uniqueArticleViews = await UserActivity.aggregate([
        { $match: { userId, eventType: 'view', articleId: { $exists: true } } },
        { $group: { _id: '$articleId' } },
        { $count: 'total' }
    ]);
    
    const articlesRead = uniqueArticleViews[0]?.total || 0;
    console.log('Unique articles viewed:', articlesRead);
    
    // Count shares
    const sharesCount = await UserActivity.countDocuments({ userId, eventType: 'share' });
    console.log('Shares count:', sharesCount);
    
    // Update UserPoints with correct counts
    const result = await UserPoints.findOneAndUpdate(
        { userId },
        { 
            $set: { 
                'stats.articlesRead': articlesRead,
                'stats.sharesCompleted': sharesCount
            } 
        },
        { new: true }
    );
    
    console.log('\nUpdated UserPoints stats:');
    console.log('articlesRead:', result.stats.articlesRead);
    console.log('sharesCompleted:', result.stats.sharesCompleted);
    
    await mongoose.disconnect();
    console.log('\nDone!');
}

backfillUserStats().catch(console.error);
