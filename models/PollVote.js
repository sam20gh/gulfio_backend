const mongoose = require('mongoose');

/**
 * One vote per user per poll. Doubles as recommender preference data:
 * (userId, articleId, category, optionId) is an explicit opinion signal.
 */
const pollVoteSchema = new mongoose.Schema({
    pollId: { type: mongoose.Schema.Types.ObjectId, ref: 'Poll', required: true },
    userId: { type: String, required: true }, // Supabase user id
    optionId: { type: String, required: true },
    articleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Article', index: true },
    category: { type: String },
}, { timestamps: true });

pollVoteSchema.index({ pollId: 1, userId: 1 }, { unique: true });
pollVoteSchema.index({ userId: 1, createdAt: -1 }); // recommender: recent opinions per user

module.exports = mongoose.model('PollVote', pollVoteSchema);
