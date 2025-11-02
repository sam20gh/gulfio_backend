require('dotenv').config();
const mongoose = require('mongoose');
const Article = require('./models/Article');
const { generateResponse, searchArticles } = require('./services/aiAgentService');

async function testCompleteAIFlow() {
    try {
        console.log('🔍 Testing complete AI chat flow...');
        await mongoose.connect(process.env.MONGO_URI);

        const testQuery = "What are the latest news from UAE?";
        console.log(`🔍 Testing query: "${testQuery}"`);

        // Step 1: Search for articles
        console.log('\n📊 Step 1: Searching for articles...');
        const articles = await searchArticles(testQuery);
        console.log(`✅ Found ${articles.length} articles`);

        if (articles.length > 0) {
            console.log('📰 Top articles:');
            articles.slice(0, 3).forEach((article, index) => {
                console.log(`${index + 1}. ${article.title}`);
                console.log(`   Category: ${article.category} | Published: ${new Date(article.publishedAt).toLocaleDateString()}`);
            });
        }

        // Step 2: Generate AI response
        console.log('\n🤖 Step 2: Generating AI response...');
        const response = await generateResponse(testQuery, articles, 'test-session', 'test-user');

        console.log('\n✅ AI Response Generated:');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log(response.text);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        console.log('\n📊 Response Metadata:');
        console.log(`- Articles found: ${response.metadata.articlesFound}`);
        console.log(`- Response time: ${response.metadata.responseTime}ms`);
        console.log(`- Fallback used: ${response.metadata.fallback || false}`);

        if (response.text.includes("having trouble")) {
            console.log('\n❌ Still getting fallback response! Check OpenAI API issues.');
        } else {
            console.log('\n🎉 SUCCESS! AI is generating detailed responses!');
        }

    } catch (error) {
        console.error('❌ Error in AI flow test:', error);
    } finally {
        await mongoose.connection.close();
        console.log('\n🔒 Database connection closed');
    }
}

testCompleteAIFlow();