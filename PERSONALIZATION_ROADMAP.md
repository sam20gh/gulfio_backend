# Gulfio Personalization Roadmap

Tracking the work to harden and improve the home-feed personalization pipeline. Originally derived from a full audit of the path:

```
app/index.tsx → ArticleList → services/api/articles.ts
  → backend /articles/personalized-light | personalized-fast
            | personalized-category | following
  → MongoDB + Redis
```

Frontend in `menaApp/components/ArticleList.tsx` (React Query infinite list, page 1 native fetch, pages 2+ axios). Backend route logic in `routes/articles.js`. User embeddings in `utils/userEmbedding.js`. Daily cron in `jobs/update-user-embeddings.js`.

---

## Status snapshot

| Tier | Theme | Done | Total |
|---|---|---|---|
| **P0** | Correctness & risk | **5 / 5** ✅ | 5 |
| **P1** | Ranking quality | **6 / 6** ✅ | 6 |
| **P2** | Performance | **4 / 4** ✅ | 4 |
| **P3** | Architecture & telemetry | **5 / 5** ✅ | 5 |

**All 20 audit items resolved.** P0-P2 added ranking, performance, and correctness wins. P3 established the telemetry + persistence foundation: A/B framework, deterministic PCA, source quality multiplier, dislike-aware related carousel.

---

## P0 — DONE

All shipped on `main`. Worth eyeballing in staging before the next prod push.

