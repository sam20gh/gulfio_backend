require('dotenv').config();
const mongoose = require('mongoose');
const Article = require('./models/Article');
const axios = require('axios');

async function findCorrectVectorIndex() {
    try {
        console.log('🔍 Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGO_URI);

        // Create a test query embedding
        const testQuery = "football news";
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

        // Test the default index name
        const indexName = 'default';
        console.log(`\n🔍 Testing index name: "${indexName}"`);

        try {
            console.log(`\n🔍 Testing index name: "${indexName}"`);

            const pipeline = [
                {
                    $vectorSearch: {
                        index: indexName,
                        path: 'embedding_pca',
                        queryVector: queryEmbedding,
                        numCandidates: 200,
                        limit: 8
                    }
                },
                {
                    $project: {
                        title: 1,
                        content: 1,
                        category: 1,
                        publishedAt: 1,
                        sourceGroupName: 1,
                        score: { $meta: 'vectorSearchScore' }
                    }
                }
            ];

            const results = await Article.aggregate(pipeline);

            if (results.length > 0) {
                console.log(`🎉 SUCCESS! Index "${indexName}" returned ${results.length} results:`);
                results.forEach((article, index) => {
                    const publishDate = new Date(article.publishedAt).toLocaleDateString();
                    const contentPreview = article.content ?
                        article.content.replace(/<[^>]*>/g, '').substring(0, 100) + '...' :
                        'No content';
                    console.log(`${index + 1}. ${article.title}`);
                    console.log(`   Score: ${article.score?.toFixed(4)} | Category: ${article.category} | Published: ${publishDate}`);
                    console.log(`   Source: ${article.sourceGroupName || 'Gulf.io'}`);
                    console.log(`   Preview: ${contentPreview}`);
                    console.log('');
                });
                console.log(`✅ Vector search is working perfectly with detailed results!`);
            } else {
                console.log(`❌ Index "${indexName}" returned 0 results`);
            }

        } catch (error) {
            console.log(`❌ Index "${indexName}" failed:`, error.message);
        }

    } catch (error) {
        console.error('❌ Error:', error);
    } finally {
        await mongoose.connection.close();
        console.log('\n🔒 Database connection closed');
    }
}

findCorrectVectorIndex();