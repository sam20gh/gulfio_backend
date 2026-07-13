/**
 * Seed synthetic engagement (views / likes / emoji comments) on recent
 * articles and reels so the app looks alive pre-launch.
 *
 * Design constraints:
 *  - Writes go straight to Mongo, bypassing the API routes — so bots never
 *    earn gamification points, never appear on leaderboards, and never
 *    trigger notifications or embedding updates.
 *  - Every bot User doc has isSynthetic: true and supabase_id prefixed
 *    "synthetic_bot_" so all activity is identifiable and purgeable.
 *  - Numbers stay plausible: skewed random views, 0–5 likes with ~1/3 of
 *    items getting none, emoji-only comments on a small fraction of items,
 *    max one synthetic comment thread per item per bot.
 *  - Idempotent per item: likes use $addToSet against likedBy, comments are
 *    skipped for items a bot already commented on. Views are additive by
 *    design (a daily trickle on recent content is the realistic shape).
 *
 * Usage:
 *   node scripts/seedSyntheticEngagement.js             # seed last 36h of content
 *   node scripts/seedSyntheticEngagement.js --dry-run   # print plan, write nothing
 *   node scripts/seedSyntheticEngagement.js --hours 72  # widen the content window
 *   node scripts/seedSyntheticEngagement.js --purge     # remove ALL synthetic likes/comments/users
 *
 * Run daily (crontab example, 9:15am local):
 *   15 9 * * * cd /Users/sam/Desktop/gulfio/backend && /usr/bin/env node scripts/seedSyntheticEngagement.js >> /tmp/gulfio-seed.log 2>&1
 */

const mongoose = require('mongoose');
require('dotenv').config();

const Article = require('../models/Article');
const Reel = require('../models/Reel');
const Comment = require('../models/Comment');
const User = require('../models/User');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const PURGE = args.includes('--purge');
const hoursIdx = args.indexOf('--hours');
const HOURS_BACK = hoursIdx !== -1 ? Number(args[hoursIdx + 1]) || 36 : 36;

const BOT_PREFIX = 'synthetic_bot_';

// 15 bots: Gulf-flavoured names, mixed Arabic/English to match the audience.
// Avatar left empty for some (default avatar) and initials-style for others,
// mirroring what a real early user base looks like.
const BOT_PROFILES = [
    { n: 'Ahmed K.', a: true }, { n: 'فاطمة', a: false }, { n: 'Omar', a: true },
    { n: 'Sara M.', a: true }, { n: 'خالد', a: false }, { n: 'Layla', a: true },
    { n: 'Mohammed A.', a: false }, { n: 'نورة', a: true }, { n: 'Hassan', a: false },
    { n: 'Reem', a: true }, { n: 'عبدالله', a: false }, { n: 'Dana', a: true },
    { n: 'Yousef', a: false }, { n: 'مريم', a: true }, { n: 'Ali R.', a: false },
];

const AVATAR_COLORS = ['ff007b', '1e1e1e', '4a4a4a', '7a1fa2', '00695c', 'bf360c'];

// Emoji-only comment pool. Neutral reactions that work on any story in
// either language. No text, per product decision.
const EMOJI_COMMENTS = [
    '❤️', '🔥', '🔥🔥', '👏', '👏👏👏', '💯', '😍', '👍', '🙌', '✨',
    '❤️❤️', '😮', '⚡', '🔥❤️', '👌', '💪', '🤲', '🌟',
];
// Football/sports-leaning reactions, used when the category looks sporty.
const SPORT_EMOJI = ['⚽🔥', '⚽', '🏆', '⚽👏', '🐐', '💪⚽', '🔥⚽🔥'];

// Per-run caps — a safety net so a wide --hours window can't flood the app.
const MAX_COMMENTS_PER_RUN = 25;
const MAX_LIKED_ITEMS_PER_RUN = 120;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const chance = (p) => Math.random() < p;

// Skewed views: most items get a small trickle, a few get "hot" numbers.
function viewBump() {
    const heat = Math.random() ** 2.2; // heavy skew toward 0
    return Math.round(6 + heat * 110); // 6–116, mostly 6–25
}

function pickBots(botIds, max) {
    const shuffled = [...botIds].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, rand(1, max));
}

function isSporty(category) {
    return /sport|football|soccer|match|كرة|رياضة/i.test(category || '');
}

function emojiFor(category) {
    return isSporty(category) && chance(0.7) ? pick(SPORT_EMOJI) : pick(EMOJI_COMMENTS);
}

