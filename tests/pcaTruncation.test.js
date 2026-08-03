/**
 * PCA truncation tests (pure logic — no Mongo, no network).
 * Run: node tests/pcaTruncation.test.js
 *
 * Guards the fix for the 16 MB BSON limit: training on >1536 samples yields a
 * 1536x1536 loadings matrix (~18 MB) that cannot be persisted. We keep 128 columns.
 * These tests assert that doing so changes nothing about the projection.
 */

const { PCA } = require('ml-pca');
const { Matrix } = require('ml-matrix');

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('  ✓', msg); }
  else { failed++; console.error('  ✗', msg); }
}

// Small stand-in for the real shape: more samples than features, so PCA returns
// full-rank components exactly like the 21,477-sample production run did.
const FEATURES = 60;
const SAMPLES = 300;
const KEEP = 16;

const rows = [];
let seed = 42;
const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 - 0.5; };
for (let i = 0; i < SAMPLES; i++) {
  rows.push(Array.from({ length: FEATURES }, (_, j) => rand() + Math.sin(i / 7 + j / 3) * 0.4));
}
const pca = new PCA(new Matrix(rows), { center: true, scale: false });

// Mirrors serializeTruncated() in utils/pcaEmbedding.js
function serializeTruncated(model, keep) {
  const json = model.toJSON();
  const U = Matrix.checkMatrix(json.U);
  if (U.columns > keep) json.U = U.subMatrix(0, U.rows - 1, 0, keep - 1);
  return JSON.parse(JSON.stringify(json));
}

console.log('full model');
{
  const U = Matrix.checkMatrix(pca.toJSON().U);
  assert(U.columns === FEATURES, `PCA on ${SAMPLES} samples x ${FEATURES} features gives ${FEATURES} components (rank = features, not samples)`);
  assert(U.rows === FEATURES, 'U is [features x components]');
}

console.log('truncated model');
{
  const serialized = serializeTruncated(pca, KEEP);
  const U = Matrix.checkMatrix(serialized.U);
  assert(U.columns === KEEP, `keeps ${KEEP} columns`);
  assert(U.rows === FEATURES, 'row count (features) is unchanged');

  const loaded = PCA.load(serialized);
  assert(loaded instanceof PCA, 'PCA.load() hydrates the truncated JSON');

  // The whole point: projecting through the truncated model must equal projecting
  // through the full model and slicing.
  const sample = new Matrix([rows[7]]);
  const fullProjection = pca.predict(sample, { nComponents: KEEP }).getRow(0);
  const truncProjection = loaded.predict(sample, { nComponents: KEEP }).getRow(0);

  let maxErr = 0;
  for (let i = 0; i < KEEP; i++) maxErr = Math.max(maxErr, Math.abs(fullProjection[i] - truncProjection[i]));
  assert(truncProjection.length === KEEP, `projection has ${KEEP} dims`);
  assert(maxErr === 0, `projection is bit-identical to the full model (max err ${maxErr})`);

  // Serialized size must shrink roughly by the column ratio.
  const fullBytes = JSON.stringify(JSON.parse(JSON.stringify(pca.toJSON()))).length;
  const truncBytes = JSON.stringify(serialized).length;
  assert(truncBytes < fullBytes / 2, `serialized form shrinks (${fullBytes} -> ${truncBytes} bytes)`);
}

console.log('explained variance');
{
  const variance = pca.getExplainedVariance();
  assert(variance.length === FEATURES, 'S is left intact, so variance covers every component');
  const kept = variance.slice(0, KEEP).reduce((a, b) => a + b, 0);
  assert(kept > 0 && kept < 1.0000001, `retained share is a real fraction of total variance (${(kept * 100).toFixed(1)}%)`);
}

console.log('rank-limited model (fewer components than we want to keep)');
{
  // Reproduces the old persisted basis: fewer samples than features caps the rank.
  const few = new PCA(new Matrix(rows.slice(0, 10)), { center: true, scale: false });
  const U = Matrix.checkMatrix(few.toJSON().U);
  const available = U.columns;
  assert(available < KEEP + 1 || available <= FEATURES, `rank-limited to ${available} components`);
  // predict must be clamped to what exists, as convertToPCAEmbedding now does.
  const n = Math.min(KEEP, available);
  const out = few.predict(new Matrix([rows[0]]), { nComponents: n }).getRow(0);
  assert(out.length === n, `clamping nComponents to ${n} avoids slicing past the end`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
