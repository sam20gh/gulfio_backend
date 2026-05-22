/**
 * AI Article routes — Brief + Fact-check.
 *
 *   POST /api/ai/article/:id/brief
 *   POST /api/ai/article/:id/factcheck
 *
 * Both require auth. Results are cached in Redis for 7 days keyed by
 * articleId + language + engine. A simple per-user rate-limit protects
 * against runaway cost. Usage is logged fire-and-forget to AiUsage.
 *
 * Response schema is a PUBLIC API contract — see services/aiArticleService.js.
 * For the publisher-facing roadmap (RAG, API keys, billing) see
 * docs/AI_FACTCHECK_V2_ROADMAP.md
 */

const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');

const auth = require('../middleware/auth');
const Article = require('../models/Article');
const AiUsage = require('../models/AiUsage');
const redis = require('../utils/redis');
const {
    generateBrief,
    factCheck,
    API_VERSION,
} = require('../services/aiArticleService');

// ─── Config ───────────────────────────────────────────────────────────────────

const CACHE_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
const RATE_LIMIT_WINDOW_SECONDS = 60;
const RATE_LIMIT_MAX = Number(process.env.AI_ARTICLE_RATE_LIMIT_PER_MIN || 20);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractUserId(user) {
    return user?.sub || user?.uid || user?.user_id || user?.id || null;
}

function briefCacheKey(articleId, language) {
    return `ai:article:brief:${articleId}:${language || 'english'}`;
}

function factCheckCacheKey(articleId, language, engine) {
    return `ai:article:factcheck:${engine}:${articleId}:${language || 'english'}`;
}

/**
 * Loose rate limit: increment a 60-second window counter per user+endpoint.
 * Race-tolerant — over-counting by a few is fine. Disabled if redis is down.
 */
async function checkRateLimit(userId, endpoint) {
    if (!userId) return { allowed: true };
    const key = `ai:rl:${endpoint}:${userId}:${Math.floor(Date.now() / 1000 / RATE_LIMIT_WINDOW_SECONDS)}`;
    const current = await redis.get(key);
    const count = current ? parseInt(current, 10) : 0;
    if (count >= RATE_LIMIT_MAX) {
        return { allowed: false, count };
    }
    await redis.set(key, String(count + 1), 'EX', RATE_LIMIT_WINDOW_SECONDS + 5);
    return { allowed: true, count: count + 1 };
}

function logUsage(payload) {
    // Fire-and-forget — never block the response on this.
    AiUsage.create(payload).catch((err) => {
        console.warn('AiUsage log failed:', err.message);
    });
}

async function loadArticleOr404(req, res) {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
        res.status(400).json({ success: false, error: 'Invalid article id' });
        return null;
    }
    const article = await Article.findById(id).select('title content language url category').lean();
    if (!article) {
        res.status(404).json({ success: false, error: 'Article not found' });
        return null;
    }
    if (!article.content || !article.content.trim()) {
        res.status(422).json({ success: false, error: 'Article has no content to analyse' });
        return null;
    }
    return article;
}

// ─── POST /:id/brief ──────────────────────────────────────────────────────────

