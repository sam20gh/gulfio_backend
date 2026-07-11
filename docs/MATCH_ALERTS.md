# Match Alerts (goal/kickoff pushes for followed teams)

`POST /api/football/poll-live-alerts` (header `x-api-key: $ADMIN_API_KEY`) runs one
polling pass: fetches all live fixtures from api-football, diffs scores against
Redis state, and pushes goal/kickoff alerts to followers of the involved teams.

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

## Known limits (v1)

- Full-time alerts are not sent (fixtures leave the `live=all` payload at FT;
  detecting it needs a disappearance check — follow-up).
- If Redis is unavailable, passes are silent (fail-closed) rather than risking
  duplicate goal alerts.
