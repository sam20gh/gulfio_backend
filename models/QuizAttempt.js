const mongoose = require('mongoose');

/**
 * One attempt per user per daily quiz. Weekly aggregates power the quiz
 * leaderboard; per-question answers allow the review screen.
 */
const quizAttemptSchema = new mongoose.Schema({
    quizId: { type: mongoose.Schema.Types.ObjectId, ref: 'DailyQuiz', required: true },
    userId: { type: String, required: true },
    date: { type: String, required: true },      // denormalized for weekly aggregation
    answers: [{
        _id: false,
        questionId: { type: String, required: true },
        optionId: { type: String, required: true },
        correct: { type: Boolean, required: true },
    }],
    score: { type: Number, required: true },      // number of correct answers
    total: { type: Number, required: true },
}, { timestamps: true });

quizAttemptSchema.index({ quizId: 1, userId: 1 }, { unique: true });
quizAttemptSchema.index({ date: 1, score: -1 }); // leaderboard aggregation

module.exports = mongoose.model('QuizAttempt', quizAttemptSchema);
