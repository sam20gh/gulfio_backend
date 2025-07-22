const mongoose = require('mongoose');

const SourceSchema = new mongoose.Schema({
    name: String,
    groupName: String, // 🆕 Group sources under a common name
    url: String,
    baseUrl: { type: String },
    category: String,
    frequency: String,
    listSelector: String,
    linkSelector: String,
    titleSelector: String,
    imageSelector: String,
    contentSelector: String,
    icon: String,
    lastScraped: Date,
    followers: { type: Number, default: 0 },
    instagramUsername: { type: String, default: null },
    youtubeChannelId: { type: String, default: null },// e.g., .story-element.story-element-text p
    language: { type: String, default: "english" },
    bioSection: { type: String, default: null },
    bioLink: { type: String, default: null },
});

module.exports = mongoose.model('Source', SourceSchema);
