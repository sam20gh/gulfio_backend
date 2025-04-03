const mongoose = require('mongoose');

const SourceSchema = new mongoose.Schema({
    name: { type: String, required: true },
    url: { type: String, required: true },
    category: { type: String, required: true },
    frequency: { type: String, enum: ['daily', 'hourly'], required: true },
    lastScraped: Date,

    icon: { type: String },
    listSelector: { type: String },       // e.g., .w7Q-4
    linkSelector: { type: String },       // e.g., a
    titleSelector: { type: String },      // e.g., .ORiM7
    imageSelector: { type: String },      // e.g., .jT9Gr img
    contentSelector: { type: String }     // e.g., .story-element.story-element-text p
});

module.exports = mongoose.model('Source', SourceSchema);
