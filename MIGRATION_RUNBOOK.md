# Database migration runbook (Cloud Run Jobs)

Two one-off migrations, run as Cloud Run Jobs because they stream every article's
embedding and can't practically run from Cloud Shell or a laptop.

| Job | Script | What it does |
|---|---|---|
| `gulfio-migrate-embeddings` | `scripts/migrateEmbeddingsToBinaryVector.js` | `articles.embedding`: BSON array of doubles → Binary float32 vector. Reclaims ~5 GB (the field was 79% of the database). |
| `gulfio-reproject-pca` | `scripts/retrainAndReprojectPCA.js` | Retrains the canonical PCA basis, then re-projects every article, reel and user `embedding_pca` into it. |

Both need exactly one secret: `MONGO_URI`. They never call the embedding API.

---

## 0. Push the code

Cloud Shell clones from GitHub, so the commits must be on `origin/main` first:

```bash
git push origin main            # in backend/
```

## 1. Register the jobs

In Cloud Shell:

```bash
git clone git@github.com:sam20gh/gulfio_backend.git
cd gulfio_backend
chmod +x deploy-migration-job.sh
./deploy-migration-job.sh                 # defaults to region me-central1
```

The script builds a lean image (`Dockerfile.migration` — no Chrome/ffmpeg/Puppeteer
browser, so it builds in about a minute) and registers both jobs. It resolves
`MONGO_URI` from the environment, then `.env`, then by reading it back off the deployed
`gulfio-backend` service — so in Cloud Shell you don't paste a database password.

It does **not** execute anything.

## 2. Run them, in this order

```bash
REGION=me-central1
PROJECT=grub24-217509

# Step 1 — storage format. Byte-exact and idempotent.
gcloud run jobs execute gulfio-migrate-embeddings --region $REGION --project $PROJECT --wait

# Step 2 — PCA retrain + re-projection.
gcloud run jobs execute gulfio-reproject-pca --region $REGION --project $PROJECT --wait
```

**Order matters.** Step 2 reads every article's 1536-D embedding: ~7.7 GB as arrays vs
~2.3 GB as binary float32. Running step 1 first makes step 2 roughly 3x cheaper.

Watch progress:

```bash
gcloud beta run jobs logs tail gulfio-migrate-embeddings --region $REGION --project $PROJECT
```

Dry runs first, if you want counts without writes:

```bash
gcloud run jobs execute gulfio-migrate-embeddings --region $REGION --project $PROJECT --wait \
  --args="--max-old-space-size=1536,scripts/migrateEmbeddingsToBinaryVector.js,--dry-run"
```

## 3. Redeploy — required

Backend and scraper-job each cache the PCA basis in memory per process and will keep
serving the **old** basis until they restart:

```bash
cd backend      && ./deploy.sh
cd scraper-job  && ./deploy.sh
```

Until this is done the feed is not coherent. (It isn't today either — see below — so
this is not a new regression, but the fix isn't live until the redeploy lands.)

---

## Safety properties

- **Idempotent.** Re-running either job is free; already-converted documents are skipped.
- **Resumable across executions.** Checkpoints live in the Mongo `migration_state`
  collection, not the container filesystem, because Cloud Run containers are ephemeral —
  a disk checkpoint would vanish on exactly the timeout or retry where it matters.
  `--resume` is baked into the job args: a first run finds no checkpoint and starts
  fresh; a retry continues where the previous task died.
- **Retry-safe retraining.** `retrainAndReprojectPCA` auto-skips the retrain step when it
  resumes. A retry that retrained would produce a *different* basis and silently
  invalidate every document already re-projected.
- **Least privilege.** The jobs get `MONGO_URI` and nothing else.
- Task timeout is 24h with 3 retries; realistically both finish far inside that.

## Verification (already done before shipping)

- Storage format: 26,244 B → 11,996 B on a real document (69.8% off the field, 54.3% off
  the doc), byte-exact — the embedding API already returns float32-precision values.
- `vec_full` ranks mixed array/binData documents correctly in a single result set, so the
  migration is safe to run gradually against live traffic with no reindex.
- PCA: re-projected articles score cosine **1.000000** against the persisted basis;
  untouched controls score 0.03–0.21. scraper-job's own projection now matches
  backend-written vectors at 1.000000.

## Why the PCA job exists

`scraper-job/utils/pcaEmbedding.js` had no `PCAModel` import — it trained its own 128-D
basis in-process on every cold start from a rotating sample. The backend loads the
persisted `article_embedding_pca_v1` and builds user vectors with it. So the personalized
feed was comparing query vectors and article vectors from two different coordinate
systems (median |cos| ~0.1 corpus-wide, uniform across every article age). Reels drifted
the same way, and user vectors blend reel vectors, mixing bases a third time.

## Afterwards

`dataSize` drops immediately (~9.2 GB → ~4.2 GB), but `storageSize` only returns to the
OS after a compact or rolling resync — WiredTiger keeps freed blocks for reuse.
