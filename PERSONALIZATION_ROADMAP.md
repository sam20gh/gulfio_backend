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