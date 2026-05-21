/**
 * Experiments Framework (P3-1).
 *
 * Hash userId to a stable bucket so the same user always sees the same
 * treatment within an experiment. Treatments can override PERS_W
 * weights or feature flags; the scorer reads its weights through
 * `getEffectivePersW(treatment)` instead of the global PERS_W
 * directly.
 *
 * To add a variant:
 *   1. Add an entry to TREATMENTS below with its weight overrides.
 *   2. Adjust the EXPERIMENT.buckets array to include it.
 *   3. Deploy. The treatment will start being assigned on next request.
 *   4. Query UserActivity grouped by `treatment` for the metric you
 *      care about. Compare against 'control'.
 *
 * Currently ships with only `control` configured — no variants are
 * being run. The infrastructure is in place so any future A/B can be
 * wired without touching the scorer or the logging path.
 */

const crypto = require('crypto');

/**
 * Registry of treatments. Each treatment is identified by a stable
 * string ID (logged + returned to the client) and may carry weight
 * overrides + feature-flag overrides.
 *
 * persWOverrides: partial map merged onto PERS_W at score time.
 * Anything not specified uses the default in routes/articles.js.
 *
 * flags: per-treatment overrides for feature flags. Today none — but
 * this is where you'd put e.g. { explorationRate: 0.20 } or
 * { cohereRerankEnabled: true }.
 */
const TREATMENTS = {
  control: {
    persWOverrides: null,
    flags: null,
  },
  // Example future variants (commented out — uncomment when ready to test):
  // category_heavy: { persWOverrides: { categoryAffinity: 4.5 }, flags: null },
  // vector_heavy:   { persWOverrides: { vector: 8.0 },           flags: null },
};

/**
 * The single active experiment. Adding more would mean per-experiment
 * bucketing (independent hashes), which we don't need yet.
 */
const EXPERIMENT = {
  id: 'scoring_v1',
  // Buckets are matched in order — equal-weight by default since the
  // array determines distribution via modulo on the hash. Keeping all
  // 100% control until variants are wired.
  buckets: ['control'],
};

/**
 * Deterministic, fast hash. crypto.createHash gives us a stable bucket
 * even across deploys (no PRNG state). MD5 chosen for speed — we're not
 * doing crypto, just consistent assignment.
 */
function hashUserToBucket(userId, experimentId, bucketCount) {
  if (!userId || bucketCount < 1) return 0;
  const h = crypto
    .createHash('md5')
    .update(`${experimentId}:${userId}`)
    .digest();
  // Read first 4 bytes as uint32, mod into bucket count
  const n = h.readUInt32BE(0);
  return n % bucketCount;
}

/**
 * Assign a treatment for the given userId. Guests / anonymous → control.
 * Always returns a valid treatment ID, never null — the framework's
 * default state is "everyone is control".
 */
function getTreatmentForUser(userId) {
  if (!userId) return 'control';
  const idx = hashUserToBucket(userId, EXPERIMENT.id, EXPERIMENT.buckets.length);
  const id = EXPERIMENT.buckets[idx];
  return TREATMENTS[id] ? id : 'control';
}

/**
 * Produce the effective PERS_W for a treatment by merging overrides
 * onto the default. Default PERS_W is imported via the callback so
 * we don't create a circular require with routes/articles.js.
 */
function getEffectivePersW(treatmentId, defaultPersW) {
  const t = TREATMENTS[treatmentId];
  if (!t || !t.persWOverrides) return defaultPersW;
  return { ...defaultPersW, ...t.persWOverrides };
}

/**
 * Effective flag value for a treatment. Returns the override if set,
 * else the fallback (typically the env-var-based default).
 */
function getTreatmentFlag(treatmentId, flagName, fallback) {
  const t = TREATMENTS[treatmentId];
  if (t?.flags && Object.prototype.hasOwnProperty.call(t.flags, flagName)) {
    return t.flags[flagName];
  }
  return fallback;
}

module.exports = {
  EXPERIMENT_ID: EXPERIMENT.id,
  TREATMENTS,
  getTreatmentForUser,
  getEffectivePersW,
  getTreatmentFlag,
};
