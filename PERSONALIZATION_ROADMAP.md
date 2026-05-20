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
| **P1** | Ranking quality | 0 / 6 | 6 |
| **P2** | Performance | 0 / 4 | 4 |
| **P3** | Architecture & telemetry | 0 / 5 | 5 |

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

## P1 — Ranking quality

The next layer. Each of these touches the *output* of personalization (what users see), not just the pipes.

### P1-1 — Smooth time decay
**Why:** `basicRecencyScore` (routes/articles.js:30) is piecewise (1.0 ≤24h, 0.8 ≤48h, etc.). Users see visible "cliffs" at the bucket boundaries — an article that was hot at 23h drops out of consideration at 25h.
**How:** Replace with `exp(-hours / τ)` where τ ≈ 30. Smooth, single tunable, easier to A/B.
**Files:** `routes/articles.js` — `basicRecencyScore` function.

### P1-2 — Personalized engagement signal
**Why:** `viewCount / likes / dislikes` are global popularity counters. Popular ≠ relevant for this user. A Football article going viral globally currently dominates the Business feed.
**How:** Compute per-category z-score (popular *within its category*), use that instead of raw engagement. Cache per-category mean+stddev in Redis with 15-min slot.
**Files:** `routes/articles.js` — `scorePersonalizedCandidates`, `calculateEngagementScore`. New: pre-warmed per-category stats helper.

### P1-3 — Implicit preferred categories
**Why:** `preferred_categories` is explicit-only — users must set it. The system never *learns* from behavior.
**How:** In the daily cron (`jobs/update-user-embeddings.js`), derive an implicit top-3 categories by weighted action count over 30d and merge with the explicit set. Store as `User.implicit_preferred_categories` so we don't overwrite the explicit field.
**Files:** `models/User.js` (new field), `utils/userEmbedding.js`, `routes/articles.js` (use union in `loadUserPersonalizationContext`).

### P1-4 — Exploration / anti-filter-bubble
**Why:** The scorer is fully greedy. Existing affinities get reinforced indefinitely. No way to recover from a wrong inferred preference.
**How:** ε-greedy injection on page 1 — with ~10-15% probability, swap in a high-recency, low-similarity article from a category the user hasn't viewed in 7+ days. Position randomly in the top 10 slots.
**Files:** `routes/articles.js` — after `interleaveBySourceGroup`, before slice.

### P1-5 — Cohere reranker (DORMANT KEY)
**Why:** `COHERE_API_KEY` is set in `backend/.env` line 19 but unused. `services/aiAgentService-backup.js` shows a working `rerank-english-v3.0` integration; current `aiAgentService.js` doesn't use it. You're paying for it and getting nothing.
**How:** On feed (no query), use Cohere's rerank against a "pseudo-query" built from the user's last 20 liked article titles, applied to the top ~80 candidates after the local scorer. Wire behind an A/B flag so we can measure CTR/read-time delta vs control. Skip if Cohere fails — local scorer is the floor.
**Files:** New: `utils/cohereRerank.js`. Hook into `routes/articles.js` between `scorePersonalizedCandidates` and `interleaveBySourceGroup` in `computePersonalizedLight` and `/personalized-fast`.
**Caveat:** Rerank-on-feed (no explicit query) is unconventional. Validate with A/B before rolling out widely.

### P1-6 — Read-time-weighted viewed penalty
**Why:** `viewedPenalty: -3.0` (routes/articles.js:150) is binary. A 6h-old article the user briefly opened is penalized identically to one they fully read 30d ago.
**How:** `UserActivity.create({ eventType: 'read_time', duration })` already exists. In `loadUserPersonalizationContext`, build `viewedReadFractions: Map<articleId, 0..1>`. In `scorePersonalizedCandidates`, scale the penalty by the read fraction.
**Files:** `routes/articles.js` — `loadUserPersonalizationContext`, `scorePersonalizedCandidates`. Possibly an index on `UserActivity({ userId, eventType, timestamp })`.

---

## P2 — Performance

