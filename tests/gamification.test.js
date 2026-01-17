/**
 * Gamification System Integration Tests
 * 
 * Run with: npm test -- tests/gamification.test.js
 * Or: node tests/gamification.test.js (for quick validation)
 */

const mongoose = require('mongoose');
require('dotenv').config();

// Models
const User = require('../models/User');
const UserPoints = require('../models/UserPoints');
const Badge = require('../models/Badge');
const Level = require('../models/Level');
const PointsHistory = require('../models/PointsHistory');

// Services
const PointsService = require('../services/pointsService');
const { POINT_VALUES } = require('../config/pointsConfig');

// Test data
const TEST_USER_ID = 'test-user-' + Date.now();
const TEST_USER_EMAIL = `test-${Date.now()}@example.com`;

// Simple test framework
let passedTests = 0;
let failedTests = 0;

function assert(condition, message) {
    if (condition) {
        console.log(`  ✅ ${message}`);
        passedTests++;
    } else {
        console.log(`  ❌ ${message}`);
        failedTests++;
    }
}

async function assertEqual(actual, expected, message) {
    if (actual === expected) {
        console.log(`  ✅ ${message}`);
        passedTests++;
    } else {
        console.log(`  ❌ ${message} - Expected: ${expected}, Got: ${actual}`);
        failedTests++;
    }
}

async function assertExists(value, message) {
    if (value !== null && value !== undefined) {
        console.log(`  ✅ ${message}`);
        passedTests++;
    } else {
        console.log(`  ❌ ${message} - Value is null or undefined`);
        failedTests++;
    }
}

// ============================================
// TEST SUITES
// ============================================

async function testPointsConfig() {
    console.log('\n📋 Testing Points Configuration...');

    assert(POINT_VALUES.ARTICLE_READ > 0, 'ARTICLE_READ should be positive');
    assert(POINT_VALUES.ARTICLE_LIKE > 0, 'ARTICLE_LIKE should be positive');
    assert(POINT_VALUES.ARTICLE_SHARE > 0, 'ARTICLE_SHARE should be positive');
    assert(POINT_VALUES.ARTICLE_SAVE > 0, 'ARTICLE_SAVE should be positive');
    assert(POINT_VALUES.COMMENT_POST > 0, 'COMMENT_POST should be positive');
    assert(POINT_VALUES.DAILY_STREAK_BONUS > 0, 'DAILY_STREAK_BONUS should be positive');
    assert(POINT_VALUES.FIRST_READ_OF_DAY > 0, 'FIRST_READ_OF_DAY should be positive');
    assert(POINT_VALUES.REFERRAL_SIGNUP > 0, 'REFERRAL_SIGNUP should be positive');
    assert(POINT_VALUES.REFERRAL_ACTIVE > 0, 'REFERRAL_ACTIVE should be positive');
}

async function testUserCreation() {
    console.log('\n👤 Testing User & Points Profile Creation...');

    // Create test user
    const user = await User.create({
        supabase_id: TEST_USER_ID,
        email: TEST_USER_EMAIL,
        name: 'Test User',
    });

    assertExists(user, 'User should be created');
    await assertEqual(user.supabase_id, TEST_USER_ID, 'User ID should match');

    // Award initial points to create profile
    const result = await PointsService.awardPoints(TEST_USER_ID, 'ARTICLE_READ', {
        articleId: 'test-article-1'
    });

    assertExists(result, 'Points award result should exist');
    assert(result.pointsAwarded === POINT_VALUES.ARTICLE_READ, `Should award ${POINT_VALUES.ARTICLE_READ} points for reading`);

    // Verify UserPoints profile was created
    const userPoints = await UserPoints.findOne({ userId: TEST_USER_ID });
    assertExists(userPoints, 'UserPoints profile should be created');
    assert(userPoints.totalPoints >= POINT_VALUES.ARTICLE_READ, 'Total points should include article read points');
    assert(userPoints.stats.articlesRead === 1, 'articlesRead stat should be 1');
}