// Spread createdAt over the past few hours so comments don't all share one
// timestamp when the script runs.
function jitteredDate(maxHoursAgo = 6) {
    return new Date(Date.now() - rand(5, maxHoursAgo * 60) * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Bot users
// ---------------------------------------------------------------------------

async function ensureBots() {
    const ops = BOT_PROFILES.map((p, i) => {
        const id = `${BOT_PREFIX}${String(i + 1).padStart(2, '0')}`;
        const avatar = p.a
            ? `https://ui-avatars.com/api/?name=${encodeURIComponent(p.n)}&background=${AVATAR_COLORS[i % AVATAR_COLORS.length]}&color=fff&size=128`
            : '';
        return {
            updateOne: {
                filter: { supabase_id: id },
                update: {
                    $setOnInsert: {
                        supabase_id: id,
                        email: `${id}@synthetic.gulfio.internal`,
                        name: p.n,
                        profile_image: avatar,
                        isSynthetic: true,
                        type: 'user',
                    },
                },
                upsert: true,
            },
        };
    });
    if (!DRY_RUN) await User.bulkWrite(ops, { ordered: false });
    const bots = await User.find({ isSynthetic: true }).select('supabase_id name').lean();
    // In dry-run on a fresh DB there may be no bots yet — synthesize for planning.
    if (!bots.length) {
        return BOT_PROFILES.map((p, i) => ({
            supabase_id: `${BOT_PREFIX}${String(i + 1).padStart(2, '0')}`,
            name: p.n,
        }));
    }
    return bots;
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

const stats = { items: 0, views: 0, likes: 0, comments: 0, saves: 0 };
let commentBudget = MAX_COMMENTS_PER_RUN;
let likeBudget = MAX_LIKED_ITEMS_PER_RUN;

async function seedCollection({ Model, kind, items, bots, botIds }) {
    if (!items.length) return;

    // One query: which of these items already have a synthetic comment?
    const itemIds = items.map((i) => String(i._id));
    const idField = kind === 'article' ? 'articleId' : 'reelId';
    const existing = await Comment.find({
        [idField]: { $in: itemIds },
        userId: { $in: botIds },
    }).select(idField).lean();
    const alreadyCommented = new Set(existing.map((c) => c[idField]));

    const commentDocs = [];

    for (const item of items) {
        stats.items++;
        const update = { $inc: {}, $addToSet: {} };

        // --- Views: every recent item gets a trickle ---
        const views = viewBump();
        update.$inc.viewCount = views;
        stats.views += views;

        // --- Likes: ~2/3 of items, 1–5 bots, respecting existing likedBy ---
        if (likeBudget > 0 && chance(0.65)) {
            const liked = new Set(item.likedBy || []);
            const newLikers = pickBots(botIds, 5).filter((b) => !liked.has(b));
            if (newLikers.length) {
                update.$addToSet.likedBy = { $each: newLikers };
                update.$inc.likes = newLikers.length;
                stats.likes += newLikers.length;
                likeBudget--;
            }
        }

        // --- Saves (reels only): occasional, makes the counters feel organic ---
        if (kind === 'reel' && chance(0.15)) {
            const saved = new Set(item.savedBy || []);
            const savers = pickBots(botIds, 2).filter((b) => !saved.has(b));
            if (savers.length) {
                update.$addToSet.savedBy = { $each: savers };
                update.$inc.saves = savers.length;
                stats.saves += savers.length;
            }
        }

        // --- Emoji comments: sparse, max 2 per item, once per item ever ---
        if (
            commentBudget > 0 &&
            !alreadyCommented.has(String(item._id)) &&
            chance(kind === 'article' ? 0.12 : 0.10)
        ) {
            const commenters = pickBots(botIds, 2);
            for (const botId of commenters) {
                const bot = bots.find((b) => b.supabase_id === botId);
                commentDocs.push({
                    [idField]: String(item._id),
                    userId: botId,
                    username: bot?.name || 'Gulfio user',
                    comment: emojiFor(item.category),
                    likedBy: [],
                    dislikedBy: [],
                    replies: [],
                    createdAt: jitteredDate(),
                });
            }
            if (kind === 'article') update.$inc.commentCount = commenters.length;
            stats.comments += commenters.length;
            commentBudget--;
        }

        if (!Object.keys(update.$addToSet).length) delete update.$addToSet;
        if (DRY_RUN) {
            console.log(`  [dry] ${kind} ${item._id}: ${JSON.stringify(update.$inc)}`);
        } else {
            await Model.updateOne({ _id: item._id }, update);
        }
    }

    if (commentDocs.length && !DRY_RUN) {
        await Comment.insertMany(commentDocs, { ordered: false });
    }
}

async function seed() {
    const bots = await ensureBots();
    const botIds = bots.map((b) => b.supabase_id);
    console.log(`🤖 ${bots.length} synthetic users ready`);

    const since = new Date(Date.now() - HOURS_BACK * 60 * 60 * 1000);

    const articles = await Article.find({ publishedAt: { $gte: since } })
        .select('likedBy category')
        .lean();
    const reels = await Reel.find({ scrapedAt: { $gte: since } })
        .select('likedBy savedBy categories')
        .lean();
    console.log(`📰 ${articles.length} articles, 🎬 ${reels.length} reels in the last ${HOURS_BACK}h`);

    await seedCollection({ Model: Article, kind: 'article', items: articles, bots, botIds });
    await seedCollection({
        Model: Reel,
        kind: 'reel',
        items: reels.map((r) => ({ ...r, category: (r.categories || [])[0] })),
        bots,
        botIds,
    });

    console.log(
        `${DRY_RUN ? '🧪 DRY RUN — would have added' : '✅ Seeded'}: ` +
        `${stats.views} views, ${stats.likes} likes, ${stats.comments} comments, ` +
        `${stats.saves} saves across ${stats.items} items`
    );
}

// ---------------------------------------------------------------------------
// Purge — undo everything synthetic (run once real users take over)
// ---------------------------------------------------------------------------

async function purge() {
    const bots = await User.find({ isSynthetic: true }).select('supabase_id').lean();
    const botIds = bots.map((b) => b.supabase_id);
    if (!botIds.length) {
        console.log('Nothing to purge — no synthetic users found.');
        return;
    }
    console.log(`🧹 Purging activity of ${botIds.length} synthetic users…`);
    if (DRY_RUN) {
        const c = await Comment.countDocuments({ userId: { $in: botIds } });
        const a = await Article.countDocuments({ likedBy: { $in: botIds } });
        const r = await Reel.countDocuments({ likedBy: { $in: botIds } });
        console.log(`🧪 DRY RUN — would remove ${c} comments, unlike ${a} articles, ${r} reels. Views are not reverted.`);
        return;
    }

    // Comments first, so we can decrement commentCount from the real counts.
    const grouped = await Comment.aggregate([
        { $match: { userId: { $in: botIds }, articleId: { $exists: true, $ne: null } } },
        { $group: { _id: '$articleId', count: { $sum: 1 } } },
    ]);
    const decOps = grouped
        .filter((g) => mongoose.Types.ObjectId.isValid(g._id))
        .map((g) => ({
            updateOne: {
                filter: { _id: new mongoose.Types.ObjectId(g._id) },
                update: [{ $set: { commentCount: { $max: [0, { $subtract: [{ $ifNull: ['$commentCount', 0] }, g.count] }] } } }],
            },
        }));
    if (decOps.length) await Article.bulkWrite(decOps, { ordered: false });
    const delComments = await Comment.deleteMany({ userId: { $in: botIds } });

    // Pipeline update: subtract exactly the bot likes present in each doc.
    const unlikePipeline = [{
        $set: {
            likes: { $max: [0, { $subtract: [{ $ifNull: ['$likes', 0] }, { $size: { $setIntersection: [{ $ifNull: ['$likedBy', []] }, botIds] } }] }] },
            likedBy: { $setDifference: [{ $ifNull: ['$likedBy', []] }, botIds] },
        },
    }];
    const artRes = await Article.updateMany({ likedBy: { $in: botIds } }, unlikePipeline);
    const reelRes = await Reel.updateMany({ likedBy: { $in: botIds } }, unlikePipeline);
    const saveRes = await Reel.updateMany({ savedBy: { $in: botIds } }, [{
        $set: {
            saves: { $max: [0, { $subtract: [{ $ifNull: ['$saves', 0] }, { $size: { $setIntersection: [{ $ifNull: ['$savedBy', []] }, botIds] } }] }] },
            savedBy: { $setDifference: [{ $ifNull: ['$savedBy', []] }, botIds] },
        },
    }]);

    const delUsers = await User.deleteMany({ isSynthetic: true });
    console.log(
        `✅ Purged: ${delComments.deletedCount} comments, ` +
        `${artRes.modifiedCount} articles + ${reelRes.modifiedCount} reels unliked, ` +
        `${saveRes.modifiedCount} reels unsaved, ${delUsers.deletedCount} users deleted. ` +
        `(View counts are left as-is.)`
    );
}

// ---------------------------------------------------------------------------

(async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('✅ Connected to Mongo');
        if (PURGE) await purge();
        else await seed();
        await mongoose.disconnect();
        process.exit(0);
    } catch (err) {
        console.error('❌ seedSyntheticEngagement failed:', err);
        process.exit(1);
    }
})();
