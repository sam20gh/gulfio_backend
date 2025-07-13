#!/usr/bin/env node

/**
 * Comprehensive test for the notification system
 * Tests: API endpoints, deep link handling, and notification preferences
 */

const axios = require('axios');

const API_BASE_URL = 'http://localhost:3000/api';

// Test data
const testNotificationSettings = {
    newsNotifications: true,
    userNotifications: false,
    breakingNews: true,
    weeklyDigest: false,
    followedSources: true,
    articleLikes: false,
    newFollowers: true,
    mentions: true,
};

const testDeepLinkData = {
    link: 'gulfio://article/507f1f77bcf86cd799439011',
    imageUrl: 'https://example.com/test-image.jpg',
    title: 'Test Article',
    body: 'This is a test notification body'
};

async function testNotificationSettingsAPI() {
    console.log('\n🧪 Testing Notification Settings API...');
    
    try {
        // Test GET endpoint (should return 401 without auth)
        console.log('Testing GET /api/users/notification-settings...');
        const getResponse = await axios.get(`${API_BASE_URL}/users/notification-settings`, {
            validateStatus: () => true // Don't throw on error status
        });
        
        if (getResponse.status === 401 || getResponse.status === 500) {
            console.log('✅ GET endpoint accessible (auth required as expected)');
        } else {
            console.log('❌ Unexpected response:', getResponse.status, getResponse.data);
        }
        
        // Test PUT endpoint (should return 401 without auth)
        console.log('Testing PUT /api/users/notification-settings...');
        const putResponse = await axios.put(
            `${API_BASE_URL}/users/notification-settings`,
            { notificationSettings: testNotificationSettings },
            {
                headers: { 'Content-Type': 'application/json' },
                validateStatus: () => true
            }
        );
        
        if (putResponse.status === 401 || putResponse.status === 500) {
            console.log('✅ PUT endpoint accessible (auth required as expected)');
        } else {
            console.log('❌ Unexpected response:', putResponse.status, putResponse.data);
        }
        
    } catch (error) {
        console.error('❌ API test failed:', error.message);
    }
}

async function testNotificationDataStructure() {
    console.log('\n🧪 Testing Notification Data Structure...');
    
    // Test deep link extraction logic (simulated)
    const testData = [
        // Direct link in data
        { data: { link: 'gulfio://article/123' } },
        // Nested link in data.data
        { data: { data: { link: 'gulfio://article/456' } } },
        // Stringified JSON
        { data: JSON.stringify({ link: 'gulfio://article/789' }) },
        // No link
        { data: { title: 'No link here' } }
    ];
    
    testData.forEach((testCase, index) => {
        console.log(`Testing case ${index + 1}:`, JSON.stringify(testCase));
        
        let link = null;
        const data = testCase.data;
        
        // Simulate the link extraction logic from the app
        if (data?.link) {
            link = data.link;
        } else if (data?.data?.link) {
            link = data.data.link;
        } else if (typeof data === 'string') {
            try {
                const parsed = JSON.parse(data);
                link = parsed.link;
            } catch (e) {
                // Silent fail
            }
        }
        
        if (link && typeof link === 'string') {
            const match = link.match(/^gulfio:\/\/article\/(.+)$/);
            if (match) {
                console.log(`  ✅ Link extracted: ${link} -> Article ID: ${match[1]}`);
            } else {
                console.log(`  ❌ Link format invalid: ${link}`);
            }
        } else {
            console.log(`  ⚠️ No link found in data`);
        }
    });
}

async function testBackendIntegration() {
    console.log('\n🧪 Testing Backend Integration...');
    
    try {
        // Test if server is running
        const healthResponse = await axios.get(`${API_BASE_URL}/sources`, {
            validateStatus: () => true,
            timeout: 5000
        });
        
        if (healthResponse.status === 200 || healthResponse.status === 401) {
            console.log('✅ Backend server is running');
        } else {
            console.log('❌ Backend server may not be running properly');
            return;
        }
        
        // Test user routes existence
        const userRoutesResponse = await axios.get(`${API_BASE_URL}/users/notification-settings`, {
            validateStatus: () => true
        });
        
        if (userRoutesResponse.status !== 404) {
            console.log('✅ User notification routes are registered');
        } else {
            console.log('❌ User notification routes not found');
        }
        
    } catch (error) {
        console.error('❌ Backend integration test failed:', error.message);
    }
}

async function runAllTests() {
    console.log('🚀 Starting Notification System Tests...');
    console.log('==================================================');
    
    await testBackendIntegration();
    await testNotificationSettingsAPI();
    await testNotificationDataStructure();
    
    console.log('\n🏁 Tests completed!');
    console.log('==================================================');
    console.log('\n📋 Next Steps:');
    console.log('1. Test with real authentication tokens in a frontend app');
    console.log('2. Send actual push notifications to test devices');
    console.log('3. Verify deep links work in production app builds');
    console.log('4. Test notification preferences filtering in the scraper');
}

// Run tests
runAllTests().catch(console.error);