async function testPointsAwarding() {
    console.log('\n🎯 Testing Points Awarding...');

    // Get initial points
    const initialProfile = await UserPoints.findOne({ userId: TEST_USER_ID });
    const initialPoints = initialProfile.totalPoints;

    // Test like action
    const likeResult = await PointsService.awardPoints(TEST_USER_ID, 'ARTICLE_LIKE', {
        articleId: 'test-article-2'
    });

    assertExists(likeResult, 'Like points result should exist');
    await assertEqual(likeResult.pointsAwarded, POINT_VALUES.ARTICLE_LIKE, 'Should award correct points for like');

    // Test save action
    const saveResult = await PointsService.awardPoints(TEST_USER_ID, 'ARTICLE_SAVE', {
        articleId: 'test-article-3'
    });

    assertExists(saveResult, 'Save points result should exist');
    await assertEqual(saveResult.pointsAwarded, POINT_VALUES.ARTICLE_SAVE, 'Should award correct points for save');

    // Verify total points increased
    const updatedProfile = await UserPoints.findOne({ userId: TEST_USER_ID });
    const expectedPoints = initialPoints + POINT_VALUES.ARTICLE_LIKE + POINT_VALUES.ARTICLE_SAVE;
    assert(updatedProfile.totalPoints >= expectedPoints, 'Total points should increase after actions');
}

async function testDuplicatePrevention() {
    console.log('\n🚫 Testing Duplicate Points Prevention...');

    const uniqueArticleId = 'unique-test-article-' + Date.now();

    // First read
    const firstResult = await PointsService.awardPoints(TEST_USER_ID, 'ARTICLE_READ', {
        articleId: uniqueArticleId
    });

    assert(firstResult.pointsAwarded > 0, 'First read should award points');

    // Duplicate read - should be prevented
    const duplicateResult = await PointsService.awardPoints(TEST_USER_ID, 'ARTICLE_READ', {
        articleId: uniqueArticleId
    });

    await assertEqual(duplicateResult.pointsAwarded, 0, 'Duplicate read should NOT award points');
    assert(duplicateResult.reason?.includes('already') || duplicateResult.duplicate === true,
        'Should indicate duplicate action');
}

async function testLevelProgression() {
    console.log('\n📈 Testing Level Progression...');

    // Get current level info
    const profile = await UserPoints.findOne({ userId: TEST_USER_ID });
    assertExists(profile, 'Profile should exist');
    assertExists(profile.level, 'Level should exist');

    // Get level details
    const levelInfo = await PointsService.getLevelInfo(TEST_USER_ID);
    assertExists(levelInfo, 'Level info should exist');
    assertExists(levelInfo.currentLevel, 'Current level should exist');
    assertExists(levelInfo.nextLevel, 'Next level info should exist');
    assert(levelInfo.progressToNextLevel >= 0 && levelInfo.progressToNextLevel <= 100,
        'Progress should be between 0 and 100');
}

async function testStreakSystem() {
    console.log('\n🔥 Testing Streak System...');

    const profile = await UserPoints.findOne({ userId: TEST_USER_ID });
    assertExists(profile, 'Profile should exist');
    assertExists(profile.currentStreak, 'currentStreak should exist');
    assertExists(profile.longestStreak, 'longestStreak should exist');
    assertExists(profile.lastActivityDate, 'lastActivityDate should exist');

    // Test streak update
    const streakResult = await PointsService.updateStreak(TEST_USER_ID);
    assertExists(streakResult, 'Streak update result should exist');
    assert(typeof streakResult.streak === 'number', 'Streak should be a number');
}

async function testBadgeSystem() {
    console.log('\n🏆 Testing Badge System...');

    // Check badges exist in database
    const badgeCount = await Badge.countDocuments();
    assert(badgeCount > 0, 'Badges should be seeded in database');

    // Check for specific badge types
    const articleBadges = await Badge.find({ category: 'reading' });
    assert(articleBadges.length > 0, 'Reading badges should exist');

    const engagementBadges = await Badge.find({ category: 'engagement' });
    assert(engagementBadges.length > 0, 'Engagement badges should exist');

    // Test badge checking
    const badgeResult = await PointsService.checkAndAwardBadges(TEST_USER_ID);
    assertExists(badgeResult, 'Badge check result should exist');
    assert(Array.isArray(badgeResult.newBadges), 'newBadges should be an array');
}

