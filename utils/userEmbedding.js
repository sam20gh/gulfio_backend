const { getDeepSeekEmbedding } = require('../utils/deepseek');
const { convertToPCAEmbedding } = require('../utils/pcaEmbedding');
const User = require('../models/User');
const Article = require('../models/Article');
const UserActivity = require('../models/UserActivity');
const mongoose = require('mongoose');

/**
 * Update a user's embedding profile based on both direct activities and UserActivity records.
 * Includes both regular embedding and PCA embedding generation.
 * @param {String} userId - The user's MongoDB _id or supabase_id
 * @returns {Promise<void>}
 */
async function updateUserProfileEmbedding(userId) {
    try {
        console.log(`📊 Updating embeddings for user: ${userId}`);

        // Fetch the user
        const user = await User.findById(userId) || await User.findOne({ supabase_id: userId });
        if (!user) throw new Error('User not found');

        // Get user activities with different weights from BOTH sources
        const activityMap = new Map();
        const weights = {
            liked: 3.0,     // Strongest positive signal
            viewed: 1.0,    // Basic engagement
            saved: 2.5,     // High interest  
            disliked: -1.0, // Negative signal
            read_time: 1.5  // Reading engagement (between view and like)
        };

        // 1. COLLECT FROM DIRECT USER ARRAYS (existing behavior)
        
        // Collect liked articles (positive signal)
        if (user.liked_articles && user.liked_articles.length > 0) {
            for (const articleId of user.liked_articles) {
                if (articleId) { // Add null check
                    activityMap.set(articleId.toString(), weights.liked);
                }
            }
        }

        // Collect viewed articles (basic engagement)
        if (user.viewed_articles && user.viewed_articles.length > 0) {
            for (const articleId of user.viewed_articles) {
                if (articleId) { // Add null check
                    const id = articleId.toString();
                    if (!activityMap.has(id)) {
                        activityMap.set(id, weights.viewed);
                    }
                }
            }
        }

        // Collect saved articles (high interest)
        if (user.saved_articles && user.saved_articles.length > 0) {
            for (const articleId of user.saved_articles) {
                if (articleId) { // Add null check
                    const id = articleId.toString();
                    activityMap.set(id, Math.max(activityMap.get(id) || 0, weights.saved));
                }
            }
        }

        // 2. COLLECT FROM UserActivity RECORDS (new behavior)
        
        // Get recent user activities from UserActivity collection
        const recentActivities = await UserActivity.find({
            userId: user.supabase_id, // UserActivity uses supabase_id
            articleId: { $exists: true, $ne: null },
            timestamp: { 
                $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) // Last 30 days
            }
        })
        .sort({ timestamp: -1 })
        .limit(500) // Limit to most recent 500 activities
        .lean();

        console.log(`📈 Found ${recentActivities.length} recent activities from UserActivity collection`);

        // Process UserActivity records
        for (const activity of recentActivities) {
            const articleId = activity.articleId.toString();
            const currentWeight = activityMap.get(articleId) || 0;
            
            let activityWeight = 0;
            switch (activity.eventType) {
                case 'view':
                    activityWeight = weights.viewed;
                    break;
                case 'like':
                    activityWeight = weights.liked;
                    break;
                case 'dislike':
                    activityWeight = weights.disliked;
                    break;
                case 'save':
                    activityWeight = weights.saved;
                    break;
                case 'read_time':
                    // Weight read_time based on duration (more reading = higher weight)
                    const duration = activity.duration || 1;
                    const readWeight = Math.min(duration / 10, 2) * weights.read_time; // Cap at 2x base weight
                    activityWeight = readWeight;
                    break;
                default:
                    continue;
            }
            
            // Use the highest weight for each article
            activityMap.set(articleId, Math.max(currentWeight, activityWeight));
        }

        console.log(`🎯 Total unique articles in activity map: ${activityMap.size}`);

        // Track disliked categories for future filtering
        const dislikedCategories = new Set(user.disliked_categories || []);
        if (user.disliked_articles && user.disliked_articles.length > 0) {
            const dislikedArticles = await Article.find({ 
                _id: { $in: user.disliked_articles }
            }).select('category').lean();
            
            dislikedArticles.forEach(article => {
                if (article.category) {
                    dislikedCategories.add(article.category);
                }
            });
        }

        // If no positive activities, reset embeddings
        if (activityMap.size === 0) {
            console.log(`ℹ️ No activities found for user ${user.email || userId}, resetting embeddings`);
            await User.updateOne(
                { _id: user._id },
                { 
                    $set: { 
                        embedding: [], 
                        embedding_pca: [],
                        disliked_categories: Array.from(dislikedCategories),
                        updatedAt: new Date()
                    } 
                }
            );
            return;
        }

        // Get top activities (most recent 30 with highest weights)
        const sortedActivities = Array.from(activityMap.entries())
            .sort(([,a], [,b]) => b - a)
            .slice(0, 30);

        const articleIds = sortedActivities.map(([id]) => new mongoose.Types.ObjectId(id));

        // Fetch articles
        const articles = await Article.find({ _id: { $in: articleIds } })
            .select('title content category publishedAt')
            .sort({ publishedAt: -1 })
            .lean();

        if (articles.length === 0) {
            console.log(`⚠️ No articles found for user activities: ${user.email || userId}`);
            return;
        }

        console.log(`📚 Using ${articles.length} articles for embedding generation`);

        // Create weighted text based on activities
        let weightedTexts = [];
        for (const article of articles) {
            const weight = activityMap.get(article._id.toString()) || 1.0;
            const importance = Math.max(1, Math.floor(weight));
            
            const text = `${article.title} - ${article.content?.slice(0, 200) || ''}`;
            
            // Repeat text based on weight for emphasis
            for (let i = 0; i < importance; i++) {
                weightedTexts.push(text);
            }
        }

        const profileText = weightedTexts.join('\n');

        // Get embedding from DeepSeek
        let embedding = [];
        try {
            embedding = await getDeepSeekEmbedding(profileText);
            console.log(`✅ Generated embedding (${embedding.length}D) for user ${user.email || userId}`);
        } catch (err) {
            console.warn('DeepSeek embedding error for user:', err.message);
            return;
        }

        // Convert to PCA embedding
        let embedding_pca = [];
        try {
            embedding_pca = await convertToPCAEmbedding(embedding);
            if (embedding_pca) {
                console.log(`✅ Generated PCA embedding (${embedding_pca.length}D) for user ${user.email || userId}`);
            } else {
                console.warn(`⚠️ Failed to generate PCA embedding for user ${user.email || userId}`);
            }
        } catch (err) {
            console.error(`❌ PCA conversion error for user ${user.email || userId}:`, err.message);
        }

        // Update user with both embeddings
        await User.updateOne(
            { _id: user._id },
            { 
                $set: { 
                    embedding: embedding,
                    embedding_pca: embedding_pca || [],
                    disliked_categories: Array.from(dislikedCategories),
                    updatedAt: new Date()
                } 
            }
        );

        console.log(`✅ Updated embeddings for user ${user.email || userId}`);
        
    } catch (error) {
        console.error(`❌ Error updating embedding for user ${userId}:`, error);
        throw error;
    }
}

module.exports = { updateUserProfileEmbedding };
