/**
 * 📄 Article API Routes
 * Personalized and generic article feeds with page-aware recency blending.
 */

const express = require('express');
const mongoose = require('mongoose');
const Article = require('../models/Article');
const User = require('../models/User');
const auth = require('../middleware/auth');
const ensureMongoUser = require('../middleware/ensureMongoUser');
const { redis } = require('../utils/redis');
const { getFaissIndexStatus, searchFaissIndex } = require('../recommendation/faissIndex');
const { getDeepSeekEmbedding } = require('../utils/deepseek');

const articleRouter = express.Router();

/** ---- Utilities ---- **/

// Engagement score: tune weights here if needed
const viewsWeight = 1.0;
const likesWeight = 3.0;
const dislikesWeight = -2.0;
const recencyWeight = 4.0;

function basicRecencyScore(publishedAt) {
    const now = Date.now();
    const t = new Date(publishedAt || Date.now()).getTime();
    const hours = (now - t) / (1000 * 60 * 60);
    if (hours <= 24) return 1.0;
    if (hours <= 48) return 0.8;
    if (hours <= 72) return 0.6;
    if (hours <= 168) return 0.4; // 7 days
    return Math.max(0, 1 - hours / (24 * 30)); // taper over ~30 days
}

function calculateEngagementScore(article) {
    const recencyScore = basicRecencyScore(article.publishedAt);
    return (
        (article.viewCount || 0) * viewsWeight +
        (article.likes || 0) * likesWeight +
        (article.dislikes || 0) * dislikesWeight +
        recencyScore * recencyWeight
    );
}

function cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        magA += a[i] * a[i];
        magB += b[i] * b[i];
    }
    return magA && magB ? dot / (Math.sqrt(magA) * Math.sqrt(magB)) : 0;
}

/** Clear all article caches (used after reacts) */
async function clearArticlesCache() {
    const keys = await redis.keys('articles_*');
    if (keys.length > 0) {
        await redis.del(keys);
        console.log('🧹 Cleared article caches:', keys);
    }
}

/** Recompute the user's profile embedding after an interaction */
async function updateUserProfileEmbedding(userMongoId) {
    try {
        const { updateUserProfileEmbedding: updateEmbedding } = require('../utils/userEmbedding');
        await updateEmbedding(userMongoId);
    } catch (e) {
        console.warn('Embedding refresh failed (non-fatal):', e.message);
    }
}/** Deterministic LCG for stable pseudo-randomness */
function lcg(seed) {
    let s = seed >>> 0;
    return () => ((s = (1103515245 * s + 12345) >>> 0) / 4294967296);
}

/** Simple hash function for seed generation */
function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash + str.charCodeAt(i)) & 0xffffffff;
    }
    return Math.abs(hash);
}

/** ---- Routes ---- **/