async function testPointsHistory() {
    console.log('\n📜 Testing Points History...');

    const history = await PointsHistory.find({ userId: TEST_USER_ID })
        .sort({ createdAt: -1 })
        .limit(10);

    assert(history.length > 0, 'Points history should have entries');

    const entry = history[0];
    assertExists(entry.actionType, 'History entry should have actionType');
    assertExists(entry.points, 'History entry should have points');
    assertExists(entry.createdAt, 'History entry should have createdAt');
}

async function testLeaderboard() {
    console.log('\n🏅 Testing Leaderboard...');

    const leaderboard = await PointsService.getLeaderboard('daily', 10);
    assertExists(leaderboard, 'Leaderboard should exist');
    assert(Array.isArray(leaderboard), 'Leaderboard should be an array');

    // Weekly leaderboard
    const weeklyLeaderboard = await PointsService.getLeaderboard('weekly', 10);
    assertExists(weeklyLeaderboard, 'Weekly leaderboard should exist');

    // All-time leaderboard
    const allTimeLeaderboard = await PointsService.getLeaderboard('allTime', 10);
    assertExists(allTimeLeaderboard, 'All-time leaderboard should exist');
}

async function testReferralSystem() {
    console.log('\n🔗 Testing Referral System...');

    // Update user with referral code
    const user = await User.findOne({ supabase_id: TEST_USER_ID });
    assertExists(user, 'Test user should exist');

    // Generate referral code
    const referralCode = 'TEST' + Date.now().toString().slice(-4);
    user.referralCode = referralCode;
    await user.save();

    // Verify referral code saved
    const updatedUser = await User.findOne({ supabase_id: TEST_USER_ID });
    await assertEqual(updatedUser.referralCode, referralCode, 'Referral code should be saved');

    // Test referral fields exist
    assertExists(typeof updatedUser.referralActivated === 'boolean', 'referralActivated field should exist');

    // Test referral code lookup
    const foundByCode = await User.findOne({ referralCode: referralCode });
    assertExists(foundByCode, 'User should be findable by referral code');
    await assertEqual(foundByCode.supabase_id, TEST_USER_ID, 'Found user should match test user');
}

async function testShareTracking() {
    console.log('\n📤 Testing Share Tracking...');

    // Get initial profile
    const initialProfile = await UserPoints.findOne({ userId: TEST_USER_ID });
    const initialShares = initialProfile?.stats?.sharesCount || 0;
    const initialPoints = initialProfile?.totalPoints || 0;

    // Award share points
    const shareResult = await PointsService.awardPoints(TEST_USER_ID, 'ARTICLE_SHARE', {
        articleId: 'test-article-share-' + Date.now(),
        platform: 'twitter'
    });

    assertExists(shareResult, 'Share points result should exist');
    assert(shareResult.pointsAwarded === POINT_VALUES.ARTICLE_SHARE,
        `Should award ${POINT_VALUES.ARTICLE_SHARE} points for article share`);

    // Verify stats updated
    const updatedProfile = await UserPoints.findOne({ userId: TEST_USER_ID });
    assert(updatedProfile.stats.sharesCount > initialShares, 'sharesCount should increase');
    assert(updatedProfile.totalPoints > initialPoints, 'Total points should increase after share');

    // Test reel share
    const reelShareResult = await PointsService.awardPoints(TEST_USER_ID, 'REEL_SHARE', {
        reelId: 'test-reel-share-' + Date.now(),
        platform: 'whatsapp'
    });

    assertExists(reelShareResult, 'Reel share points result should exist');
    assert(reelShareResult.pointsAwarded === POINT_VALUES.REEL_SHARE,
        `Should award ${POINT_VALUES.REEL_SHARE} points for reel share`);
}