router.post('/:id/brief', auth, async (req, res) => {
    const startedAt = Date.now();
    const userId = extractUserId(req.user);
    const articleId = req.params.id;

    try {
        const rl = await checkRateLimit(userId, 'brief');
        if (!rl.allowed) {
            logUsage({
                endpoint: 'brief',
                userId,
                articleId,
                status: 'rate_limited',
                latencyMs: Date.now() - startedAt,
            });
            return res.status(429).json({
                success: false,
                error: 'Rate limit exceeded. Please wait a moment before trying again.',
            });
        }

        const article = await loadArticleOr404(req, res);
        if (!article) return; // response already sent

        const language = article.language || 'english';
        const cacheKey = briefCacheKey(articleId, language);

        const cached = await redis.get(cacheKey);
        if (cached) {
            try {
                const parsed = JSON.parse(cached);
                logUsage({
                    endpoint: 'brief',
                    userId,
                    articleId,
                    language,
                    model: parsed.model,
                    cacheHit: true,
                    latencyMs: Date.now() - startedAt,
                    status: 'ok',
                });
                return res.json({ success: true, cached: true, ...parsed });
            } catch {
                // fall through and regenerate
            }
        }

        const result = await generateBrief({
            title: article.title,
            content: article.content,
            language,
        });

        // Fire-and-forget cache write
        redis.set(cacheKey, JSON.stringify(result), 'EX', CACHE_TTL_SECONDS).catch(() => {});

        logUsage({
            endpoint: 'brief',
            engine: result.engine,
            model: result.model,
            userId,
            articleId,
            language,
            tokensIn: result.usage?.prompt_tokens || 0,
            tokensOut: result.usage?.completion_tokens || 0,
            latencyMs: result.latency_ms,
            cacheHit: false,
            status: 'ok',
        });

        return res.json({ success: true, cached: false, ...result });
    } catch (error) {
        console.error('Brief generation failed:', error.message);
        logUsage({
            endpoint: 'brief',
            userId,
            articleId,
            status: 'error',
            errorMessage: error.message,
            latencyMs: Date.now() - startedAt,
        });
        return res.status(500).json({
            success: false,
            error: 'Failed to generate brief. Please try again.',
            api_version: API_VERSION,
        });
    }
});

// ─── POST /:id/factcheck ──────────────────────────────────────────────────────

router.post('/:id/factcheck', auth, async (req, res) => {
    const startedAt = Date.now();
    const userId = extractUserId(req.user);
    const articleId = req.params.id;
    const engine = process.env.FACTCHECK_ENGINE || 'llm_only';

    try {
        const rl = await checkRateLimit(userId, 'factcheck');
        if (!rl.allowed) {
            logUsage({
                endpoint: 'factcheck',
                engine,
                userId,
                articleId,
                status: 'rate_limited',
                latencyMs: Date.now() - startedAt,
            });
            return res.status(429).json({
                success: false,
                error: 'Rate limit exceeded. Please wait a moment before trying again.',
            });
        }

        const article = await loadArticleOr404(req, res);
        if (!article) return;

        const language = article.language || 'english';
        const cacheKey = factCheckCacheKey(articleId, language, engine);

        const cached = await redis.get(cacheKey);
        if (cached) {
            try {
                const parsed = JSON.parse(cached);
                logUsage({
                    endpoint: 'factcheck',
                    engine,
                    userId,
                    articleId,
                    language,
                    model: parsed.model,
                    cacheHit: true,
                    latencyMs: Date.now() - startedAt,
                    status: 'ok',
                });
                return res.json({ success: true, cached: true, ...parsed });
            } catch {
                // fall through
            }
        }

        const result = await factCheck(
            { title: article.title, content: article.content, language },
            { engine }
        );

        redis.set(cacheKey, JSON.stringify(result), 'EX', CACHE_TTL_SECONDS).catch(() => {});

        logUsage({
            endpoint: 'factcheck',
            engine: result.engine,
            model: result.model,
            userId,
            articleId,
            language,
            tokensIn: result.usage?.prompt_tokens || 0,
            tokensOut: result.usage?.completion_tokens || 0,
            latencyMs: result.latency_ms,
            cacheHit: false,
            status: 'ok',
        });

        return res.json({ success: true, cached: false, ...result });
    } catch (error) {
        console.error('Fact-check failed:', error.message);
        logUsage({
            endpoint: 'factcheck',
            engine,
            userId,
            articleId,
            status: 'error',
            errorMessage: error.message,
            latencyMs: Date.now() - startedAt,
        });
        return res.status(500).json({
            success: false,
            error: 'Failed to fact-check this article. Please try again.',
            api_version: API_VERSION,
        });
    }
});

module.exports = router;
