# AGENTS.md — maia-board

## Checks

Run before finishing any code task:

```sh
scripts/verify.sh               # typecheck + vitest + go vet/test
scripts/verify.sh --backend-only
scripts/verify.sh --frontend-only
```

Pre-commit runs staged typecheck/vet/gofmt. Pre-push runs full verify.
Node 22, Go per `backend/go.mod`, Python 3.12 for worker tests.

## Grafana observability

All runtime performance data is visible through Grafana. Do not guess
from code alone. Query the live logs and traffic first.

- Dashboard: `Maia Board` (`uid: svc-maia-board`, folder `Debian`).
  Current panels are infrastructure only (Traefik traffic, CPU/memory,
  restarts, alerts, warning/error logs). Application signals below come
  from Loki log queries against the same service.
- Loki label: `{container_name="maia-board"}` (also `service_name="maia-board"`).
  Datasources: `Loki` / `Loki Stable` (`uid: loki`).
- Prometheus: `Prometheus` / `Prometheus Stable` (`uid: prometheus`).
  Traefik traffic: `traefik_service_requests_total{service="maia-board@docker"}`.

### Log lines emitted by the backend

| Signal | Log prefix | Key fields |
| --- | --- | --- |
| Game played / saved | `game-save` | `status, id, plies, model, user_color, elo_maia, elo_user, result, current, duration_ms` |
| Game deleted | `game-delete` | `status, id, duration_ms` |
| Live reply / analysis | `move` | `status, lane=play\|focus, plies, model, degraded, duration_ms, validate_us, exec_ms, wait_ms` |
| Stockfish search | `evaluate` | `status, plies, policy, duration_ms, validate_us, exec_ms, wait_ms, depth, lines` |
| Cache outcome + content | `eval-content engine=maia\|sf` | `cache=hit\|miss\|live, lane, plies, model, elo, policy, move, wdl` |
| Batch submit | `review-batch submit` | `job, total, cached, pending` |
| Batch progress | `review-batch entry` | `job, index, engine, role, status, duration_ms, wait_ms, err` |
| Batch done | `review-batch finish` | `job, done, failed, duration_ms` |
| Queue pressure (batch caps) | `review-batch busy` | `unfinished, sf_queue, large_queue, small_queue` (emitted on 429 only) |
| Openings | `openings` | `status, plies, duration_ms` |

`wait_ms` is the admission queue wait inside `exec_ms`
(`-1` when admission was never reached: validation error or cache hit).
On misses `exec_ms - wait_ms` ~= engine inference + store.
Queue size is observed through `wait_ms` distributions plus pressure
signals: `status=503` (sync slot busy, 100 ms wait expired), `status=429`
(batch caps), `status=409` (same-lane supersede), `review-batch busy`
snapshots, and `review-batch submit` pending counts. Scheduler shape:
Play/Focus depth-1 latest-wins, Batch unbounded FIFO, capacity = replicas.

`POST /move`, `/move/analysis`, `/evaluate` also set `X-Eval-Cache: hit|miss`
(sampled play moves omit it and log `cache=live`).

### Example Loki queries (Grafana Explore)

```logql
# Games played per hour
count_over_time({container_name="maia-board"} |= "game-save status=200" [1h])

# Games by result / model
{container_name="maia-board"} |= "game-save status=200" | regexp `result="(?P<result>[^"]*)".*model=(?P<model>\S+)`

# Cache hit rate (Maia live + analysis)
sum by (cache) (count_over_time({container_name="maia-board"} |= "eval-content engine=maia" | regexp `cache=(?P<cache>\w+)` [5m]))
# hit_rate = hit / (hit + miss); `live` = sampled play moves, excluded from cache

# Stockfish cache hit rate
sum by (cache) (count_over_time({container_name="maia-board"} |= "eval-content engine=sf" | regexp `cache=(?P<cache>\w+)` [5m]))

# Batch cache efficiency at submit
{container_name="maia-board"} |= "review-batch submit"
# cached / total = pre-computed hits; pending = new engine work

# Move latency (live play lane)
{container_name="maia-board"} |= "move status=200 lane=play" | regexp `duration_ms=(?P<ms>\d+)` | unwrap ms

# Queue wait vs engine time (misses only; wait_ms=-1 = cache hit / no admission)
{container_name="maia-board"} |= "move status=200" | regexp `wait_ms=(?P<wait>\d+)` | unwrap wait
# engine ~= exec_ms - wait_ms; high wait_ms with flat exec_ms-wait_ms = queueing

# Queue pressure: busy / superseded / capped requests
count_over_time({container_name="maia-board"} |= "status=503" [5m])  # sync slot busy
count_over_time({container_name="maia-board"} |= "status=409" [5m])  # same-lane supersede
{container_name="maia-board"} |= "review-batch busy"  # batch cap snapshot
{container_name="maia-board"} |= "review-batch submit"  # pending = queued engine work

# Degraded fallback rate (79M -> 5M)
count_over_time({container_name="maia-board"} |= "move status=200" |= "degraded=true" [5m])
/
count_over_time({container_name="maia-board"} |= "move status=200" [5m])

# Errors and busy signals
{container_name="maia-board"} |= "status=503" or {container_name="maia-board"} |= "status=502" or {container_name="maia-board"} |= "status=429"
```

### Example Prometheus queries

```promql
# Request rate by status
sum by (code) (rate(traefik_service_requests_total{service="maia-board@docker"}[5m]))

# 5xx spike
sum by (code) (increase(traefik_service_requests_total{service="maia-board@docker", code=~"5.."}[5m]))
```

### Adding panels

The `svc-maia-board` dashboard definition lives in the separate
`home-server` repo (Komodo stack). To add application panels there, use
the LogQL above with Loki datasource `loki`. This repo's job is to keep
the log lines stable and parseable. When adding a new backend signal,
use the `key=value` logfmt style on one line with a stable prefix
(`game-save`, `move`, `evaluate`, `review-batch ...`), and document it
in the table above.
