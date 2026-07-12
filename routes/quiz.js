const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const DailyQuiz = require('../models/DailyQuiz');
const QuizAttempt = require('../models/QuizAttempt');
const Article = require('../models/Article');
const User = require('../models/User');
const auth = require('../middleware/auth');
const PointsService = require('../services/pointsService');
const { chatCompletionJSON } = require('../services/openaiClient');

const QUIZ_MODEL = 'gpt-4o-mini';
const QUESTION_COUNT = 5;
const SOURCE_WINDOW_HOURS = 36;
const SUPPORTED_LANGUAGES = ['english', 'arabic', 'farsi'];

/** Gulf-day key (UTC+4, Dubai) so "today's quiz" flips at local midnight */
function todayKey() {
    const gulfNow = new Date(Date.now() + 4 * 60 * 60 * 1000);
    return gulfNow.toISOString().slice(0, 10);
}

function excerpt(text, max = 900) {
    return String(text || '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
}

/**
 * Build QUESTION_COUNT multiple-choice questions from the day's top stories.
 * Throws if the LLM output is unusable — callers treat that as "no quiz yet".
 */
async function generateQuizQuestions(language) {
    const since = new Date(Date.now() - SOURCE_WINDOW_HOURS * 60 * 60 * 1000);
    const articles = await Article.find({
        language,
        publishedAt: { $gte: since },
        content: { $exists: true, $ne: '' },
    })
        .sort({ viewCount: -1, publishedAt: -1 })
        .limit(QUESTION_COUNT + 3) // a few spares for the LLM to choose from
        .select('title content category')
        .lean();

    if (articles.length < 3) {
        throw new Error(`Not enough recent ${language} articles for a quiz`);
    }

    const sources = articles
        .map((a, i) => `[${i + 1}] ${a.title}\n${excerpt(a.content)}`)
        .join('\n\n');

    const { content } = await chatCompletionJSON({
        model: QUIZ_MODEL,
        temperature: 0.5,
        max_tokens: 1200,
        response_format: { type: 'json_object' },
        timeout: 20000,
        messages: [
            {
                role: 'system',
                content:
                    `You write a fun daily news quiz for a Gulf news app. From the numbered articles provided, create exactly ${QUESTION_COUNT} multiple-choice questions, each answerable from a DIFFERENT article. Rules: questions test facts stated in the article (who/what/where/how much); 4 options each, one correct, distractors plausible; keep questions under 20 words and options under 6 words; neutral tone, nothing sensitive; write in the SAME language as the articles. Respond as JSON: {"questions": [{"article": <number>, "question": string, "options": [string, string, string, string], "correctIndex": <0-3>}]}`,
            },
            { role: 'user', content: sources },
        ],
    });

    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed.questions) || parsed.questions.length < 3) {
        throw new Error('LLM returned unusable quiz content');
    }

    return parsed.questions.slice(0, QUESTION_COUNT).map((q, qi) => {
        const options = (q.options || []).map((label, oi) => ({
            id: 'abcd'[oi],
            label: String(label).trim().slice(0, 60),
        }));
        const correctIndex = Number(q.correctIndex);
        if (options.length !== 4 || !(correctIndex >= 0 && correctIndex <= 3) || !q.question) {
            throw new Error(`Malformed question ${qi + 1}`);
        }
        const sourceArticle = articles[Number(q.article) - 1];
        return {
            id: `q${qi + 1}`,
            question: String(q.question).trim(),
            options,
            correctOptionId: 'abcd'[correctIndex],
            articleId: sourceArticle?._id,
        };
    });
}

function serializeQuiz(quiz, attempt) {
    return {
        _id: quiz._id,
        date: quiz.date,
        language: quiz.language,
        questions: quiz.questions.map((q) => ({
            id: q.id,
            question: q.question,
            options: q.options,
            // Correct answers ship to the client for instant tap feedback;
            // grading/points remain server-side (one attempt per user).
            correctOptionId: q.correctOptionId,
            articleId: q.articleId,
        })),
        attempt: attempt
            ? { score: attempt.score, total: attempt.total, answers: attempt.answers }
            : null,
    };
}

/**
 * GET /api/quiz/today?language=english
 * Returns today's quiz, generating it on first request per day+language.
 * Includes the caller's attempt if they already played.
 */
