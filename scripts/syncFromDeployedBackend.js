require('dotenv').config();
const mongoose = require('mongoose');
const axios = require('axios');
const Article = require('../models/Article');

const DEPLOYED_BACKEND_URL = 'https://api.gulfio.app';

async function syncArticlesFromDeployedBackend() {
    try {
        // Connect to local MongoDB
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to local MongoDB');

        // Check current local count
        const localCount = await Article.countDocuments();
        console.log(`Current local articles: ${localCount}`);

        let page = 1;
        let limit = 50;
        let totalSynced = 0;

        while (true) {
            console.log(`Fetching page ${page}...`);

            try {
                const response = await axios.get(`${DEPLOYED_BACKEND_URL}/api/articles`, {
                    params: { page, limit },
                    timeout: 30000
                });

                const articles = response.data;
                console.log(`Retrieved ${articles.length} articles from deployed backend`);

                if (articles.length === 0) {
                    console.log('No more articles to sync');
                    break;
                }

                // Process articles in batches
                for (const articleData of articles) {
                    try {
                        // Check if article already exists locally
                        const existingArticle = await Article.findOne({ _id: articleData._id });

                        if (!existingArticle) {
                            // Create new article
                            const newArticle = new Article({
                                _id: articleData._id,
                                title: articleData.title,
                                content: articleData.content,
                                url: articleData.url,
                                sourceId: articleData.sourceId,
                                category: articleData.category,
                                publishedAt: articleData.publishedAt,
                                image: articleData.image,
                                viewCount: articleData.viewCount || 0,
                                likes: articleData.likes || 0,
                                dislikes: articleData.dislikes || 0,
                                likedBy: articleData.likedBy || [],
                                dislikedBy: articleData.dislikedBy || [],
                                language: articleData.language,
                                embedding: articleData.embedding,
                                relatedIds: articleData.relatedIds || [],
                                fetchId: articleData.fetchId
                            });

                            await newArticle.save();
                            totalSynced++;
                            console.log(`Synced: ${articleData.title.slice(0, 60)}...`);
                        } else {
                            // Update existing article if needed
                            let updated = false;

                            if (!existingArticle.embedding && articleData.embedding) {
                                existingArticle.embedding = articleData.embedding;
                                updated = true;
                            }

                            if (existingArticle.viewCount !== articleData.viewCount) {
                                existingArticle.viewCount = articleData.viewCount;
                                updated = true;
                            }

                            if (updated) {
                                await existingArticle.save();
                                console.log(`Updated: ${articleData.title.slice(0, 60)}...`);
                            }
                        }
                    } catch (articleError) {
                        console.error(`Error processing article ${articleData._id}:`, articleError.message);
                    }
                }

                page++;

                // Add small delay to avoid overwhelming the server
                await new Promise(resolve => setTimeout(resolve, 1000));

            } catch (fetchError) {
                console.error(`Error fetching page ${page}:`, fetchError.message);
                break;
            }
        }

        console.log(`\n✅ Sync completed!`);
        console.log(`Total articles synced: ${totalSynced}`);

        const finalCount = await Article.countDocuments();
        console.log(`Final local count: ${finalCount}`);

        // Check embedding dimensions
        const sampleWithEmbedding = await Article.findOne({ embedding: { $exists: true, $ne: null } });
        if (sampleWithEmbedding) {
            console.log(`Embedding dimensions: ${sampleWithEmbedding.embedding.length}D`);
        }

    } catch (error) {
        console.error('Sync error:', error);
    } finally {
        await mongoose.disconnect();
        console.log('Disconnected from MongoDB');
    }
}

// Run the sync
if (require.main === module) {
    syncArticlesFromDeployedBackend();
}

module.exports = { syncArticlesFromDeployedBackend };
