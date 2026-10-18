/**
 * A publication applying to publish on Gulfio (Studio → Publisher Portal).
 *
 * One per applicant account. The applicant edits it while it's a draft or has
 * changes requested; admins review it in Studio. Approval creates the Sources,
 * makes the account a publisher for the group, and records what it created in
 * `result` so the decision can be traced later.
 *
 * Secrets are never stored here: API applicants leave an endpoint and docs link,
 * and credentials are arranged with them directly.
 */
const mongoose = require('mongoose');

const STATUSES = ['draft', 'submitted', 'in_review', 'changes_requested', 'approved', 'rejected'];
const FEED_KINDS = ['rss', 'atom', 'sitemap', 'api', 'website', 'youtube', 'instagram'];

const CheckSchema = new mongoose.Schema({ ok: Boolean, detail: String }, { _id: false });

const FeedSchema = new mongoose.Schema({
    kind: { type: String, enum: FEED_KINDS, required: true },
    /** URL for rss/atom/sitemap/api/website; channel ID for youtube; username for instagram. */
    url: { type: String, required: true, trim: true, maxlength: 1000 },
    label: { type: String, trim: true, maxlength: 120 },
    language: { type: String, trim: true, lowercase: true, maxlength: 30 },
    category: { type: String, trim: true, lowercase: true, maxlength: 60 },
    api: {
        docsUrl: { type: String, trim: true, maxlength: 1000 },
        authType: { type: String, enum: ['none', 'api_key', 'bearer', 'basic', 'oauth', 'other', ''], default: '' },
        notes: { type: String, trim: true, maxlength: 2000 },
    },
    /** Last automated look at the feed; Mixed so the probe can grow without migrations. */
    lastTest: { type: mongoose.Schema.Types.Mixed, default: null },
});

const HistorySchema = new mongoose.Schema({
    at: { type: Date, default: Date.now },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    byName: String,
    action: String,
    note: String,
}, { _id: false });

const PublisherApplicationSchema = new mongoose.Schema({
    applicant: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    status: { type: String, enum: STATUSES, default: 'draft', index: true },

    organization: {
        publicationName: { type: String, trim: true, maxlength: 120 },
        legalName: { type: String, trim: true, maxlength: 200 },
        website: { type: String, trim: true, maxlength: 500 },
        country: { type: String, trim: true, maxlength: 60 },
        city: { type: String, trim: true, maxlength: 80 },
        registrationNumber: { type: String, trim: true, maxlength: 80 },
        foundedYear: { type: Number, min: 1800, max: 2100 },
        description: { type: String, trim: true, maxlength: 2000 },
        logoUrl: { type: String, trim: true, maxlength: 1000 },
        languages: [{ type: String, trim: true, lowercase: true }],
        categories: [{ type: String, trim: true, lowercase: true }],
        monthlyReach: { type: String, enum: ['', 'lt_100k', '100k_1m', '1m_10m', 'gt_10m'], default: '' },
        editorialPolicyUrl: { type: String, trim: true, maxlength: 1000 },
        socials: {
            x: { type: String, trim: true, maxlength: 200 },
            instagram: { type: String, trim: true, maxlength: 200 },
            youtube: { type: String, trim: true, maxlength: 200 },
            tiktok: { type: String, trim: true, maxlength: 200 },
            facebook: { type: String, trim: true, maxlength: 200 },
        },
    },

    contact: {
        name: { type: String, trim: true, maxlength: 120 },
        role: { type: String, trim: true, maxlength: 120 },
        email: { type: String, trim: true, lowercase: true, maxlength: 200 },
        phone: { type: String, trim: true, maxlength: 40 },
        correctionsEmail: { type: String, trim: true, lowercase: true, maxlength: 200 },
    },

    domain: {
        host: { type: String, trim: true, lowercase: true, index: true },
        token: String,
        verifiedAt: Date,
        method: { type: String, enum: ['dns', 'meta', 'file', null], default: null },
        lastCheckedAt: Date,
        checks: { dns: CheckSchema, meta: CheckSchema, file: CheckSchema },
    },

    feeds: { type: [FeedSchema], default: [] },

    agreements: {
        contentRights: { type: Boolean, default: false },
        editorialStandards: { type: Boolean, default: false },
        terms: { type: Boolean, default: false },
        acceptedAt: Date,
        acceptedBy: String,
    },

    /** Latest message from the review desk to the applicant. */
    reviewerMessage: { type: String, trim: true, maxlength: 4000 },
    /** Admin-only. Never returned to the applicant. */
    internalNotes: { type: String, trim: true, maxlength: 8000 },

    submittedAt: Date,
    decidedAt: Date,
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    result: {
        groupName: String,
        sourceIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Source' }],
        revSharePercent: Number,
    },
    history: { type: [HistorySchema], default: [] },
}, { timestamps: true });

PublisherApplicationSchema.index({ status: 1, submittedAt: -1 });

PublisherApplicationSchema.statics.STATUSES = STATUSES;
PublisherApplicationSchema.statics.FEED_KINDS = FEED_KINDS;

module.exports = mongoose.model('PublisherApplication', PublisherApplicationSchema);