// GET: Personalized article recommendations (server-side ranking + recency mix)
articleRouter.get('/personalized', auth, ensureMongoUser, async (req, res) => {
    try {
        // Input validation and clamping
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(Math.max(1, parseInt(req.query.limit) || 20), 50);
        const language = req.query.language || 'english';
        const userId = req.mongoUser.supabase_id;
        const resetServed = req.query.resetServed === '1';

        // Day-based keys for non-repetition
        const dayKey = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const servedKey = `served_personalized_${userId}_${language}_${dayKey}`;
        const noveltySeed = simpleHash(`${userId}:${page}:${dayKey}`);

        console.log(`🎯 Fetching personalized articles for user ${userId}, page ${page}, limit ${limit}, language ${language}`);

        // Reset served articles if requested
        if (resetServed) {
            try {
                await redis.del(servedKey);
                console.log('🔄 Reset served articles for today');
            } catch (err) {
                console.error('⚠️ Failed to reset served articles:', err.message);
            }
        }

        // Enhanced cache key with day and novelty seed
        const cacheKey = `articles_personalized_${userId}_page_${page}_limit_${limit}_lang_${language}_${dayKey}_${noveltySeed}`;

        // Cache check
        let cached;
        try {
            cached = await redis.get(cacheKey);
        } catch (err) {
            console.error('⚠️ Redis get error (safe to ignore):', err.message);
        }
        if (!req.query.noCache && cached) {
            console.log('🧠 Returning cached personalized articles');
            return res.json(JSON.parse(cached));
        }

        // Get already served articles
        let servedIds = [];
        try {
            servedIds = await redis.smembers(servedKey);
            console.log(`📚 Served set size: ${servedIds.length}`);
        } catch (err) {
            console.error('⚠️ Redis served set error (safe to ignore):', err.message);
        }

        // User embedding
        const user = await User.findOne({ supabase_id: userId }).lean();
        let userEmbedding = user?.embedding_pca || user?.embedding;

        // Progressive time windows based on page
        const getTimeWindow = (page) => {
            if (page === 1) return { hours: 72, label: 'last 72h' };
            if (page === 2) return { hours: 168, label: 'last 7d' };
            if (page === 3) return { hours: 336, label: 'last 14d' };
            return { hours: 720, label: 'last 30d' };
        };

        const timeWindow = getTimeWindow(page);
        console.log(`⏰ Time window: ${timeWindow.label}, noveltySeed: ${noveltySeed}`);

        // Faiss status
        const faissStatus = getFaissIndexStatus();
        console.log('📊 Faiss status:', faissStatus);

        // Fallback path (no embedding or index)
        if (!userEmbedding || !Array.isArray(userEmbedding) || !faissStatus.isInitialized) {
            console.warn('⚠️ Falling back to engagement-based sorting WITH fresh articles injection');
            console.warn(`User embedding: ${userEmbedding ? 'exists' : 'missing'}, Faiss initialized: ${faissStatus.isInitialized}`);

            // Apply same time window constraints to fallback
            const cutoffTime = new Date(Date.now() - timeWindow.hours * 60 * 60 * 1000);
            console.log(`📅 FALLBACK: Applying time window: ${timeWindow.label}`);

            // Exclude served and disliked articles
            const excludeIds = [
                ...servedIds.map(id => new mongoose.Types.ObjectId(id)),
                ...(user?.disliked_articles || [])
            ];

            const fallbackArticles = await Article.find({
                language,
                publishedAt: { $gte: cutoffTime },
                _id: { $nin: excludeIds }
            })
                .sort({ publishedAt: -1, viewCount: -1 })
                .limit(limit * 2)
                .lean();

            // If insufficient articles, progressively widen time window
            let finalFallbackArticles = fallbackArticles;
            if (fallbackArticles.length < limit && timeWindow.hours < 720) {
                const widerRanges = [
                    { hours: 168, label: 'last 7d' },
                    { hours: 336, label: 'last 14d' },
                    { hours: 720, label: 'last 30d' }
                ];

                for (const range of widerRanges) {
                    if (range.hours <= timeWindow.hours) continue;

                    const widerCutoff = new Date(Date.now() - range.hours * 60 * 60 * 1000);
                    const additionalArticles = await Article.find({
                        language,
                        publishedAt: { $gte: widerCutoff, $lt: cutoffTime },
                        _id: { $nin: [...excludeIds, ...finalFallbackArticles.map(a => a._id)] }
                    })
                        .sort({ publishedAt: -1, viewCount: -1 })
                        .limit(limit * 2 - finalFallbackArticles.length)
                        .lean();

                    finalFallbackArticles = [...finalFallbackArticles, ...additionalArticles];
                    console.log(`📅 FALLBACK: Widened to ${range.label}, total: ${finalFallbackArticles.length}`);

                    if (finalFallbackArticles.length >= limit) break;
                }
            }

            const response = finalFallbackArticles.slice(0, limit).map(article => ({
                ...article,
                fetchId: new mongoose.Types.ObjectId().toString(),
                isFallback: true,
                timeWindow: timeWindow.label,
                noveltySeed,
                engagementScore: calculateEngagementScore(article)
            }));

            // Track served articles
            if (response.length > 0) {
                try {
                    const articleIds = response.map(a => a._id.toString());
                    await redis.sadd(servedKey, ...articleIds);
                    await redis.expire(servedKey, 86400);
                } catch (err) {
                    console.error('⚠️ Failed to track served articles:', err.message);
                }
            }

            try {
                await redis.set(cacheKey, JSON.stringify(response), 'EX', 1800);
            } catch (err) {
                console.error('⚠️ Redis set error (safe to ignore):', err.message);
            }

            return res.json(response);
        }

        /** ---------- Personalized path (Faiss) ---------- */
        console.log('🔍 Using Faiss for personalized recommendations');

        // Over-fetch for mixing
        const searchLimit = limit * 3;
        const { ids, distances } = await searchFaissIndex(userEmbedding, searchLimit);

        // Time window constraint
        const cutoffTime = new Date(Date.now() - timeWindow.hours * 60 * 60 * 1000);

        // Exclude served and disliked articles
        const excludeIds = [
            ...servedIds.map(id => new mongoose.Types.ObjectId(id)),
            ...(user?.disliked_articles || [])
        ];

        let candidateArticles = await Article.find({
            _id: { $in: ids.map(id => new mongoose.Types.ObjectId(id)) },
            language,
            publishedAt: { $gte: cutoffTime },
            _id: { $nin: excludeIds }
        }).lean();

        // If insufficient candidates, progressively widen time window
        if (candidateArticles.length < limit * 2 && timeWindow.hours < 720) {
            const widerRanges = [
                { hours: 168, label: 'last 7d' },
                { hours: 336, label: 'last 14d' },
                { hours: 720, label: 'last 30d' }
            ];

            for (const range of widerRanges) {
                if (range.hours <= timeWindow.hours) continue;

                const widerCutoff = new Date(Date.now() - range.hours * 60 * 60 * 1000);
                const additionalCandidates = await Article.find({
                    _id: { $in: ids.map(id => new mongoose.Types.ObjectId(id)) },
                    language,
                    publishedAt: { $gte: widerCutoff, $lt: cutoffTime },
                    _id: { $nin: [...excludeIds, ...candidateArticles.map(a => a._id)] }
                }).lean();

                candidateArticles = [...candidateArticles, ...additionalCandidates];
                console.log(`📅 Widened time window to ${range.label}, candidates: ${candidateArticles.length}`);

                if (candidateArticles.length >= limit * 2) break;
            }
        }

        console.log(`📄 Found ${candidateArticles.length} candidate articles within time window: ${timeWindow.label}`);

        // Page-aware recency weighting
        const w_recency =
            page === 1 ? 0.75 :
                page === 2 ? 0.65 :
                    page === 3 ? 0.55 :
                        0.45;

        // Recency-first similarity scoring
        const scoredArticles = candidateArticles.map(article => {
            const index = ids.indexOf(article._id.toString());
            const similarity = index !== -1 ? Math.max(0, Math.min(1, 1 - distances[index])) : 0;
            const engagementScore = calculateEngagementScore(article);
            const recencyScore = basicRecencyScore(article.publishedAt);
            const baseScore = (similarity * 0.6) + (engagementScore * 0.4);
            const finalScore = w_recency * recencyScore + (1 - w_recency) * baseScore;

            return {
                ...article,
                fetchId: new mongoose.Types.ObjectId().toString(),
                similarity,
                engagementScore,
                recencyScore,
                finalScore,
                timeWindow: timeWindow.label,
                noveltySeed
            };
        });

        // Sort by final score and take main results
        scoredArticles.sort((a, b) => b.finalScore - a.finalScore);
        const mainResultsCount = Math.ceil(limit * 0.85); // 85% main results
        let finalArticles = scoredArticles.slice(0, mainResultsCount);

        console.log(`📊 Recent count: ${finalArticles.length}, w_recency: ${w_recency.toFixed(2)}`);

        // Diversity injection: 10-15% older-but-relevant articles
        const diversityLimit = Math.min(Math.ceil(limit * 0.15), limit - finalArticles.length);
        if (diversityLimit > 0 && scoredArticles.length > mainResultsCount) {
            console.log(`🎲 Adding ${diversityLimit} diversity articles`);

            // Use older high-similarity articles for diversity
            const diversityCandidates = scoredArticles
                .slice(mainResultsCount)
                .filter(a => a.similarity > 0.3)
                .slice(0, diversityLimit * 2);

            // Deterministic shuffle using LCG
            const rng = lcg(noveltySeed);
            const shuffledDiversity = diversityCandidates
                .map(article => ({ article, sort: rng() }))
                .sort((a, b) => a.sort - b.sort)
                .map(item => ({ ...item.article, isDiverse: true }))
                .slice(0, diversityLimit);

            // Insert diversity articles at deterministic positions
            const diversityRng = lcg(noveltySeed + 1);
            shuffledDiversity.forEach(article => {
                const insertIndex = Math.floor(diversityRng() * (finalArticles.length + 1));
                finalArticles.splice(insertIndex, 0, article);
            });

            console.log(`🎯 Diversity injected count: ${shuffledDiversity.length}`);
        }

        // Trending injection (10%)
        const trendingLimit = Math.ceil(limit * 0.1);
        if (trendingLimit > 0) {
            console.log(`📈 Adding ${trendingLimit} trending articles for diversity`);

            const trendingArticles = await Article.find({
                language,
                viewCount: { $exists: true, $gt: 0 },
                publishedAt: { $gte: cutoffTime },
                _id: { $nin: [...excludeIds, ...finalArticles.map(a => a._id)] }
            })
                .sort({ viewCount: -1, publishedAt: -1 })
                .limit(trendingLimit * 2)
                .lean();

            const trendingEnhanced = trendingArticles.slice(0, trendingLimit).map(article => ({
                ...article,
                fetchId: new mongoose.Types.ObjectId().toString(),
                isTrending: true,
                timeWindow: timeWindow.label,
                noveltySeed,
                engagementScore: calculateEngagementScore(article)
            }));

            // Deterministic insertion using LCG
            const trendingRng = lcg(noveltySeed + 2);
            trendingEnhanced.forEach(article => {
                const insertIndex = Math.floor(trendingRng() * (finalArticles.length + 1));
                finalArticles.splice(insertIndex, 0, article);
            });
        }

        finalArticles = finalArticles.slice(0, limit);

        // Track served articles
        if (finalArticles.length > 0) {
            try {
                const articleIds = finalArticles.map(a => a._id.toString());
                await redis.sadd(servedKey, ...articleIds);
                await redis.expire(servedKey, 86400);
            } catch (err) {
                console.error('⚠️ Failed to track served articles:', err.message);
            }
        }

        console.log(`🎯 Final composition: ${finalArticles.length} articles, cacheKey: ${cacheKey.slice(-20)}...`);

        try {
            await redis.set(cacheKey, JSON.stringify(finalArticles), 'EX', 3600);
        } catch (err) {
            console.error('⚠️ Redis set error (safe to ignore):', err.message);
        }

        res.json(finalArticles);
    } catch (error) {
        console.error('❌ Error fetching personalized articles:', error);
        res.status(500).json({ error: 'Error fetching personalized articles', message: error.message });
    }
});