async function testReferralPointsAwarding() {
    console.log('\n👥 Testing Referral Points Awarding...');

    // Create a second test user (referrer)
    const referrerId = 'test-referrer-' + Date.now();
    const referrer = await User.create({
        supabase_id: referrerId,
        email: `referrer-${Date.now()}@example.com`,
        name: 'Test Referrer',
        referralCode: 'REF' + Date.now().toString().slice(-4)
    });

    assertExists(referrer, 'Referrer user should be created');

    // Award referral signup points
    const signupResult = await PointsService.awardPoints(referrerId, 'REFERRAL_SIGNUP', {
        referredUserId: TEST_USER_ID,
        description: 'New user signed up with referral code'
    });

    assertExists(signupResult, 'Referral signup points result should exist');
    assert(signupResult.pointsAwarded === POINT_VALUES.REFERRAL_SIGNUP,
        `Should award ${POINT_VALUES.REFERRAL_SIGNUP} points for referral signup`);

    // Award referral active points
    const activeResult = await PointsService.awardPoints(referrerId, 'REFERRAL_ACTIVE', {
        referredUserId: TEST_USER_ID,
        description: 'Referred user became active'
    });

    assertExists(activeResult, 'Referral active points result should exist');
    assert(activeResult.pointsAwarded === POINT_VALUES.REFERRAL_ACTIVE,
        `Should award ${POINT_VALUES.REFERRAL_ACTIVE} points for active referral`);

    // Verify referrer's stats updated
    const referrerProfile = await UserPoints.findOne({ userId: referrerId });
    assertExists(referrerProfile, 'Referrer profile should exist');
    assert(referrerProfile.stats.referralsCount >= 1, 'Referrer should have referral count updated');

    // Cleanup referrer
    await User.deleteOne({ supabase_id: referrerId });
    await UserPoints.deleteOne({ userId: referrerId });
    await PointsHistory.deleteMany({ userId: referrerId });
}

async function testStatistics() {
    console.log('\n📊 Testing Statistics...');

    const profile = await UserPoints.findOne({ userId: TEST_USER_ID });
    assertExists(profile, 'Profile should exist');
    assertExists(profile.stats, 'Stats should exist');

    assert(typeof profile.stats.articlesRead === 'number', 'articlesRead should be a number');
    assert(typeof profile.stats.articlesLiked === 'number', 'articlesLiked should be a number');
    assert(typeof profile.stats.articlesSaved === 'number', 'articlesSaved should be a number');
    assert(typeof profile.stats.commentsPosted === 'number', 'commentsPosted should be a number');
    assert(typeof profile.stats.sharesCount === 'number', 'sharesCount should be a number');
    assert(typeof profile.stats.referralsCount === 'number', 'referralsCount should be a number');
}

// ============================================
// TEST RUNNER
// ============================================

async function cleanup() {
    console.log('\n🧹 Cleaning up test data...');

    try {
        await User.deleteOne({ supabase_id: TEST_USER_ID });
        await UserPoints.deleteOne({ userId: TEST_USER_ID });
        await PointsHistory.deleteMany({ userId: TEST_USER_ID });
        console.log('  ✅ Test data cleaned up');
    } catch (error) {
        console.log('  ⚠️ Cleanup error:', error.message);
    }
}

async function runTests() {
    console.log('🎮 Gamification System Integration Tests');
    console.log('=========================================');

    try {
        // Connect to MongoDB
        console.log('\n🔌 Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGO_URI);
        console.log('  ✅ Connected to MongoDB');

        // Run test suites
        await testPointsConfig();
        await testUserCreation();
        await testPointsAwarding();
        await testDuplicatePrevention();
        await testLevelProgression();
        await testStreakSystem();
        await testBadgeSystem();
        await testPointsHistory();
        await testLeaderboard();
        await testReferralSystem();
        await testShareTracking();
        await testReferralPointsAwarding();
        await testStatistics();

        // Cleanup
        await cleanup();

    } catch (error) {
        console.error('\n❌ Test suite error:', error);
        failedTests++;
    } finally {
        // Print results
        console.log('\n=========================================');
        console.log(`📊 Test Results: ${passedTests} passed, ${failedTests} failed`);
        console.log('=========================================');

        // Disconnect
        await mongoose.disconnect();
        console.log('\n🔌 Disconnected from MongoDB');

        // Exit with appropriate code
        process.exit(failedTests > 0 ? 1 : 0);
    }
}

// Run tests
runTests();
