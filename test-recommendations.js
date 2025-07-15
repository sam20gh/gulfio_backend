const mongoose = require('mongoose');
const User = require('./models/User');

// Test script to debug recommendations
async function testRecommendations() {
    try {
        // Connect to MongoDB
        await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/gulfio');
        console.log('✅ Connected to MongoDB');

        // Find a test user
        const testUser = await User.findOne().lean();
        if (!testUser) {
            console.log('❌ No users found in database');
            return;
        }

        console.log('🔍 Testing with user:', testUser.email);
        console.log('📊 User supabase_id:', testUser.supabase_id);

        // Test the recommendations endpoint
        const response = await fetch(`http://localhost:3000/api/recommendations/${testUser.supabase_id}`);

        if (!response.ok) {
            const errorText = await response.text();
            console.log('❌ API Error:', errorText);
            return;
        }

        const data = await response.json();
        console.log('✅ API Response:', data);

    } catch (error) {
        console.error('❌ Test error:', error);
    } finally {
        mongoose.connection.close();
    }
}

testRecommendations();