### P2-1 — Cache the user context
**Why:** `loadUserPersonalizationContext` runs one Mongo round-trip per request. Page 1 + page 2 + a category tap = 3 trips in 5s for the same context.
**How:** Cache `ctx` in Redis under `user_ctx:{userId}:{stateHash}` for 5 min. Bust on like/dislike via the per-user cache index already added in P0-1.
**Files:** `routes/articles.js` — `loadUserPersonalizationContext`.

### P2-2 — Conditional embedding projection
**Why:** Pulling `embedding_pca` (128 floats × ~240 candidates ≈ 31KB/request) is wasted bandwidth when the vector contribution doesn't move ranking much (e.g. user has strong category prefs already).
**How:** Log `vectorContribution / totalScore` distribution for a week. If the bottom-half users get <5% ranking change from the vector term, skip the projection for them.
**Files:** `routes/articles.js` — `computePersonalizedLight`, `personalized-fast` candidate query.

### P2-3 — Replace frontend 30s timeout with optimistic placeholder
**Why:** `services/api/articles.ts:280` — native fetch waits 30s on Cloud Run cold start. Users will close the app long before that.
**How:** Always serve from Redis (a "showing recent" pre-warmed list) in <100ms, then quietly swap in the personalized one when it arrives. Stop blocking on the cold compute.
**Files:** Backend: a small `/articles/recent` endpoint that's pre-warmed. Frontend: `services/api/articles.ts` + `ArticleList.tsx` swap logic.

### P2-4 — Heap-based interleave for larger pools
**Why:** `interleaveBySourceGroup` is O(n²) in the worst case on `out.length - last`. Fine at n=240; degrades as we grow the candidate pool.
**How:** Switch to a min-heap keyed by `(score, lastSeenIdx)`. Only matters if P1-5 lands and the candidate pool grows.
**Files:** `routes/articles.js` — `interleaveBySourceGroup`.

---

## P3 — Architecture & telemetry

### P3-1 — A/B framework for `PERS_W`
**Why:** No way to tune scoring weights empirically. Every change is a vibe-based hand-edit.
**How:** Hash userId to a treatment bucket. Pass `treatment` in the response and log alongside `UserActivity`. BigQuery → CTR / read-time deltas per treatment.

### P3-2 — Delete `aiAgentService-backup.js`
**Why:** Dead code referencing `COHERE_API_KEY` makes the wiring ambiguous. Either merge its working pieces into `aiAgentService.js` (and use them in P1-5) or delete it.

### P3-3 — Persist the PCA model
**Why:** `globalPCA` in `utils/pcaEmbedding.js` is fitted in-process on boot from current articles. If the article distribution shifts and the server restarts, every embedding ever produced silently lives in a slightly different 128-D space — silent drift.
**How:** Persist trained PCA components to disk/GCS once. Load on boot. Retrain only on a manual trigger after a known content distribution shift.

### P3-4 — `/related/:id` should respect dislikes
**Why:** `articles_related_*` cache + the route at `routes/articles.js:3318` don't apply `_id $nin disliked_articles`. The carousel can recommend an article the user just disliked.
**How:** Add the dislike filter to the `$vectorSearch` `filter` block and the fallback category match.

### P3-5 — Source quality multiplier
**Why:** Every source is treated equally in scoring. Low-quality scrapers can pollute the feed indefinitely.
**How:** Per source, track `dislikes / (likes + dislikes + ε)` over 30d. Multiply the score contribution by `(1 - quality_penalty)`. Low-quality scrapers self-demote.
**Files:** A new daily aggregation job + a `Source.quality_score` field.

---

## How to use this file

1. Pick the top unticked item from the current tier.
2. Read the relevant file paths (column 3 of each item).
3. Make the change, commit with a `feat(*)` / `perf(*)` / `fix(*)` prefix that maps to the item number (e.g. `perf(scoring): smooth recency decay (P1-1)`).
4. Update the status table at the top.
5. Move to the next.

Don't ship cross-tier — finish a tier before starting the next. P0 is correctness; P1 is what users see; P2 is what the box feels like; P3 is what maintainers feel.