// GET: Generic (guest) feed with recency-aware sort
articleRouter.get('/', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const language = req.query.language || 'english';
        const category = req.query.category;

        const cacheKey = `articles_page_${page}_limit_${limit}_lang_${language}_cat_${category || 'all'}`;

        let cached;
        try {
            cached = await redis.get(cacheKey);
        } catch (err) {
            console.error('⚠️ Redis get error (safe to ignore):', err.message);
        }
        if (!req.query.noCache && cached) {
            console.log('🧠 Returning cached articles');
            return res.json(JSON.parse(cached));
        }

        const skip = (page - 1) * limit;

        // Build query filter
        const filter = { language };
        if (category) {
            filter.category = category;
            console.log('🏷️ Filtering articles by category:', category);
        }

        // Fetch newest first
        const raw = await Article.find(filter)
            .sort({ publishedAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean();

        // Re-rank by page-aware recency+engagement for better first page feel
        const freshRatio =
            page === 1 ? 0.70 :
                page === 2 ? 0.55 :
                    page === 3 ? 0.45 :
                        0.35;

        const enhancedArticles = raw
            .map((a) => {
                const engagement = calculateEngagementScore(a);
                const recency = basicRecencyScore(a.publishedAt);
                const baseScore = engagement; // no similarity for guests
                const finalScore = freshRatio * recency + (1 - freshRatio) * baseScore;
                return {
                    ...a,
                    fetchId: new mongoose.Types.ObjectId().toString(),
                    engagementScore: engagement,
                    finalScore,
                };
            })
            .sort((x, y) => (y.finalScore ?? 0) - (x.finalScore ?? 0));

        try {
            await redis.set(cacheKey, JSON.stringify(enhancedArticles), 'EX', 300);
        } catch (err) {
            console.error('⚠️ Redis set error (safe to ignore):', err.message);
        }

        res.json(enhancedArticles);
    } catch (error) {
        console.error('❌ Error fetching articles:', error);
        res.status(500).json({ error: 'Error fetching articles', message: error.message });
    }
});

