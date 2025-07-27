const mongoose = require('mongoose');
const redis = require('../utils/redis');
const User = require('../models/User');
const Article = require('../models/Article');
const { searchFaissIndex, getFaissIndexStatus } = require('../recommendation/faissIndex');
require('dotenv').config(); // Load environment variables

/**
 * Calculate engagement score for an article
 * @param {Object} article - Article object
 * @returns {number} Engagement score
 */
function calculateEngagementScore(article) {
    const viewsWeight = 0.4;
    const likesWeight = 0.4;
    const dislikesWeight = -0.2;
    const recencyWeight = 0.2;

    const now = new Date();
    const hoursSincePublished = (now - new Date(article.publishedAt)) / (1000 * 60 * 60);
    const recencyScore = Math.max(0, 1 - hoursSincePublished / (24 * 7)); // Decay over 7 days

    return (
        (article.viewCount || 0) * viewsWeight +
        (article.likes || 0) * likesWeight +
        (article.dislikes || 0) * dislikesWeight +
        recencyScore * recencyWeight
    );
}

async function precomputeRecommendations() {
    try {
        console.log('🔌 Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/menaapp');

        // Check if Faiss index is available
        const faissStatus = getFaissIndexStatus();
        if (!faissStatus.isInitialized) {
            console.error('❌ Faiss index is not initialized. Cannot precompute recommendations.');
            return;
        }

        console.log('📊 Faiss index status:', faissStatus);

        // Find users with PCA embeddings
        const users = await User.find({
            embedding_pca: { $exists: true, $ne: null, $not: { $size: 0 } }
        }).lean();

        console.log(`👥 Found ${users.length} users with PCA embeddings`);

        if (users.length === 0) {
            console.log('⚠️ No users with PCA embeddings found. Nothing to precompute.');
            return;
        }

        let processedCount = 0;
        const batchSize = 10; // Process users in batches to avoid overwhelming the system
        const languages = ['english', 'arabic']; // Add more languages as needed

        for (let i = 0; i < users.length; i += batchSize) {
            const batch = users.slice(i, i + batchSize);

            await Promise.all(batch.map(async (user) => {
                try {
                    for (const language of languages) {
                        // Precompute for page 1 (most commonly accessed)
                        const cacheKey = `articles_personalized_${user.supabase_id}_page_1_limit_20_lang_${language}`;

                        // Skip if already cached and fresh
                        const existing = await redis.get(cacheKey);
                        if (existing) {
                            console.log(`⚡ Skipping ${user.supabase_id} (${language}) - already cached`);
                            return;
                        }

                        console.log(`🎯 Precomputing recommendations for user ${user.supabase_id} (${language})`);

                        // Get similar articles using Faiss
                        const { ids, distances } = await searchFaissIndex(user.embedding_pca, 40);

                        // Fetch article details
                        const articles = await Article.find({
                            _id: { $in: ids.map(id => new mongoose.Types.ObjectId(id)) },
                            language: language,
                            _id: { $nin: user.disliked_articles || [] }
                        }).lean();

                        // Calculate combined scores
                        const scoredArticles = articles.map(article => {
                            const index = ids.indexOf(article._id.toString());
                            const similarity = index !== -1 ? Math.max(0, 1 - distances[index]) : 0;
                            const engagementScore = calculateEngagementScore(article);
                            const finalScore = (similarity * 0.6) + (engagementScore * 0.4);

                            return {
                                ...article,
                                fetchId: new mongoose.Types.ObjectId().toString(),
                                similarity,
                                engagementScore,
                                finalScore
                            };
                        });

                        // Sort and take top 20
                        let finalArticles = scoredArticles
                            .sort((a, b) => b.finalScore - a.finalScore)
                            .slice(0, 20);

                        // Add some trending articles for diversity (2-3 articles)
                        const trendingLimit = 2;
                        const trendingArticles = await Article.find({
                            language: language,
                            viewCount: { $exists: true, $gt: 0 },
                            _id: { $nin: finalArticles.map(a => a._id) },
                            _id: { $nin: user.disliked_articles || [] }
                        })
                            .sort({ viewCount: -1, publishedAt: -1 })
                            .limit(trendingLimit)
                            .lean();

                        const trendingEnhanced = trendingArticles.map(article => ({
                            ...article,
                            fetchId: new mongoose.Types.ObjectId().toString(),
                            isTrending: true,
                            engagementScore: calculateEngagementScore(article)
                        }));

                        // Insert trending articles randomly
                        for (let j = 0; j < trendingEnhanced.length; j++) {
                            const insertIndex = Math.floor(Math.random() * (finalArticles.length + 1));
                            finalArticles.splice(insertIndex, 0, trendingEnhanced[j]);
                        }

                        // Ensure we don't exceed 20 articles
                        finalArticles = finalArticles.slice(0, 20);

                        // Cache the results for 6 hours
                        await redis.set(cacheKey, JSON.stringify(finalArticles), 'EX', 6 * 3600);

                        console.log(`✅ Cached ${finalArticles.length} articles for ${user.supabase_id} (${language})`);
                    }

                    processedCount++;

                } catch (userError) {
                    console.error(`❌ Error processing user ${user.supabase_id}:`, userError);
                }
            }));

            console.log(`📊 Processed ${Math.min(i + batchSize, users.length)}/${users.length} users`);

            // Small delay between batches to avoid overwhelming the system
            if (i + batchSize < users.length) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        console.log(`🎉 Precomputation completed! Processed ${processedCount}/${users.length} users`);

    } catch (error) {
        console.error('❌ Error precomputing recommendations:', error);
    } finally {
        await mongoose.disconnect();
        console.log('🔌 Disconnected from MongoDB');
    }
}

// Run the function
if (require.main === module) {
    precomputeRecommendations().catch(console.error);
}

module.exports = { precomputeRecommendations };
