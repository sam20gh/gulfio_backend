# Match Alerts (goal/kickoff/full-time pushes for followed teams)

`POST /api/football/poll-live-alerts` (header `x-api-key: $ADMIN_API_KEY`) runs one
polling pass: fetches all live fixtures from api-football, diffs against the
previous pass's snapshot in Redis (`matchalert:active`), and pushes
goal/kickoff/full-time alerts to followers of the involved teams. Full time is
detected by disappearance — a followed fixture present last pass but gone from
the live payload has finished, and its full-time alert is sent from the
last-known score.

- Targeted pushes — **not** counted against the 2/day broadcast budget, **not**
  quiet-hours filtered (European kickoffs are 22:00–24:00 Gulf time).
- Users opt out via the `matchAlerts` notification setting (default on).
- Idempotent per score state: first sighting mid-match baselines silently, so
  scheduler gaps or redeploys never cause alert storms.

## Scheduling (Cloud Scheduler)

Every 2 minutes during match hours (≈14:00–24:00 Gulf = 10:00–20:00 UTC),
~300 api-football calls/day:

```bash
gcloud scheduler jobs create http gulfio-match-alerts \
  --schedule="*/2 10-19 * * *" \
  --time-zone="UTC" \
  --uri="https://api.gulfio.app/api/football/poll-live-alerts" \
  --http-method=POST \
  --headers="x-api-key=$ADMIN_API_KEY" \
  --attempt-deadline=60s
```

For late Champions-League nights extend the hour range (`10-21`). Each pass is
one api-football request regardless of match count.

## Response / observability

```json
{ "liveFixtures": 41, "relevant": 3, "events": 1, "devicesNotified": 220 }
```

`relevant` = live fixtures involving at least one followed team. Logged to
Cloud Run stdout on every pass.

## Notes / limits

- Full-time uses disappearance from the `live=all` payload. A transient
  api-football hiccup that drops then re-adds a fixture could in theory send an
  early full-time followed by a fresh silent baseline; acceptable for the alert
  cadence, and the snapshot self-heals next pass.
- If Redis is unavailable, the pass is skipped entirely (fail-closed) rather
  than risking duplicate goal/full-time storms.
- The `matchalert:active` snapshot has a 6h TTL; a scheduler gap longer than
  that simply re-baselines (a match in progress across the gap won't get a
  full-time alert).
