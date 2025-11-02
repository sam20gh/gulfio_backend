const mongoose = require('mongoose');
const Article = require('./models/Article');

// MongoDB connection
const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://sam20gh:jgQFY0UNv8N7Y5us@cluster0.eyzzrgk.mongodb.net/test?retryWrites=true&w=majority&readPreference=primary&maxPoolSize=10&serverSelectionTimeoutMS=30000&socketTimeoutMS=45000&appName=Cluster0";

async function debugVectorSearch() {
    try {
        console.log('🔍 Connecting to MongoDB...');
        await mongoose.connect(MONGO_URI);
        console.log('✅ Connected to MongoDB');

        // Test 1: Check if articles exist
        console.log('\n📊 Testing article count and recent articles...');
        const totalArticles = await Article.countDocuments();
        console.log(`Total articles: ${totalArticles}`);

        const englishArticles = await Article.countDocuments({ language: 'english' });
        console.log(`English articles: ${englishArticles}`);

        // Test 2: Check embedding_pca field existence
        console.log('\n🧠 Testing embedding_pca field...');
        const articlesWithEmbeddings = await Article.countDocuments({
            embedding_pca: { $exists: true, $ne: null }
        });
        console.log(`Articles with embedding_pca: ${articlesWithEmbeddings}`);

        if (articlesWithEmbeddings === 0) {
            console.log('❌ NO ARTICLES HAVE EMBEDDING_PCA FIELD!');
            console.log('This explains why vector search returns no results.');
        }

        // Test 3: Sample article structure
        console.log('\n📋 Sample article structure...');
        const sampleArticle = await Article.findOne().lean();
        if (sampleArticle) {
            console.log('Sample article fields:', Object.keys(sampleArticle));
            if (sampleArticle.embedding_pca) {
                console.log('Embedding_pca length:', sampleArticle.embedding_pca.length);
                console.log('First 5 embedding values:', sampleArticle.embedding_pca.slice(0, 5));
            } else {
                console.log('❌ Sample article has NO embedding_pca field');
            }
        }

        // Test 4: Recent UAE articles (text search)
        console.log('\n🇦🇪 Testing text search for UAE articles...');
        const uaeArticles = await Article.find({
            $or: [
                { title: { $regex: 'UAE', $options: 'i' } },
                { content: { $regex: 'UAE', $options: 'i' } },
                { title: { $regex: 'Dubai', $options: 'i' } },
                { title: { $regex: 'Abu Dhabi', $options: 'i' } }
            ],
            language: 'english'
        })
            .sort({ publishedAt: -1 })
            .limit(5)
            .select('title category publishedAt sourceGroupName')
            .lean();

        console.log(`Found ${uaeArticles.length} UAE-related articles via text search:`);
        uaeArticles.forEach((article, idx) => {
            console.log(`${idx + 1}. ${article.title}`);
            console.log(`   Category: ${article.category}, Date: ${article.publishedAt?.toISOString()?.substring(0, 10)}`);
        });

        // Test 5: Try a simple vector search if embeddings exist
        if (articlesWithEmbeddings > 0) {
            console.log('\n🔍 Testing vector search pipeline...');
            try {
                // Get a sample embedding to test with
                const sampleWithEmbedding = await Article.findOne({
                    embedding_pca: { $exists: true, $ne: null }
                }).lean();

                if (sampleWithEmbedding && sampleWithEmbedding.embedding_pca) {
                    console.log('Testing vector search with sample embedding...');

                    const vectorSearchResults = await Article.aggregate([
                        {
                            $vectorSearch: {
                                index: 'article_vector_index',
                                path: 'embedding_pca',
                                queryVector: sampleWithEmbedding.embedding_pca,
                                numCandidates: 10,
                                limit: 3
                            }
                        },
                        {
                            $project: {
                                title: 1,
                                category: 1,
                                publishedAt: 1,
                                score: { $meta: 'vectorSearchScore' }
                            }
                        }
                    ]);

                    console.log(`Vector search returned ${vectorSearchResults.length} results:`);
                    vectorSearchResults.forEach((result, idx) => {
                        console.log(`${idx + 1}. ${result.title} (score: ${result.score})`);
                    });
                } else {
                    console.log('❌ Could not find sample article with embedding_pca');
                }
            } catch (vectorError) {
                console.error('❌ Vector search failed:', vectorError.message);
                if (vectorError.message.includes('index')) {
                    console.log('💡 Possible issue: Vector search index "article_vector_index" may not exist');
                }
            }
        }

        // Test 6: Check categories and recent articles
        console.log('\n📂 Available categories...');
        const categories = await Article.distinct('category');
        console.log('Categories:', categories);

        console.log('\n📅 Most recent articles...');
        const recentArticles = await Article.find({ language: 'english' })
            .sort({ publishedAt: -1 })
            .limit(5)
            .select('title category publishedAt sourceGroupName')
            .lean();

        recentArticles.forEach((article, idx) => {
            console.log(`${idx + 1}. ${article.title}`);
            console.log(`   Category: ${article.category}, Date: ${article.publishedAt?.toISOString()?.substring(0, 10)}`);
        });

    } catch (error) {
        console.error('❌ Debug script failed:', error);
    } finally {
        await mongoose.disconnect();
        console.log('\n🔚 Debug completed');
    }
}

// Run the debug
debugVectorSearch();