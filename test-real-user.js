const mongoose = require('mongoose');
const User = require('./models/User');
const Article = require('./models/Article');

// List all users and test with a real one
async function testWithRealUser() {
    try {
        // Connect to MongoDB
        await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/gulfio');
        console.log('✅ Connected to MongoDB');

        // List all users
        const users = await User.find({}).limit(5);
        console.log('👥 Found users:', users.length);

        if (users.length > 0) {
            const testUser = users[0];
            console.log('🧪 Testing with user:', testUser.email, testUser.supabase_id);

            // Test the API call
            const response = await fetch(`http://localhost:3000/api/recommendations/${testUser.supabase_id}`);

            if (!response.ok) {
                const errorText = await response.text();
                console.log('❌ API Error:', response.status, errorText);
                return;
            }

            const data = await response.json();
            console.log('✅ API Response:', JSON.stringify(data, null, 2));
        } else {
            console.log('❌ No users found in database');
        }

    } catch (error) {
        console.error('❌ Test error:', error);
    } finally {
        mongoose.connection.close();
    }
}

testWithRealUser();