| # | Commit | Headline |
|---|---|---|
| P0-1 | `56a7c37` | Replaced `redis.KEYS` scan on every like/dislike with a per-user cache index (`user_cache_keys:{userId}` set). Hot path is now O(N over this user's keys), not O(N over the whole keyspace). |
| P0-4 | `56a3530` | `/articles/personalized-category` now uses the same scorer/interleaver as `/personalized-light` — embeddings, following boost, preferred-source boost, disliked-category penalty. Previously it was recency + flat `0.1`. |
| P0-5 | `651218c` | Following feed: deleted a dead duplicate `/following` route, kept the better one, added 24h → 3d → 7d → 30d progressive widening so a user following 2 low-volume sources doesn't get an empty feed. Added `language` to the projection for RTL. |
| P0-2 | `22d5ff6` | Stale-while-revalidate for `/personalized-light`: two-tier cache (`fresh` rotates per stateHash+slot, `stale` survives across rotations). NX-locked background regen. New `X-Cache: fresh\|stale\|miss` response header. |
| P0-3 | `f4f11f4` | Article like/dislike now does a cheap O(128) **EMA blend** of the user's `embedding_pca` (mirrors the reels path in `routes/user.js`). Drops the `updateUserProfileEmbedding(_id)` call from the hot path — that was ~500-2000ms of work and an OpenAI call per reaction. Cold-start users get their vector seeded by their first like. Daily cron still does full re-aggregation. |

### Verification checklist for staging

- [ ] Hit `/articles/personalized-light` twice with a JWT — second request inside 10 min returns `X-Cache: fresh`.
- [ ] Wait for the 10-min slot to rotate, hit again — should be `X-Cache: stale` and a `♻️ pers-v2 light SWR regen done` log line should appear.
- [ ] Like an article, immediately call `/personalized-light` — feed reflects the change (stateHash rotation already handled this; SWR also kicks).
- [ ] OpenAI usage dashboard: embedding spend should drop noticeably (was ~1 call per like/dislike).
- [ ] Brand-new account → log in → like one article → confirm `User.embedding_pca` is now populated (length 128) without waiting for 02:00 UTC cron.
- [ ] Tap a category chip → feed loads — verify `X-Personalized: vector` for users with embeddings.

---

## P1 — DONE

All 6 shipped. The home feed is now substantially more personalized than the recency-and-popularity model it had a week ago.

| # | Commit | Headline |
|---|---|---|
| P1-1 | `fd4f5e4` | Replaced piecewise `basicRecencyScore` with continuous `exp(-hours/τ)` where τ=72h. Single-knob recency tuning; also fixed a real monotonicity bug where articles just past 168h scored higher than at exactly 168h. |
| P1-3 | `948f2b7` | `User.implicit_preferred_categories` derived nightly from 30d weighted action history (reuses the article fetch the cron already does). Merged with explicit `preferred_categories` in `loadUserPersonalizationContext` — `categoryAffinity` term now fires for users who never tapped the explicit settings. |
| P1-6 | `e688a1a` | Sourced the viewed signal from `UserActivity` (was missing — `User.viewed_articles` is essentially never written by current routes). Scaled `viewedPenalty` by `min(1, totalReadTime/60)`, so a glance gets a light penalty and a full read gets the full -3.0. |
| P1-2 | `c4ea6f7` | Engagement term now uses per-category z-score (cached 15min) instead of global tanh(rawEng/80). Below-average articles for a category get an active penalty; viral articles in heavy categories no longer dominate cross-category. |
| P1-4 | `c25d67b` | ε-greedy exploration: 12% of page-1 requests for signal users get a random low-similarity article injected into slot 2-7. Marked with `_explorationInjected` and `X-Explore: 1` for telemetry. |
| P1-5 | `4ea54ea` | Cohere `rerank-multilingual-v3.0` wired into `computePersonalizedLight`, feature-flagged via `COHERE_RERANK_ENABLED=1` (default off). Pseudo-query built from last 20 liked titles, cached 30min. Strictly additive — falls back to local order on any failure. The dormant `COHERE_API_KEY` is now load-bearing. |

### P1 verification checklist for staging

- [ ] Hit `/personalized-light` for a user with no signal — should see `X-Personalized: none`, recency-only feed.
- [ ] Same user after 5+ likes — should see `X-Personalized: vector` and a different article ordering.
- [ ] Inspect a same-category article's score path: `_score` should reflect z-score engagement (look at `X-Personalized` and the verbose log line — `signal=true` and stats showing).
- [ ] Refresh `/personalized-light` ~20 times — roughly 2-3 responses should carry `X-Explore: 1` and have an article tagged `_explorationInjected: true`.
- [ ] Set `COHERE_RERANK_ENABLED=1` in env, deploy, hit `/personalized-light` — should see `X-Rerank: 1` for users with ≥3 likes and a `🎯 Cohere rerank applied` log line.
- [ ] Confirm Arabic/Farsi feed still works with rerank on (multilingual model).
- [ ] Trigger the daily cron manually (`POST /api/jobs/update-user-embeddings`) — confirm `User.implicit_preferred_categories` populates for active users.
- [ ] Verify a user with 30s read of article X gets a smaller subsequent score penalty than a user with 90s read of the same article.

---

## P2 — DONE

All 4 P2 items resolved. P2-4 was investigated and rejected (the original audit was wrong about its complexity); the other three shipped.

| # | Commit | Headline |
|---|---|---|
| P2-1 | `5b56d4a` | `loadUserPersonalizationContext` now caches the full ctx (Sets/Maps round-tripped) in Redis at `user_ctx_v1_{userId}` for 5 min. Tracked via the per-user cache index so `/react` invalidates it automatically. |
| P2-3 | `6b95087` + `de16ef8` | New pre-warmed `/articles/recent` endpoint (<5ms Redis served), refreshed every ~4.5 min. Frontend page-1 fetch does a 1.5s soft race against `/personalized-light` — cold-start users see articles in ~200ms instead of waiting 5-15s for Cloud Run. The slower personalized call still completes server-side and fills the SWR cache for the next request. |
| P2-2 | `3eae435` | Vector-contribution telemetry: scorer now logs the % of total score attributable to the vector term. Feature-flagged conditional skip via `PERS_SKIP_VECTOR_FOR_HEAVY_PREFS=1` for users with ≥4 preferred categories AND ≥3 followed source groups. Default off — turn on after a week of telemetry confirms which user profiles see <5% vector contribution. |
| P2-4 | *(rejected)* | The original audit claimed `interleaveBySourceGroup` was O(n²). Benchmark proved otherwise: O(n), ~28μs at n=240, ~200μs at n=25k. A heap variant would be slower (O(log k) vs O(1) Map ops). Function now carries a complexity docstring so this isn't reopened. |

### P2 verification checklist for staging

- [ ] Hit `/personalized-light` twice in succession — second call's ctx should load from Redis (no `📈 Found N recent activities` log on the second hit).
- [ ] Tap a category chip then return to the main feed — confirm the chip's `/personalized-category` ctx load is also cached (no second UserActivity aggregation).
- [ ] Cold-start: open a fresh app build with `personalized_articles_cache` cleared in AsyncStorage — feed should paint in <500ms thanks to `/articles/recent` race winning.
- [ ] Verify the `📦 [SOFT-RACE]` log line fires when personalized takes >1.5s.
- [ ] Set `PERS_LOG_VECTOR_PCT=1` in env — every personalized request should emit `📐 vector contribution for X: N%`. Collect data for a week before flipping `PERS_SKIP_VECTOR_FOR_HEAVY_PREFS=1`.
- [ ] Confirm `/articles/recent?language=arabic` returns Arabic results and is pre-warmed in Redis.

---

## P3 — DONE

| # | Commit | Headline |
|---|---|---|
| P3-2 | `f946a1f` | Deleted 791 lines of dead `aiAgentService-backup.js`. No references anywhere in the codebase. |
| P3-4 | `08911e1` + `5ae3ea7` | `/articles/related/:id` now optionally accepts a JWT; when present, filters out the user's disliked articles + categories from both the `$vectorSearch` post-match and all three fallback Mongo queries. Frontend forwards the token via a new `fetchRelatedArticles` helper. Cache key bumped to `v3-dislikes` so stale unfiltered results can't be served. |
| P3-5 | `2d242e8` | New `Source.quality_score ∈ [0,1]` (smoothed dislike ratio over 30d). Computed nightly by `jobs/update-source-quality.js`. Scorer multiplies the **positive** score component (not penalties) by it — low-quality scrapers self-demote without disappearing. `POST /api/jobs/update-source-quality` admin endpoint for manual + Cloud Scheduler. |
| P3-3 | `b28d587` | PCA model persisted to a `pca_models` Mongo collection. Boot loads via `PCA.load(persisted.model)` instead of retraining; first-time cold boots train and save once. `POST /api/jobs/retrain-pca` admin endpoint for explicit retrain after a content distribution shift. The 128-D basis is now deterministic across deploys. |
| P3-1 | `c24e3c0` | A/B framework infrastructure. `utils/experiments.js` ships with stable userId → treatment bucketing (MD5 hash mod buckets — verified 1% balance on 10k samples), per-treatment `PERS_W` overrides, and a treatment registry. `UserActivity.treatment` field + index for join. `X-Treatment` and `X-Experiment` response headers. Scorer reads effective weights via `getEffectivePersW`. Today only `control` is configured — variants are wired by uncommenting a single entry in `TREATMENTS`. |

### P3 verification checklist for staging

- [ ] `grep -r aiAgentService-backup` returns nothing (P3-2).
- [ ] A logged-in user who has disliked article X opens article Y → confirm X is not in the carousel response. Verify in the response headers / network tab that the JWT was sent.
- [ ] Run `POST /api/jobs/update-source-quality` with the admin key — check Mongo for `Source.quality_score` and `quality_score_updated_at`. Confirm sources scoring <0.7 appear in the logs.
- [ ] Restart the backend; `globalPCA` should load from Mongo in <1s with a "✅ PCA loaded from Mongo" log line. `db.pca_models.findOne({name:'article_embedding_pca_v1'})` should return a doc with `trainedAt`.
- [ ] Hit `/personalized-light` — response should include `X-Treatment: control` and `X-Experiment: scoring_v1`. Like an article and confirm `UserActivity` doc has `treatment: 'control'`.
- [ ] (Future) Add a variant to `TREATMENTS` in `utils/experiments.js`, deploy, and verify the bucket distribution in `UserActivity` aggregation grouped by `treatment`.

---

## How to use this file

1. Pick the top unticked item from the current tier.
2. Read the relevant file paths (column 3 of each item).
3. Make the change, commit with a `feat(*)` / `perf(*)` / `fix(*)` prefix that maps to the item number (e.g. `perf(scoring): smooth recency decay (P1-1)`).
4. Update the status table at the top.
5. Move to the next.

Don't ship cross-tier — finish a tier before starting the next. P0 is correctness; P1 is what users see; P2 is what the box feels like; P3 is what maintainers feel.

 What ships next

  A few things are infrastructure ready but need product/ops decisions before they're load-bearing:

  1. COHERE_RERANK_ENABLED=1 — wired in P1-5 but default-off. Flip in staging after one A/B confirms it helps.
  2. PERS_SKIP_VECTOR_FOR_HEAVY_PREFS=1 — wired in P2-2 but default-off. Turn on after a week of 📐 vector contribution logs.
  3. Cloud Scheduler entries — add the cron job for POST /api/jobs/update-source-quality (02:30 UTC) and consider one for POST /api/jobs/retrain-pca only on
  demand.
  4. A/B variants — utils/experiments.js has commented-out example variants. Uncomment when you have a hypothesis and a way to measure outcomes.
  5. menaApp commits to push: de16ef8 (P2-3 soft-race) and 5ae3ea7 (P3-4 JWT). Both currently sit unpushed on main.

  The system is now meaningfully more personalized, more observable, more resilient to restarts, and gives you the levers to keep tuning it without writing
  more code.