// React (like/dislike)
articleRouter.post('/:id/react', auth, ensureMongoUser, async (req, res) => {
    try {
        const { action } = req.body;
        const userId = req.mongoUser.supabase_id;
        const articleId = req.params.id;
        const mongoUser = req.mongoUser;

        if (!mongoose.Types.ObjectId.isValid(articleId)) {
            return res.status(400).json({ message: 'Invalid article ID' });
        }
        if (!['like', 'dislike'].includes(action)) {
            return res.status(400).json({ message: 'Invalid action' });
        }

        // 1) Update article reaction arrays
        await Article.updateOne(
            { _id: articleId },
            { $pull: { likedBy: userId, dislikedBy: userId } }
        );

        const pushOp = action === 'like'
            ? { $push: { likedBy: userId } }
            : { $push: { dislikedBy: userId } };

        await Article.updateOne({ _id: articleId }, pushOp);

        // 2) Update user lists
        const articleObjectId = new mongoose.Types.ObjectId(articleId);
        await User.updateOne(
            { _id: mongoUser._id },
            { $pull: { liked_articles: articleObjectId, disliked_articles: articleObjectId } }
        );

        if (action === 'like') {
            await User.updateOne({ _id: mongoUser._id }, { $addToSet: { liked_articles: articleObjectId } });
        } else {
            await User.updateOne({ _id: mongoUser._id }, { $addToSet: { disliked_articles: articleObjectId } });
        }

        // 3) Recompute embedding
        await updateUserProfileEmbedding(mongoUser._id);

        // 4) Return updated counts
        const updatedArticle = await Article.findById(articleId, 'likedBy dislikedBy');
        const likes = updatedArticle?.likedBy?.length || 0;
        const dislikes = updatedArticle?.dislikedBy?.length || 0;

        updatedArticle.likes = likes;
        updatedArticle.dislikes = dislikes;
        await updatedArticle.save();

        res.json({ userReact: action, likes, dislikes });

        await clearArticlesCache();
    } catch (error) {
        console.error('Error in POST /:id/react:', error);
        res.status(500).json({ message: 'Error reacting to article', error: error.message });
    }
});

