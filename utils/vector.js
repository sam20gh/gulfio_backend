/**
 * BSON binary float32 vector helpers.
 *
 * Embeddings used to be stored as BSON arrays of doubles. That costs ~13 bytes per
 * dimension (8-byte double + stringified index key + type byte), so a single 1536-D
 * embedding took ~20 KB and the `embedding` field alone was 79% of the whole database.
 * Stored as a BSON Binary vector (subtype 9, float32) the same vector is ~6.1 KB.
 *
 * The conversion is lossless in practice: the embedding API returns float32-precision
 * values, so round-tripping through Float32Array reproduces them exactly.
 *
 * Atlas Vector Search reads binData float32 natively — `vec_full` needs no definition
 * change and reindexes incrementally as documents are written.
 */

const mongoose = require('mongoose');

const { Binary } = mongoose.mongo;

const EMBEDDING_DIMS = 1536;
/** BSON Binary subtype 9 = Vector. 2-byte header (dtype + padding) precedes the payload. */
const VECTOR_HEADER_BYTES = 2;

/**
 * Detect a BSON Binary vector without an `instanceof` check. The backend and the
 * scraper each resolve their own copy of the bson package, so `instanceof Binary`
 * can be false for a perfectly valid Binary that came from the other realm.
 */
function isBinaryVector(value) {
    return !!value && typeof value.toFloat32Array === 'function';
}

/**
 * number[] -> BSON Binary float32 vector, ready to store.
 * Returns null for empty/invalid input so callers can skip the field entirely.
 * Passing an already-converted Binary through is a no-op.
 */
function toVector(values) {
    if (isBinaryVector(values)) return values;
    if (!Array.isArray(values) || values.length === 0) return null;
    return Binary.fromFloat32Array(new Float32Array(values));
}

/**
 * BSON Binary vector | number[] -> number[].
 * Accepts both formats so code keeps working on documents that have not been
 * migrated yet. Returns [] rather than null so `.length` is always safe.
 */
function fromVector(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (isBinaryVector(value)) return Array.from(value.toFloat32Array());
    return [];
}

/**
 * Dimension count for either format, without materialising the array.
 * Use this instead of `embedding.length` — a Binary's `.length` is meaningless here.
 */
function vectorLength(value) {
    if (!value) return 0;
    if (Array.isArray(value)) return value.length;
    if (isBinaryVector(value)) return (value.buffer.length - VECTOR_HEADER_BYTES) / 4;
    return 0;
}

/** True when the value is a usable embedding of the expected dimensionality. */
function isValidEmbedding(value, dims = EMBEDDING_DIMS) {
    return vectorLength(value) === dims;
}

module.exports = {
    EMBEDDING_DIMS,
    toVector,
    fromVector,
    vectorLength,
    isValidEmbedding,
    isBinaryVector,
};
