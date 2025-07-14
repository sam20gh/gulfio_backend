const mongoose = require('mongoose');
const User = require('./models/User');
const Article = require('./models/Article');

// Create test data
async function createTestData() {
    try {
        // Connect to MongoDB
        await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/gulfio');
        console.log('✅ Connected to MongoDB');

        // Check if we have articles
        const articleCount = await Article.countDocuments();
        console.log('📰 Articles in database:', articleCount);

        if (articleCount === 0) {
            console.log('❌ No articles found. Creating test article...');
            const testArticle = await Article.create({
                title: 'Test Article',
                content: 'This is a test article content',
                url: 'https://example.com/test',
                category: 'Technology',
                publishedAt: new Date(),
                viewCount: 10,
                likes: 5,
                dislikes: 0,
                image: ['https://via.placeholder.com/300x200']
            });
            console.log('✅ Test article created:', testArticle._id);
        }

        // Create or find a test user
        let testUser = await User.findOne({ supabase_id: 'test-user-123' });
        if (!testUser) {
            testUser = await User.create({
                supabase_id: 'test-user-123',
                email: 'test@example.com',
                name: 'Test User',
                liked_articles: [],
                saved_articles: [],
                viewed_articles: []
            });
            console.log('✅ Test user created:', testUser.supabase_id);
        } else {
            console.log('✅ Test user found:', testUser.supabase_id);
        }

        // Wait a moment to ensure data is committed
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Test the recommendations endpoint
        console.log('🔍 Testing recommendations endpoint...');
        const response = await fetch(`http://localhost:3000/api/recommendations/${testUser.supabase_id}`);
        
        if (!response.ok) {
            const errorText = await response.text();
            console.log('❌ API Error:', response.status, errorText);
            return;
        }

        const data = await response.json();
        console.log('✅ API Response:', JSON.stringify(data, null, 2));
        
    } catch (error) {
        console.error('❌ Test error:', error);
    } finally {
        mongoose.connection.close();
    }
}

createTestData();
