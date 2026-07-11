const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Poll = require('../models/Poll');
const PollVote = require('../models/PollVote');
const Article = require('../models/Article');
const auth = require('../middleware/auth');
const PointsService = require('../services/pointsService');
const { chatCompletionJSON } = require('../services/openaiClient');

const POLL_MODEL = 'gpt-4o-mini';

const FALLBACK_QUESTIONS = {
    english: {
        question: 'What’s your take on this story?',
        options: [
            { id: 'a', label: 'Great news' },
            { id: 'b', label: 'Concerning' },
            { id: 'c', label: 'Not sure yet' },
        ],
    },
    arabic: {
        question: 'ما رأيك في هذا الخبر؟',
        options: [
            { id: 'a', label: 'خبر رائع' },
            { id: 'b', label: 'مقلق' },
            { id: 'c', label: 'لست متأكداً بعد' },
        ],
    },
    farsi: {
        question: 'نظر شما درباره این خبر چیست؟',
        options: [
            { id: 'a', label: 'خبر خوبی است' },
            { id: 'b', label: 'نگران‌کننده' },
            { id: 'c', label: 'هنوز مطمئن نیستم' },
        ],
    },
};

function fallbackFor(language) {
    return FALLBACK_QUESTIONS[language] || FALLBACK_QUESTIONS.english;
}

/** Strip HTML/markdown-ish noise and cap length for the prompt */
function excerpt(text, max = 1500) {
    return String(text || '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
}

/**
 * Generate an opinion poll for an article via the LLM.
 * Returns { question, options: [{id,label}], origin }.
 */
async function generatePollContent(article) {
    const language = article.language || 'english';
    try {
        const { content } = await chatCompletionJSON({
            model: POLL_MODEL,
            temperature: 0.6,
            max_tokens: 250,
            response_format: { type: 'json_object' },
            timeout: 12000,
            messages: [
                {
                    role: 'system',
                    content:
                        'You write one-tap reader polls for a Gulf news app. Given an article, produce ONE short, neutral opinion or prediction question a reader can answer instantly, with 2-4 mutually exclusive answer options (max 5 words each). Never take sides on sensitive political, religious or ethnic topics — for those, ask about impact or interest instead. Write the question and options in the SAME language as the article. Respond as JSON: {"question": string, "options": [string, ...]}',
                },
                {
                    role: 'user',
                    content: `Language: ${language}\nTitle: ${article.title}\n\n${excerpt(article.content)}`,
                },
            ],
        });

        const parsed = JSON.parse(content);
        const labels = Array.isArray(parsed.options)
            ? parsed.options.map((o) => String(typeof o === 'object' ? o.label || o.text || '' : o).trim()).filter(Boolean)
            : [];

        if (!parsed.question || labels.length < 2) {
            throw new Error('LLM returned unusable poll content');
        }

        return {
            question: String(parsed.question).trim(),
            options: labels.slice(0, 4).map((label, i) => ({ id: 'abcd'[i], label: label.slice(0, 60) })),
            origin: 'generated',
        };
    } catch (err) {
        console.warn('⚠️ Poll generation failed, using fallback:', err.message);
        const fb = fallbackFor(language);
        return { ...fb, origin: 'fallback' };
    }
}

function serializePoll(poll, userVote) {
    return {
        _id: poll._id,
        articleId: poll.articleId,
        question: poll.question,
        options: poll.options.map((o) => ({ id: o.id, label: o.label, votes: o.votes })),
        totalVotes: poll.totalVotes,
        userVote: userVote ? userVote.optionId : null,
    };
}

/**
 * GET /api/polls/article/:articleId
 * Returns the article's poll, generating it on first request.
 * Guests (admin key, no JWT) get the poll without userVote.
 */
router.get('/article/:articleId', auth, async (req, res) => {
    const { articleId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(articleId)) {
        return res.status(400).json({ message: 'Invalid article id' });
    }

    try {
        let poll = await Poll.findOne({ articleId });

        if (!poll) {
            const article = await Article.findById(articleId)
                .select('title content language category')
                .lean();
            if (!article) return res.status(404).json({ message: 'Article not found' });

            const generated = await generatePollContent(article);
            try {
                poll = await Poll.create({
                    articleId,
                    question: generated.question,
                    options: generated.options.map((o) => ({ ...o, votes: 0 })),
                    language: article.language || 'english',
                    category: article.category,
                    origin: generated.origin,
                });
            } catch (createErr) {
                // E11000: a concurrent request created it first — use theirs
                if (createErr.code === 11000) {
                    poll = await Poll.findOne({ articleId });
                } else {
                    throw createErr;
                }
            }
        }

        if (!poll || poll.status !== 'active') {
            return res.status(404).json({ message: 'No poll for this article' });
        }

        const userId = req.user?.sub;
        const userVote = userId ? await PollVote.findOne({ pollId: poll._id, userId }).lean() : null;

        res.json(serializePoll(poll, userVote));
    } catch (error) {
        console.error('❌ Poll fetch error:', error);
        res.status(500).json({ message: 'Error fetching poll', error: error.message });
    }
});

/**
 * POST /api/polls/:pollId/vote  { optionId }
 * One vote per user per poll; re-voting a different option moves the vote.
 * First vote awards POLL_VOTE points (returned for the in-app "+N" bubble).
 */
router.post('/:pollId/vote', auth, async (req, res) => {
    const userId = req.user?.sub;
    if (!userId) return res.status(401).json({ message: 'Sign in to vote' });

    const { pollId } = req.params;
    const { optionId } = req.body || {};
    if (!mongoose.Types.ObjectId.isValid(pollId) || !optionId) {
        return res.status(400).json({ message: 'Missing poll or option' });
    }

    try {
        const poll = await Poll.findById(pollId);
        if (!poll || poll.status !== 'active') {
            return res.status(404).json({ message: 'Poll not found' });
        }
        if (!poll.options.some((o) => o.id === optionId)) {
            return res.status(400).json({ message: 'Unknown option' });
        }

        const existing = await PollVote.findOne({ pollId, userId });
        let award = null;

        if (!existing) {
            try {
                await PollVote.create({
                    pollId,
                    userId,
                    optionId,
                    articleId: poll.articleId,
                    category: poll.category,
                });
            } catch (createErr) {
                if (createErr.code !== 11000) throw createErr; // double-tap race: treat as existing
            }
            await Poll.updateOne(
                { _id: pollId },
                { $inc: { totalVotes: 1, 'options.$[opt].votes': 1 } },
                { arrayFilters: [{ 'opt.id': optionId }] }
            );

            award = await PointsService.awardPoints(userId, 'POLL_VOTE', {
                articleId: poll.articleId,
                category: poll.category,
            }).catch(() => null);
        } else if (existing.optionId !== optionId) {
            // Move the vote — counts shift, no extra points
            await PollVote.updateOne({ _id: existing._id }, { $set: { optionId } });
            await Poll.updateOne(
                { _id: pollId },
                { $inc: { 'options.$[oldOpt].votes': -1, 'options.$[newOpt].votes': 1 } },
                { arrayFilters: [{ 'oldOpt.id': existing.optionId }, { 'newOpt.id': optionId }] }
            );
        }
        // Same option again: idempotent no-op

        const updated = await Poll.findById(pollId);
        res.json({
            ...serializePoll(updated, { optionId }),
            pointsAwarded: award?.pointsAwarded ?? 0,
            action: award ? 'poll_vote' : undefined,
        });
    } catch (error) {
        console.error('❌ Poll vote error:', error);
        res.status(500).json({ message: 'Error saving vote', error: error.message });
    }
});

module.exports = router;
