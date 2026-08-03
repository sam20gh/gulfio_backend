/**
 * BSON binary float32 vector helper tests (pure logic — no Mongo, no network).
 * Run: node tests/vector.test.js
 */

const mongoose = require('mongoose');
const {
  EMBEDDING_DIMS,
  toVector,
  fromVector,
  vectorLength,
  isValidEmbedding,
  isBinaryVector,
} = require('../utils/vector');

const { Binary } = mongoose.mongo;

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log('  ✓', msg);
  } else {
    failed++;
    console.error('  ✗', msg);
  }
}

const sample = Array.from({ length: EMBEDDING_DIMS }, (_, i) => Math.sin(i) * 0.05);

console.log('toVector');
{
  const bin = toVector(sample);
  assert(bin instanceof Binary, 'returns a BSON Binary');
  assert(bin.sub_type === 9, 'uses subtype 9 (Vector)');
  assert(bin.buffer.length === EMBEDDING_DIMS * 4 + 2, 'payload is 4 bytes/dim + 2-byte header');
  assert(toVector(bin) === bin, 'passing a Binary through is a no-op (idempotent migration)');
  assert(toVector([]) === null, 'empty array -> null so callers can omit the field');
  assert(toVector(null) === null, 'null -> null');
  assert(toVector(undefined) === null, 'undefined -> null');
}

console.log('fromVector');
{
  const decoded = fromVector(toVector(sample));
  assert(Array.isArray(decoded), 'returns a plain array');
  assert(decoded.length === EMBEDDING_DIMS, 'preserves dimensionality');

  let maxErr = 0;
  for (let i = 0; i < sample.length; i++) maxErr = Math.max(maxErr, Math.abs(sample[i] - decoded[i]));
  assert(maxErr < 1e-7, `float32 round-trip error is negligible (${maxErr.toExponential(2)})`);

  // Values that are already float32-exact — as the embedding API returns — survive intact.
  const exact = Array.from(new Float32Array(sample));
  assert(
    fromVector(toVector(exact)).every((v, i) => v === exact[i]),
    'float32-precision input round-trips byte-exactly'
  );

  assert(fromVector(sample).length === EMBEDDING_DIMS, 'legacy array passes through unchanged');
  assert(fromVector(null).length === 0, 'null -> [] so .length is always safe');
  assert(fromVector(undefined).length === 0, 'undefined -> []');
}

console.log('vectorLength');
{
  assert(vectorLength(toVector(sample)) === EMBEDDING_DIMS, 'counts dims of a Binary vector');
  assert(vectorLength(sample) === EMBEDDING_DIMS, 'counts dims of a legacy array');
  assert(vectorLength([]) === 0, 'empty array -> 0');
  assert(vectorLength(null) === 0, 'null -> 0');
  assert(vectorLength({}) === 0, 'unrecognised value -> 0 rather than throwing');
}

console.log('isValidEmbedding');
{
  assert(isValidEmbedding(toVector(sample)), 'accepts a full-dimension Binary vector');
  assert(isValidEmbedding(sample), 'accepts a full-dimension legacy array');
  assert(!isValidEmbedding(toVector(sample.slice(0, 128))), 'rejects a truncated Binary vector');
  assert(!isValidEmbedding([]), 'rejects an empty array');
  assert(!isValidEmbedding(null), 'rejects null');
  assert(isValidEmbedding(toVector(sample.slice(0, 128)), 128), 'honours an explicit dims argument');
}

console.log('isBinaryVector');
{
  assert(isBinaryVector(toVector(sample)), 'detects a Binary vector');
  assert(!isBinaryVector(sample), 'an array is not a Binary vector');
  assert(!isBinaryVector(null), 'null is not a Binary vector');
  // Duck-typed on purpose: backend and scraper-job resolve separate bson copies, so a
  // cross-realm Binary must still be recognised.
  assert(isBinaryVector({ toFloat32Array: () => new Float32Array(2) }), 'duck-types across bson realms');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
