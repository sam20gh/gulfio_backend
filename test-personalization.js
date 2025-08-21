/**
 * Test Script for Enhanced Personalized Video Recommendations
 * 
 * This script demonstrates the new personalization features:
 * 1. User preference learning from interactions
 * 2. Personalized content mixing strategies  
 * 3. Smart duplicate avoidance
 * 4. Source variety enforcement
 */

const axios = require('axios');

const BASE_URL = 'http://localhost:3000/api/videos'; // Adjust as needed
const TEST_USER_TOKEN = 'your-test-jwt-token-here'; // Replace with a real test token

class PersonalizationTester {
    constructor(baseUrl, token) {
        this.baseUrl = baseUrl;
        this.token = token;
        this.headers = {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        };
    }

    async testBasicReelFeed() {
        console.log('\n🎬 Testing Basic Reel Feed...');
        
        try {
            const response = await axios.get(`${this.baseUrl}/reels?limit=10`);
            const data = response.data;
            
            console.log(`✅ Retrieved ${data.reels?.length || data.length} reels`);
            console.log('Content types:', this.analyzeContentTypes(data.reels || data));
            
            return data;
        } catch (error) {
            console.error('❌ Basic feed test failed:', error.message);
            return null;
        }
    }

    async testPersonalizedFeed() {
        console.log('\n🎯 Testing Personalized Feed...');
        
        try {
            const response = await axios.get(`${this.baseUrl}/reels?sort=personalized&limit=10`, {
                headers: this.headers
            });
            const data = response.data;
            
            console.log(`✅ Retrieved ${data.reels?.length || data.length} personalized reels`);
            
            if (data.personalization) {
                console.log('🧠 Personalization Info:');
                console.log(`  Strategy: ${data.personalization.strategy}`);
                console.log(`  User Interactions: ${data.personalization.userInteractions}`);
                console.log(`  Content Mix:`, data.personalization.contentMix);
                console.log(`  Preferred Sources:`, data.personalization.preferredSources?.map(([name]) => name).join(', '));
            }
            
            return data;
        } catch (error) {
            console.error('❌ Personalized feed test failed:', error.message);
            return null;
        }
    }

    async testUserPreferences() {
        console.log('\n👤 Testing User Preferences...');
        
        try {
            const response = await axios.get(`${this.baseUrl}/user/preferences`, {
                headers: this.headers
            });
            const data = response.data;
            
            if (data.success) {
                console.log('✅ User preferences retrieved successfully');
                console.log(`📊 Total interactions: ${data.preferences.totalInteractions}`);
                console.log(`🎯 Current strategy: ${data.recommendations.currentStrategy}`);
                console.log('🔝 Top sources:', data.preferences.sourcePreferences.slice(0, 3));
                console.log('📂 Top categories:', data.preferences.categoryPreferences.slice(0, 3));
            }
            
            return data;
        } catch (error) {
            console.error('❌ User preferences test failed:', error.message);
            return null;
        }
    }

    async testViewTracking(reelId) {
        console.log(`\n👀 Testing View Tracking for reel ${reelId}...`);
        
        try {
            const response = await axios.post(`${this.baseUrl}/reels/${reelId}/view`, {
                duration: Math.floor(Math.random() * 30) + 10 // Random 10-40 second duration
            }, {
                headers: this.headers
            });
            
            const data = response.data;
            if (data.success) {
                console.log('✅ View tracked successfully');
                console.log(`📊 View count: ${data.viewCount}`);
                console.log(`🔐 Authenticated: ${data.isAuthenticated}`);
            }
            
            return data;
        } catch (error) {
            console.error('❌ View tracking test failed:', error.message);
            return null;
        }
    }

    async testInteractions(reelId) {
        console.log(`\n❤️ Testing Interactions for reel ${reelId}...`);
        
        try {
            // Test like
            const likeResponse = await axios.post(`${this.baseUrl}/reels/${reelId}/like`, {}, {
                headers: this.headers
            });
            console.log('👍 Like response:', {
                likes: likeResponse.data.likes,
                isLiked: likeResponse.data.isLiked
            });

            // Test save
            const saveResponse = await axios.post(`${this.baseUrl}/reels/${reelId}/save`, {}, {
                headers: this.headers
            });
            console.log('💾 Save response:', {
                saves: saveResponse.data.saves,
                isSaved: saveResponse.data.isSaved
            });

            return { likeResponse: likeResponse.data, saveResponse: saveResponse.data };
        } catch (error) {
            console.error('❌ Interactions test failed:', error.message);
            return null;
        }
    }

    async runFullTest() {
        console.log('🚀 Starting Personalization Test Suite...');
        console.log('======================================');

        // Test 1: Basic feed
        const basicFeed = await this.testBasicReelFeed();
        
        // Test 2: User preferences (if authenticated)
        if (this.token && this.token !== 'your-test-jwt-token-here') {
            await this.testUserPreferences();
            
            // Test 3: Personalized feed
            const personalizedFeed = await this.testPersonalizedFeed();
            
            // Test 4: Interactions with first reel
            if (personalizedFeed?.reels?.length > 0) {
                const firstReelId = personalizedFeed.reels[0]._id;
                await this.testViewTracking(firstReelId);
                await this.testInteractions(firstReelId);
            }
        } else {
            console.log('⚠️ Skipping authenticated tests - no valid token provided');
        }
        
        console.log('\n✅ Test suite completed!');
    }

    analyzeContentTypes(reels) {
        const types = {};
        reels.forEach(reel => {
            const type = reel.contentType || 'unknown';
            types[type] = (types[type] || 0) + 1;
        });
        return types;
    }
}

// Usage example
async function main() {
    const tester = new PersonalizationTester(BASE_URL, TEST_USER_TOKEN);
    await tester.runFullTest();
}

// Uncomment to run the test
// main().catch(console.error);

module.exports = PersonalizationTester;