// Related-by-embedding (small helper endpoint you already have)
articleRouter.get('/related-embedding/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const target = await Article.findById(id);
        if (!target?.embedding) return res.status(404).json({ error: 'No embedding found' });

        const allArticles = await Article.find({ _id: { $ne: id }, embedding: { $exists: true } });

        const cosineSimilarity = (a, b) => {
            let dot = 0, magA = 0, magB = 0;
            for (let i = 0; i < a.length; i++) {
                dot += a[i] * b[i];
                magA += a[i] * a[i];
                magB += b[i] * b[i];
            }
            return magA && magB ? dot / (Math.sqrt(magA) * Math.sqrt(magB)) : 0;
        };

        const related = allArticles
            .map(a => ({ ...a.toObject(), similarity: cosineSimilarity(target.embedding, a.embedding) }))
            .sort((a, b) => b.similarity - a.similarity)
            .slice(0, 5);

        res.json(related);
    } catch (err) {
        console.error('Error finding related articles:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Feature (unchanged, minus minor cleanups)
articleRouter.get('/feature', auth, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 5;
        const language = req.query.language || 'english';

        const cacheKey = `articles_feature_page_${page}_limit_${limit}_lang_${language}`;

        let cached;
        try {
            cached = await redis.get(cacheKey);
        } catch (err) {
            console.error('⚠️ Redis get error (safe to ignore):', err.message);
        }

        if (!req.query.noCache && cached) {
            console.log('🧠 Returning cached articles');
            return res.json(JSON.parse(cached));
        }

        const skip = (page - 1) * limit;
        const articles = await Article.find({ category: 'feature', language })
            .sort({ publishedAt: -1 })
            .skip(skip)
            .limit(limit);

        const totalFeatureArticles = await Article.countDocuments({ category: 'feature', language });

        const response = {
            articles,
            totalPages: Math.ceil(totalFeatureArticles / limit),
            currentPage: page,
        };

        try {
            await redis.set(cacheKey, JSON.stringify(response), 'EX', 300);
        } catch (err) {
            console.error('⚠️ Redis set error (safe to ignore):', err.message);
        }

        res.json(response);
    } catch (error) {
        console.error('❌ Error fetching feature articles:', error);
        res.status(500).json({ error: 'Error fetching feature articles', message: error.message });
    }
});

