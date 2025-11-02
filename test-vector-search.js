require('dotenv').config();
const mongoose = require('mongoose');
const Article = require('./models/Article');
const axios = require('axios');

async function testVectorSearch() {
    try {
        console.log('🔍 Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGO_URI);

        console.log('🔍 Testing Atlas Vector Search...');

        // Create a test query embedding
        const testQuery = "latest news about football";
        console.log(`🔍 Creating embedding for query: "${testQuery}"`);

        const embeddingResponse = await axios.post('https://api.openai.com/v1/embeddings', {
            model: 'text-embedding-3-small',
            input: testQuery,
            dimensions: 128
        }, {
            headers: {
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        const queryEmbedding = embeddingResponse.data.data[0].embedding;
        console.log(`✅ Created embedding with ${queryEmbedding.length} dimensions`);

        // Test the vector search aggregation pipeline
        console.log('🔍 Testing $vectorSearch aggregation...');

        const pipeline = [
            {
                $vectorSearch: {
                    index: 'article_vector_index',
                    path: 'embedding_pca',
                    queryVector: queryEmbedding,
                    numCandidates: 100,
                    limit: 5
                }
            },
            {
                $project: {
                    title: 1,
                    content: 1,
                    category: 1,
                    publishedAt: 1,
                    score: { $meta: 'vectorSearchScore' }
                }
            }
        ];

        const results = await Article.aggregate(pipeline);

        console.log(`📊 Vector search returned ${results.length} results:`);
        results.forEach((article, index) => {
            console.log(`${index + 1}. ${article.title} (Score: ${article.score?.toFixed(4) || 'N/A'})`);
            console.log(`   Category: ${article.category}, Published: ${article.publishedAt}`);
            console.log(`   Content preview: ${article.content?.substring(0, 100)}...`);
            console.log('');
        });

        if (results.length === 0) {
            console.log('❌ Vector search returned no results!');
            console.log('🔍 This suggests either:');
            console.log('   1. Atlas Vector Search index "article_vector_index" does not exist');
            console.log('   2. Index is not configured correctly');
            console.log('   3. Index is not ready/building');
            console.log('   4. Query structure is incorrect');

            // Test a simple fallback search
            console.log('🔍 Testing fallback text search...');
            const textResults = await Article.find({
                $or: [
                    { title: { $regex: testQuery.split(' ').join('|'), $options: 'i' } },
                    { content: { $regex: testQuery.split(' ').join('|'), $options: 'i' } }
                ]
            }).limit(3).select('title category publishedAt');

            console.log(`📊 Text search returned ${textResults.length} results:`);
            textResults.forEach((article, index) => {
                console.log(`${index + 1}. ${article.title}`);
            });
        }

    } catch (error) {
        console.error('❌ Error testing vector search:', error);
        if (error.message.includes('$vectorSearch')) {
            console.log('💡 This error suggests Atlas Vector Search is not available or configured');
        }
    } finally {
        await mongoose.connection.close();
        console.log('🔒 Database connection closed');
    }
}

testVectorSearch();