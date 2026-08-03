/**
 * Durable checkpoint storage for long-running migrations.
 *
 * These migrations run as Cloud Run jobs, where the container filesystem is ephemeral —
 * a task timeout, a retry, or a re-execution all start from a fresh container. A
 * checkpoint written to disk would be lost exactly when it matters, forcing a full
 * rescan of ~405k documents. Storing it in Mongo means `--resume` works across job
 * executions, which is the only way to resume when you cannot run anything locally.
 *
 * State lives in the `migration_state` collection, one document per migration key.
 */

const COLLECTION = 'migration_state';

/**
 * @param {import('mongodb').Db} db    live database handle
 * @param {string} key                 unique migration id, e.g. 'embedding-binary-vector'
 */
function makeCheckpointStore(db, key) {
    const col = db.collection(COLLECTION);

    return {
        /** Returns the saved state object, or null if this migration has never run. */
        async load() {
            const doc = await col.findOne({ _id: key });
            return doc ? doc.state : null;
        },

        /** Upsert progress. Called once per batch — a single small write. */
        async save(state) {
            await col.updateOne(
                { _id: key },
                { $set: { state, updatedAt: new Date() }, $setOnInsert: { startedAt: new Date() } },
                { upsert: true }
            );
        },

        /** Remove the checkpoint once the migration has completed cleanly. */
        async clear() {
            await col.deleteOne({ _id: key });
        },
    };
}

module.exports = { makeCheckpointStore, COLLECTION };