// Headline (unchanged)
articleRouter.get('/headline', auth, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 5;
        const language = req.query.language || 'english';

        const cacheKey = `articles_headline_page_${page}_limit_${limit}_lang_${language}`;

        let cached;
        try {
            cached = await redis.get(cacheKey);
        } catch (err) {
            console.error('⚠️ Redis get error (safe to ignore):', err.message);
        }

        if (!req.query.noCache && cached) {
            console.log('🧠 Returning cached articles');
            return res.json(JSON.parse(cached));
        }

        const skip = (page - 1) * limit;
        const articles = await Article.find({ category: 'headline', language })
            .sort({ publishedAt: -1 })
            .skip(skip)
            .limit(limit);

        const totalHeadlineArticles = await Article.countDocuments({ category: 'headline', language });

        const response = {
            articles,
            totalPages: Math.ceil(totalHeadlineArticles / limit),
            currentPage: page,
        };

        try {
            await redis.set(cacheKey, JSON.stringify(response), 'EX', 300);
        } catch (err) {
            console.error('⚠️ Redis set error (safe to ignore):', err.message);
        }

        res.json(response);
    } catch (error) {
        console.error('❌ Error fetching headline articles:', error);
        res.status(500).json({ error: 'Error fetching headline articles', message: error.message });
    }
});

// Create (embedding)
articleRouter.post('/', auth, async (req, res) => {
    try {
        const { title, content, url, sourceId, category, publishedAt, image } = req.body;
        if (!title || !content || !url || !sourceId || !category || !image) {
            return res.status(400).json({ message: 'Missing required fields' });
        }
        try {
            const embeddingInput = `${title}\n\n${content?.slice(0, 512) || ''}`;
            let embedding = [];
            try {
                embedding = await getDeepSeekEmbedding(embeddingInput);
            } catch (embeddingError) {
                console.warn('DeepSeek embedding error (article will save without embedding):', embeddingError.message);
            }

            const newArticle = new Article({
                title, content, url, sourceId, category, publishedAt, image, embedding,
            });
            const savedArticle = await newArticle.save();
            res.status(201).json(savedArticle);
        } catch (error) {
            res.status(400).json({ message: 'Error creating article', error: error.message });
        }
    } catch (error) {
        res.status(400).json({ message: 'Error creating article', error: error.message });
    }
});

// Update
articleRouter.put('/:id', auth, async (req, res) => {
    try {
        const updatedArticle = await Article.findByIdAndUpdate(req.params.id, req.body, { new: true });
        if (!updatedArticle) {
            return res.status(404).json({ message: 'Article not found' });
        }
        res.json(updatedArticle);
    } catch (error) {
        res.status(400).json({ message: 'Error updating article', error: error.message });
    }
});