router.get('/today', auth, async (req, res) => {
    const language = SUPPORTED_LANGUAGES.includes(String(req.query.language || '').toLowerCase())
        ? String(req.query.language).toLowerCase()
        : 'english';
    const date = todayKey();

    try {
        let quiz = await DailyQuiz.findOne({ date, language });

        if (!quiz) {
            let questions;
            try {
                questions = await generateQuizQuestions(language);
            } catch (genErr) {
                console.warn(`⚠️ Quiz generation failed (${language}):`, genErr.message);
                return res.status(404).json({ message: 'No quiz available yet' });
            }
            try {
                quiz = await DailyQuiz.create({ date, language, questions });
            } catch (createErr) {
                if (createErr.code === 11000) {
                    quiz = await DailyQuiz.findOne({ date, language }); // concurrent generation
                } else {
                    throw createErr;
                }
            }
        }

        if (!quiz || quiz.status !== 'active') {
            return res.status(404).json({ message: 'No quiz available yet' });
        }

        const userId = req.user?.sub;
        const attempt = userId
            ? await QuizAttempt.findOne({ quizId: quiz._id, userId }).lean()
            : null;

        res.json(serializeQuiz(quiz, attempt));
    } catch (error) {
        console.error('❌ Quiz fetch error:', error);
        res.status(500).json({ message: 'Error fetching quiz', error: error.message });
    }
});

/**
 * POST /api/quiz/:quizId/submit  { answers: [{questionId, optionId}] }
 * Grades server-side, stores the single attempt, awards QUIZ_CORRECT per
 * correct answer (summed into pointsAwarded for the in-app bubble).
 */
router.post('/:quizId/submit', auth, async (req, res) => {
    const userId = req.user?.sub;
    if (!userId) return res.status(401).json({ message: 'Sign in to play' });

    const { quizId } = req.params;
    const { answers } = req.body || {};
    if (!mongoose.Types.ObjectId.isValid(quizId) || !Array.isArray(answers)) {
        return res.status(400).json({ message: 'Missing quiz or answers' });
    }

    try {
        const quiz = await DailyQuiz.findById(quizId).lean();
        if (!quiz || quiz.status !== 'active') {
            return res.status(404).json({ message: 'Quiz not found' });
        }

        const graded = quiz.questions.map((q) => {
            const given = answers.find((a) => a && a.questionId === q.id);
            const optionId = given && q.options.some((o) => o.id === given.optionId)
                ? given.optionId
                : 'none';
            return { questionId: q.id, optionId, correct: optionId === q.correctOptionId };
        });
        const score = graded.filter((g) => g.correct).length;

        let attempt;
        try {
            attempt = await QuizAttempt.create({
                quizId,
                userId,
                date: quiz.date,
                answers: graded,
                score,
                total: quiz.questions.length,
            });
        } catch (createErr) {
            if (createErr.code === 11000) {
                // Already played — return the original attempt, no new points
                const existing = await QuizAttempt.findOne({ quizId, userId }).lean();
                return res.json({
                    score: existing.score,
                    total: existing.total,
                    answers: existing.answers,
                    pointsAwarded: 0,
                    alreadyPlayed: true,
                });
            }
            throw createErr;
        }

        // Award per correct answer; sum for the client bubble
        let pointsAwarded = 0;
        for (let i = 0; i < score; i++) {
            const award = await PointsService.awardPoints(userId, 'QUIZ_CORRECT', {
                description: `Daily quiz ${quiz.date}`,
            }).catch(() => null);
            pointsAwarded += award?.pointsAwarded ?? 0;
        }

        res.json({
            score: attempt.score,
            total: attempt.total,
            answers: attempt.answers,
            pointsAwarded,
            action: pointsAwarded > 0 ? 'quiz_correct' : undefined,
        });
    } catch (error) {
        console.error('❌ Quiz submit error:', error);
        res.status(500).json({ message: 'Error submitting quiz', error: error.message });
    }
});

/**
 * GET /api/quiz/leaderboard?days=7&limit=20
 * Total quiz score over the window — powers a weekly quiz leaderboard.
 */
router.get('/leaderboard', auth, async (req, res) => {
    const days = Math.min(parseInt(req.query.days, 10) || 7, 31);
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);
    const sinceKey = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    try {
        const rows = await QuizAttempt.aggregate([
            { $match: { date: { $gte: sinceKey } } },
            {
                $group: {
                    _id: '$userId',
                    totalScore: { $sum: '$score' },
                    quizzes: { $sum: 1 },
                },
            },
            { $sort: { totalScore: -1, quizzes: 1 } },
            { $limit: limit },
        ]);

        // Enrich with display name/avatar (batch lookup, same shape as the
        // gamification leaderboard) and flag the requesting user's own row.
        const currentUserId = req.user?.sub;
        const userIds = rows.map((r) => r._id);
        const users = await User.find({ supabase_id: { $in: userIds } })
            .select('supabase_id name avatar_url profile_image')
            .lean();
        const userMap = new Map(users.map((u) => [u.supabase_id, u]));

        res.json(rows.map((r, i) => {
            const u = userMap.get(r._id);
            return {
                rank: i + 1,
                userId: r._id,
                name: u?.name || 'Anonymous',
                avatar: u?.profile_image || u?.avatar_url || null,
                totalScore: r.totalScore,
                quizzes: r.quizzes,
                isCurrentUser: r._id === currentUserId,
            };
        }));
    } catch (error) {
        console.error('❌ Quiz leaderboard error:', error);
        res.status(500).json({ message: 'Error fetching leaderboard', error: error.message });
    }
});

module.exports = router;
