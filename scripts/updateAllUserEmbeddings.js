require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const Article = require('../models/Article');
const { getDeepSeekEmbedding } = require('../utils/deepseek');
const { initializePCAModel, convertToPCAEmbedding } = require('../utils/pcaEmbedding');

/**
 * Script to update all user embeddings and PCA embeddings based on their activities
 * This script should be run periodically or when there are users with empty embeddings
 */

async function updateUserEmbeddingFromActivities(userId) {
    try {
        console.log(`📊 Processing user: ${userId}`);
        
        // Fetch the user
        const user = await User.findById(userId);
        if (!user) {
            console.log(`❌ User not found: ${userId}`);
            return;
        }

        // Get all article IDs from user activities with weights
        const activityMap = new Map();
        
        // Weight different activities differently
        const weights = {
            liked: 3.0,     // Strongest signal
            viewed: 1.0,    // Basic engagement  
            saved: 2.5,     // High interest
            disliked: -1.0  // Negative signal (we'll handle this separately)
        };

        // Collect liked articles (positive signal)
        if (user.liked_articles && user.liked_articles.length > 0) {
            for (const articleId of user.liked_articles) {
                activityMap.set(articleId.toString(), weights.liked);
            }
        }

        // Collect viewed articles (basic engagement)
        if (user.viewed_articles && user.viewed_articles.length > 0) {
            for (const articleId of user.viewed_articles) {
                const id = articleId.toString();
                // Don't override if already liked/saved
                if (!activityMap.has(id)) {
                    activityMap.set(id, weights.viewed);
                }
            }
        }

        // Collect saved articles (high interest)
        if (user.saved_articles && user.saved_articles.length > 0) {
            for (const articleId of user.saved_articles) {
                const id = articleId.toString();
                activityMap.set(id, Math.max(activityMap.get(id) || 0, weights.saved));
            }
        }

        // Handle disliked articles separately - we'll avoid these categories
        const dislikedCategories = new Set();
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

        // If no positive activities, set empty embeddings
        if (activityMap.size === 0) {
            console.log(`ℹ️ No positive activities found for user ${user.email || userId}`);
            await User.updateOne(
                { _id: userId },
                { 
                    $set: { 
                        embedding: [], 
                        embedding_pca: [],
                        disliked_categories: Array.from(dislikedCategories)
                    } 
                }
            );
            return;
        }

        // Get articles with highest engagement scores (limit to most recent 30)
        const sortedActivities = Array.from(activityMap.entries())
            .sort(([,a], [,b]) => b - a)
            .slice(0, 30);

        const articleIds = sortedActivities.map(([id]) => new mongoose.Types.ObjectId(id));

        // Fetch articles
        const articles = await Article.find({ 
            _id: { $in: articleIds }
        })
        .select('title content category publishedAt')
        .sort({ publishedAt: -1 })
        .lean();

        if (articles.length === 0) {
            console.log(`⚠️ No articles found for user activities: ${user.email || userId}`);
            return;
        }

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

        console.log(`📝 Generated profile text (${profileText.length} chars) for user ${user.email || userId}`);

        // Get embedding from DeepSeek
        let embedding = [];
        try {
            embedding = await getDeepSeekEmbedding(profileText);
            console.log(`✅ Generated embedding (${embedding.length}D) for user ${user.email || userId}`);
        } catch (err) {
            console.error(`❌ DeepSeek embedding error for user ${user.email || userId}:`, err.message);
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
            { _id: userId },
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
        return { embedding: embedding.length, embedding_pca: embedding_pca?.length || 0 };

    } catch (error) {
        console.error(`❌ Error updating embedding for user ${userId}:`, error);
        return null;
    }
}

async function updateAllUserEmbeddings() {
    try {
        console.log('🔌 Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGO_URI);
        console.log('✅ Connected to MongoDB');

        // Initialize PCA model first
        console.log('🔄 Initializing PCA model...');
        await initializePCAModel();

        // Find all users with empty embeddings or embedding_pca
        const usersWithEmptyEmbeddings = await User.find({
            $or: [
                { embedding: { $exists: false } },
                { embedding: { $size: 0 } },
                { embedding_pca: { $exists: false } },
                { embedding_pca: { $size: 0 } }
            ]
        }).select('_id email embedding embedding_pca liked_articles viewed_articles saved_articles disliked_articles');

        console.log(`📊 Found ${usersWithEmptyEmbeddings.length} users with empty embeddings`);

        if (usersWithEmptyEmbeddings.length === 0) {
            console.log('✅ All users already have embeddings');
            return;
        }

        let successCount = 0;
        let errorCount = 0;

        for (const user of usersWithEmptyEmbeddings) {
            try {
                console.log(`\n🔄 Processing user ${successCount + errorCount + 1}/${usersWithEmptyEmbeddings.length}`);
                const result = await updateUserEmbeddingFromActivities(user._id);
                
                if (result) {
                    successCount++;
                    console.log(`✅ Success: ${result.embedding}D embedding, ${result.embedding_pca}D PCA`);
                } else {
                    errorCount++;
                }

                // Small delay to avoid overwhelming the API
                await new Promise(resolve => setTimeout(resolve, 1000));

            } catch (error) {
                console.error(`❌ Failed to process user ${user._id}:`, error);
                errorCount++;
            }
        }

        console.log(`\n📊 Summary:`);
        console.log(`✅ Successfully updated: ${successCount} users`);
        console.log(`❌ Failed: ${errorCount} users`);
        console.log(`📋 Total processed: ${successCount + errorCount} users`);

    } catch (error) {
        console.error('❌ Script error:', error);
    } finally {
        await mongoose.disconnect();
        console.log('🔌 Disconnected from MongoDB');
    }
}

// Run the script if called directly
if (require.main === module) {
    updateAllUserEmbeddings()
        .then(() => {
            console.log('🎉 Script completed');
            process.exit(0);
        })
        .catch((error) => {
            console.error('💥 Script failed:', error);
            process.exit(1);
        });
}

module.exports = { updateAllUserEmbeddings, updateUserEmbeddingFromActivities };