// GET related articles based on similarity
articleRouter.get('/related/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const limit = Math.min(parseInt(req.query.limit) || 5, 20); // Max 20 related articles

        console.log(`🔍 Fetching related articles for: ${id}, limit: ${limit}`);

        // Get the base article
        const baseArticle = await Article.findById(id).lean();
        if (!baseArticle) {
            return res.status(404).json({ message: 'Article not found' });
        }

        console.log(`📰 Base article: "${baseArticle.title?.slice(0, 50)}..." Category: ${baseArticle.category}`);

        let relatedArticles = [];

        // Method 1: Try embedding-based similarity if embeddings exist
        if (baseArticle.embedding_pca && baseArticle.embedding_pca.length > 0) {
            console.log('🔍 Using PCA embedding-based similarity');

            // Find articles with PCA embeddings in the same category
            const candidateArticles = await Article.find({
                _id: { $ne: id },
                embedding_pca: { $exists: true, $not: { $size: 0 } },
                category: baseArticle.category
            })
                .select('title content category sourceId publishedAt image url viewCount likes dislikes embedding_pca')
                .limit(50) // Get more candidates for better similarity scoring
                .lean();

            console.log(`📊 Found ${candidateArticles.length} candidate articles with PCA embeddings`);

            // Calculate cosine similarity with PCA embeddings
            const similarities = candidateArticles.map(article => {
                const similarity = cosineSimilarity(baseArticle.embedding_pca, article.embedding_pca);
                return { ...article, similarity };
            });

            // Sort by similarity and take top results
            relatedArticles = similarities
                .sort((a, b) => b.similarity - a.similarity)
                .slice(0, limit);

            console.log(`🔍 Top similarities: ${relatedArticles.slice(0, 3).map(a => a.similarity.toFixed(3)).join(', ')}`);
        }

        // Method 2: If no embedding results or not enough, fall back to category/source similarity
        if (relatedArticles.length < limit) {
            console.log('🔍 Using category/source-based similarity as fallback');

            const remaining = limit - relatedArticles.length;
            const excludeIds = relatedArticles.map(a => a._id.toString()).concat([id]);

            // First try same category, different source
            let categoryArticles = await Article.find({
                _id: { $nin: excludeIds },
                category: baseArticle.category,
                sourceId: { $ne: baseArticle.sourceId }
            })
                .select('title content category sourceId publishedAt image url viewCount likes dislikes')
                .sort({ publishedAt: -1 })
                .limit(remaining)
                .lean();

            relatedArticles = relatedArticles.concat(categoryArticles.map(a => ({ ...a, similarity: 0.7 })));

            // If still not enough, try same source
            if (relatedArticles.length < limit) {
                const stillRemaining = limit - relatedArticles.length;
                const newExcludeIds = relatedArticles.map(a => a._id.toString()).concat([id]);

                const sourceArticles = await Article.find({
                    _id: { $nin: newExcludeIds },
                    sourceId: baseArticle.sourceId
                })
                    .select('title content category sourceId publishedAt image url viewCount likes dislikes')
                    .sort({ publishedAt: -1 })
                    .limit(stillRemaining)
                    .lean();

                relatedArticles = relatedArticles.concat(sourceArticles.map(a => ({ ...a, similarity: 0.5 })));
            }
        }

        // Clean up the results - return complete article objects
        const finalResults = relatedArticles.slice(0, limit).map(article => ({
            ...article,
            similarity: article.similarity || 0
        }));

        console.log(`✅ Returning ${finalResults.length} related articles with complete data`);
        res.json(finalResults);

    } catch (error) {
        console.error('Error fetching related articles:', error);
        res.status(500).json({ message: 'Error fetching related articles', error: error.message });
    }
});

// GET one - Must be last to avoid conflicts with specific routes
articleRouter.get('/:id', async (req, res) => {
    try {
        const article = await Article.findById(req.params.id);
        if (!article) return res.status(404).json({ message: 'Article not found' });
        res.json(article);
    } catch (err) {
        console.error('GET /:id error:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

module.exports = articleRouter;
