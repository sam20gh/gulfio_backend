/**
 * 🎮 Badge Seeding Script
 * Run this to populate the initial badge definitions
 * 
 * Usage: node scripts/seedBadges.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Badge = require('../models/Badge');

const MONGO_URI = process.env.MONGO_URI;

const badges = [
    // ==================== READING BADGES ====================
    {
        name: 'First Read',
        nameAr: 'القراءة الأولى',
        description: 'Read your first article',
        descriptionAr: 'اقرأ مقالك الأول',
        icon: 'book-open',
        category: 'reading',
        tier: 'bronze',
        requirement: { type: 'articles_read', value: 1 },
        pointsAwarded: 10,
        sortOrder: 1
    },
    {
        name: 'Curious Mind',
        nameAr: 'عقل فضولي',
        description: 'Read 10 articles',
        descriptionAr: 'اقرأ 10 مقالات',
        icon: 'book',
        category: 'reading',
        tier: 'bronze',
        requirement: { type: 'articles_read', value: 10 },
        pointsAwarded: 25,
        sortOrder: 2
    },
    {
        name: 'Bookworm',
        nameAr: 'دودة الكتب',
        description: 'Read 50 articles',
        descriptionAr: 'اقرأ 50 مقالة',
        icon: 'book-multiple',
        category: 'reading',
        tier: 'silver',
        requirement: { type: 'articles_read', value: 50 },
        pointsAwarded: 50,
        sortOrder: 3
    },
    {
        name: 'News Enthusiast',
        nameAr: 'عاشق الأخبار',
        description: 'Read 200 articles',
        descriptionAr: 'اقرأ 200 مقالة',
        icon: 'newspaper',
        category: 'reading',
        tier: 'gold',
        requirement: { type: 'articles_read', value: 200 },
        pointsAwarded: 100,
        sortOrder: 4
    },
    {
        name: 'Knowledge Seeker',
        nameAr: 'باحث عن المعرفة',
        description: 'Read 500 articles',
        descriptionAr: 'اقرأ 500 مقالة',
        icon: 'school',
        category: 'reading',
        tier: 'platinum',
        requirement: { type: 'articles_read', value: 500 },
        pointsAwarded: 250,
        sortOrder: 5
    },
    {
        name: 'Information Titan',
        nameAr: 'عملاق المعلومات',
        description: 'Read 1000 articles',
        descriptionAr: 'اقرأ 1000 مقالة',
        icon: 'trophy',
        category: 'reading',
        tier: 'diamond',
        requirement: { type: 'articles_read', value: 1000 },
        pointsAwarded: 500,
        sortOrder: 6
    },

    // ==================== ENGAGEMENT BADGES ====================
    {
        name: 'First Like',
        nameAr: 'الإعجاب الأول',
        description: 'Like your first article',
        descriptionAr: 'أعجب بمقالك الأول',
        icon: 'heart',
        color: '#E91E63',
        category: 'engagement',
        tier: 'bronze',
        requirement: { type: 'articles_liked', value: 1 },
        pointsAwarded: 5,
        sortOrder: 10
    },
    {
        name: 'Appreciator',
        nameAr: 'المقدّر',
        description: 'Like 25 articles',
        descriptionAr: 'أعجب بـ 25 مقالة',
        icon: 'heart-multiple',
        color: '#E91E63',
        category: 'engagement',
        tier: 'silver',
        requirement: { type: 'articles_liked', value: 25 },
        pointsAwarded: 30,
        sortOrder: 11
    },
    {
        name: 'Super Fan',
        nameAr: 'المعجب الكبير',
        description: 'Like 100 articles',
        descriptionAr: 'أعجب بـ 100 مقالة',
        icon: 'heart-circle',
        color: '#E91E63',
        category: 'engagement',
        tier: 'gold',
        requirement: { type: 'articles_liked', value: 100 },
        pointsAwarded: 75,
        sortOrder: 12
    },
    {
        name: 'Dedicated Reader',
        nameAr: 'القارئ المخلص',
        description: 'Like 500 articles',
        descriptionAr: 'أعجب بـ 500 مقالة',
        icon: 'star-circle',
        color: '#E91E63',
        category: 'engagement',
        tier: 'diamond',
        requirement: { type: 'articles_liked', value: 500 },
        pointsAwarded: 200,
        sortOrder: 13
    },

    // ==================== SOCIAL BADGES ====================
    {
        name: 'Voice Heard',
        nameAr: 'صوت مسموع',
        description: 'Post your first comment',
        descriptionAr: 'انشر تعليقك الأول',
        icon: 'comment',
        color: '#2196F3',
        category: 'social',
        tier: 'bronze',
        requirement: { type: 'comments_posted', value: 1 },
        pointsAwarded: 15,
        sortOrder: 20
    },
    {
        name: 'Conversationalist',
        nameAr: 'محاور',
        description: 'Post 10 comments',
        descriptionAr: 'انشر 10 تعليقات',
        icon: 'comment-multiple',
        color: '#2196F3',
        category: 'social',
        tier: 'bronze',
        requirement: { type: 'comments_posted', value: 10 },
        pointsAwarded: 30,
        sortOrder: 21
    },
    {
        name: 'Discussion Leader',
        nameAr: 'قائد النقاش',
        description: 'Post 50 comments',
        descriptionAr: 'انشر 50 تعليقاً',
        icon: 'forum',
        color: '#2196F3',
        category: 'social',
        tier: 'gold',
        requirement: { type: 'comments_posted', value: 50 },
        pointsAwarded: 100,
        sortOrder: 22
    },
    {
        name: 'Top Commenter',
        nameAr: 'أفضل معلق',
        description: 'Post 200 comments',
        descriptionAr: 'انشر 200 تعليق',
        icon: 'message-star',
        color: '#2196F3',
        category: 'social',
        tier: 'platinum',
        requirement: { type: 'comments_posted', value: 200 },
        pointsAwarded: 200,
        sortOrder: 23
    },
    {
        name: 'Thought Leader',
        nameAr: 'قائد فكري',
        description: 'Receive 50 likes on your comments',
        descriptionAr: 'احصل على 50 إعجاب على تعليقاتك',
        icon: 'lightbulb',
        color: '#FF9800',
        category: 'social',
        tier: 'gold',
        requirement: { type: 'comments_liked', value: 50 },
        pointsAwarded: 100,
        sortOrder: 24
    },
    {
        name: 'Influential Voice',
        nameAr: 'صوت مؤثر',
        description: 'Receive 200 likes on your comments',
        descriptionAr: 'احصل على 200 إعجاب على تعليقاتك',
        icon: 'star',
        color: '#FF9800',
        category: 'social',
        tier: 'diamond',
        requirement: { type: 'comments_liked', value: 200 },
        pointsAwarded: 300,
        sortOrder: 25
    },

    // ==================== STREAK BADGES ====================
    {
        name: 'Getting Started',
        nameAr: 'بداية جيدة',
        description: '3-day reading streak',
        descriptionAr: 'سلسلة قراءة لمدة 3 أيام',
        icon: 'fire',
        color: '#FF5722',
        category: 'streak',
        tier: 'bronze',
        requirement: { type: 'streak_days', value: 3 },
        pointsAwarded: 20,
        sortOrder: 30
    },
    {
        name: 'Daily Reader',
        nameAr: 'القارئ اليومي',
        description: '7-day reading streak',
        descriptionAr: 'سلسلة قراءة لمدة 7 أيام',
        icon: 'fire',
        color: '#FF5722',
        category: 'streak',
        tier: 'silver',
        requirement: { type: 'streak_days', value: 7 },
        pointsAwarded: 50,
        sortOrder: 31
    },
    {
        name: 'Dedicated',
        nameAr: 'متفانٍ',
        description: '14-day reading streak',
        descriptionAr: 'سلسلة قراءة لمدة 14 يوماً',
        icon: 'flame',
        color: '#FF5722',
        category: 'streak',
        tier: 'gold',
        requirement: { type: 'streak_days', value: 14 },
        pointsAwarded: 100,
        sortOrder: 32
    },
    {
        name: 'Consistent',
        nameAr: 'ثابت',
        description: '30-day reading streak',
        descriptionAr: 'سلسلة قراءة لمدة 30 يوماً',
        icon: 'calendar-check',
        color: '#FF5722',
        category: 'streak',
        tier: 'platinum',
        requirement: { type: 'streak_days', value: 30 },
        pointsAwarded: 200,
        sortOrder: 33
    },
    {
        name: 'Unstoppable',
        nameAr: 'لا يمكن إيقافه',
        description: '100-day reading streak',
        descriptionAr: 'سلسلة قراءة لمدة 100 يوم',
        icon: 'meteor',
        color: '#FF5722',
        category: 'streak',
        tier: 'diamond',
        requirement: { type: 'streak_days', value: 100 },
        pointsAwarded: 1000,
        sortOrder: 34
    },

    // ==================== CATEGORY EXPERT BADGES ====================
    {
        name: 'Football Fanatic',
        nameAr: 'مهووس كرة القدم',
        description: 'Read 50 football articles',
        descriptionAr: 'اقرأ 50 مقالة عن كرة القدم',
        icon: 'soccer',
        color: '#4CAF50',
        category: 'category_expert',
        tier: 'gold',
        requirement: { type: 'category_articles', value: 50, category: 'football' },
        pointsAwarded: 75,
        sortOrder: 40
    },
    {
        name: 'Business Insider',
        nameAr: 'خبير الأعمال',
        description: 'Read 50 business articles',
        descriptionAr: 'اقرأ 50 مقالة عن الأعمال',
        icon: 'briefcase',
        color: '#3F51B5',
        category: 'category_expert',
        tier: 'gold',
        requirement: { type: 'category_articles', value: 50, category: 'business' },
        pointsAwarded: 75,
        sortOrder: 41
    },
    {
        name: 'Tech Guru',
        nameAr: 'خبير التقنية',
        description: 'Read 50 technology articles',
        descriptionAr: 'اقرأ 50 مقالة عن التقنية',
        icon: 'chip',
        color: '#9C27B0',
        category: 'category_expert',
        tier: 'gold',
        requirement: { type: 'category_articles', value: 50, category: 'technology' },
        pointsAwarded: 75,
        sortOrder: 42
    },
    {
        name: 'Entertainment Expert',
        nameAr: 'خبير الترفيه',
        description: 'Read 50 entertainment articles',
        descriptionAr: 'اقرأ 50 مقالة عن الترفيه',
        icon: 'movie',
        color: '#E91E63',
        category: 'category_expert',
        tier: 'gold',
        requirement: { type: 'category_articles', value: 50, category: 'entertainment' },
        pointsAwarded: 75,
        sortOrder: 43
    },
    {
        name: 'Politics Pundit',
        nameAr: 'خبير السياسة',
        description: 'Read 50 politics articles',
        descriptionAr: 'اقرأ 50 مقالة عن السياسة',
        icon: 'gavel',
        color: '#607D8B',
        category: 'category_expert',
        tier: 'gold',
        requirement: { type: 'category_articles', value: 50, category: 'politics' },
        pointsAwarded: 75,
        sortOrder: 44
    },

    // ==================== SPECIAL / LEVEL BADGES ====================
    {
        name: 'Rising Star',
        nameAr: 'نجم صاعد',
        description: 'Reach Level 3',
        descriptionAr: 'وصل إلى المستوى 3',
        icon: 'star-rising',
        color: '#FFC107',
        category: 'special',
        tier: 'bronze',
        requirement: { type: 'level', value: 3 },
        pointsAwarded: 50,
        sortOrder: 50
    },
    {
        name: 'Established',
        nameAr: 'مستقر',
        description: 'Reach Level 5',
        descriptionAr: 'وصل إلى المستوى 5',
        icon: 'medal',
        color: '#FFC107',
        category: 'special',
        tier: 'silver',
        requirement: { type: 'level', value: 5 },
        pointsAwarded: 100,
        sortOrder: 51
    },
    {
        name: 'Veteran',
        nameAr: 'محترف',
        description: 'Reach Level 7',
        descriptionAr: 'وصل إلى المستوى 7',
        icon: 'shield-star',
        color: '#FFC107',
        category: 'special',
        tier: 'gold',
        requirement: { type: 'level', value: 7 },
        pointsAwarded: 200,
        sortOrder: 52
    },
    {
        name: 'Legend',
        nameAr: 'أسطورة',
        description: 'Reach Level 10 (Max Level)',
        descriptionAr: 'وصل إلى المستوى 10 (الحد الأقصى)',
        icon: 'crown',
        color: '#FFC107',
        category: 'special',
        tier: 'diamond',
        requirement: { type: 'level', value: 10 },
        pointsAwarded: 500,
        sortOrder: 53
    },
    {
        name: 'Point Collector',
        nameAr: 'جامع النقاط',
        description: 'Earn 1000 lifetime points',
        descriptionAr: 'اكسب 1000 نقطة إجمالية',
        icon: 'cash-multiple',
        color: '#4CAF50',
        category: 'special',
        tier: 'silver',
        requirement: { type: 'total_points', value: 1000 },
        pointsAwarded: 50,
        sortOrder: 54
    },
    {
        name: 'Point Master',
        nameAr: 'سيد النقاط',
        description: 'Earn 10000 lifetime points',
        descriptionAr: 'اكسب 10000 نقطة إجمالية',
        icon: 'cash-star',
        color: '#4CAF50',
        category: 'special',
        tier: 'platinum',
        requirement: { type: 'total_points', value: 10000 },
        pointsAwarded: 250,
        sortOrder: 55
    },
    {
        name: 'Loyal User',
        nameAr: 'مستخدم وفي',
        description: 'Log in for 30 different days',
        descriptionAr: 'سجل الدخول لمدة 30 يوم مختلف',
        icon: 'calendar-heart',
        color: '#E91E63',
        category: 'special',
        tier: 'gold',
        requirement: { type: 'daily_logins', value: 30 },
        pointsAwarded: 100,
        sortOrder: 56
    },
    {
        name: 'News Veteran',
        nameAr: 'محارب الأخبار',
        description: 'Log in for 100 different days',
        descriptionAr: 'سجل الدخول لمدة 100 يوم مختلف',
        icon: 'calendar-star',
        color: '#E91E63',
        category: 'special',
        tier: 'diamond',
        requirement: { type: 'daily_logins', value: 100 },
        pointsAwarded: 300,
        sortOrder: 57
    },
];

async function seedBadges() {
    try {
        console.log('🔌 Connecting to MongoDB...');
        await mongoose.connect(MONGO_URI);
        console.log('✅ Connected to MongoDB');

        console.log('🗑️  Clearing existing badges...');
        await Badge.deleteMany({});

        console.log('🌱 Seeding badges...');
        const result = await Badge.insertMany(badges);

        console.log(`✅ Successfully seeded ${result.length} badges!`);

        // Log summary by category
        const summary = {};
        badges.forEach(b => {
            summary[b.category] = (summary[b.category] || 0) + 1;
        });
        console.log('\n📊 Badge Summary:');
        Object.entries(summary).forEach(([cat, count]) => {
            console.log(`   ${cat}: ${count} badges`);
        });

        console.log('\n🎮 Gamification badges ready!');

    } catch (error) {
        console.error('❌ Error seeding badges:', error);
    } finally {
        await mongoose.disconnect();
        console.log('🔌 Disconnected from MongoDB');
    }
}

// Run if called directly
if (require.main === module) {
    seedBadges();
}

module.exports = { badges, seedBadges };
