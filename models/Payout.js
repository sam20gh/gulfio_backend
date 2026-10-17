const mongoose = require('mongoose');

/**
 * A monthly revenue-share statement for one publisher group.
 *
 * Generated from AdRevenueEvent (micro-units) × each source's revSharePercent at
 * the moment of generation, then frozen: once a statement is approved or paid,
 * regenerating the month never rewrites it — later rev-share changes affect only
 * future statements. Amounts are stored in USD (the ingest currency).
 */
const PayoutLineSchema = new mongoose.Schema({
    sourceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Source' },
    sourceName: String,
    impressions: { type: Number, default: 0 },
    grossUSD: { type: Number, default: 0 },
    revSharePercent: { type: Number, default: 70 },
    payoutUSD: { type: Number, default: 0 },
}, { _id: false });

const PayoutSchema = new mongoose.Schema({
    groupName: { type: String, required: true },
    // First instant of the statement month (UTC) and first instant of the next.
    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },
    period: { type: String, required: true }, // 'YYYY-MM'
    currency: { type: String, default: 'USD' },
    impressions: { type: Number, default: 0 },
    grossUSD: { type: Number, default: 0 },
    payoutUSD: { type: Number, default: 0 },
    lines: [PayoutLineSchema],
    status: { type: String, enum: ['draft', 'approved', 'paid', 'void'], default: 'draft' },
    method: { type: String, default: '' },      // e.g. bank transfer, PayPal
    reference: { type: String, default: '' },   // transfer reference / invoice number
    notes: { type: String, default: '' },
    approvedAt: Date,
    paidAt: Date,
    createdBy: String,  // email of the admin who generated it
    updatedBy: String,
}, { timestamps: true });

PayoutSchema.index({ groupName: 1, period: 1 }, { unique: true });
PayoutSchema.index({ status: 1, periodStart: -1 });

module.exports = mongoose.model('Payout', PayoutSchema);
