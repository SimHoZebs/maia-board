# AGENTS.md — maia-board

## Checks

Run before finishing any code task:

```sh
scripts/verify.sh               # typecheck + oxfmt + oxlint + vitest + go vet/test
scripts/verify.sh --backend-only
scripts/verify.sh --frontend-only
```

Frontend auto-fix: `(cd frontend && npm run format && npm run lint:fix)`.

Pre-commit runs staged typecheck/vet/gofmt. Pre-push runs full verify.
Node 22, Go per `backend/go.mod`, Python 3.12 for worker tests.

## Grafana observability

Query live logs and traffic first; do not guess from code.

- Dashboard: `Maia Board` (`uid: svc-maia-board`, folder `Debian`).
  Panels are infrastructure only (Traefik traffic, CPU/memory, restarts,
  alerts, warning/error logs). App signals below use Loki queries against
  the same service.
- Loki label: `{container_name="maia-board"}` (also `service_name="maia-board"`).
  Datasources: `Loki` / `Loki Stable` (`uid: loki`).
- Prometheus: `Prometheus` / `Prometheus Stable` (`uid: prometheus`).
  Traefik traffic: `traefik_service_requests_total{service="maia-board@docker"}`.

### Log lines emitted by the backend

| Signal                        | Log prefix                     | Key fields                                                                                                                                                 |
| ----------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Game played / saved           | `game-save`                    | `status, id, plies, model, user_color, elo_maia, elo_user, result, current, new, duration_ms` (`new=true` = first save; per-move re-saves log `new=false`) |
| Game deleted                  | `game-delete`                  | `status, id, duration_ms`                                                                                                                                  |
| Live reply / analysis         | `move`                         | `status, lane=play\|focus, plies, model, degraded, duration_ms, validate_us, exec_ms, wait_ms`                                                             |
| Stockfish search              | `evaluate`                     | `status, plies, policy, duration_ms, validate_us, exec_ms, wait_ms, depth, lines`                                                                          |
| Cache outcome + content       | `eval-content engine=maia\|sf` | `cache=hit\|miss\|live, lane, plies, model, elo, policy, move, wdl`                                                                                        |
| Batch submit                  | `review-batch submit`          | `job, total, cached, pending`                                                                                                                              |
| Batch progress                | `review-batch entry`           | `job, index, engine, role, status, duration_ms, wait_ms, err`                                                                                              |
| Batch done                    | `review-batch finish`          | `job, done, failed, duration_ms`                                                                                                                           |
| Queue pressure (batch caps)   | `review-batch busy`            | `unfinished, sf_queue, large_queue, small_queue` (429 only)                                                                                                |
| Openings                      | `openings`                     | `status, plies, duration_ms`                                                                                                                               |
| Auth login / logout / Lichess | `auth`                         | `status, action=local-login\|logout\|lichess-start\|lichess-callback, user, lichess`                                                                       |
| Bulk history import           | `import-save`                  | `status, user, saved, failed, skipped, new, refreshed, duration_ms`                                                                                        |

`wait_ms` is admission wait inside `exec_ms` (-1 when admission never
reached). On misses `exec_ms - wait_ms` ~= inference + store. Queue signals:
`status=503` (sync slot busy), `status=429` (batch caps), `status=409`
(same-lane supersede), `review-batch busy`, `review-batch submit` pending.
Lane semantics are in [spec/GLOSSARY.md](spec/GLOSSARY.md#lanes).

`POST /move`, `/move/analysis`, `/evaluate` set `X-Eval-Cache: hit|miss`
(sampled play moves omit it; log `cache=live`).

### Example Loki queries (Grafana Explore)

```logql
# Games started per hour (new=true only; frontend re-saves every move)
count_over_time({container_name="maia-board"} |= "game-save status=200" |= "new=true" [1h])

# Games by result / model
{container_name="maia-board"} |= "game-save status=200" | regexp `result="(?P<result>[^"]*)".*model=(?P<model>\S+)`

# Cache hit rate (Maia live + analysis)
sum by (cache) (count_over_time({container_name="maia-board"} |= "eval-content engine=maia" | regexp `cache=(?P<cache>\w+)` [5m]))
# hit / (hit + miss); `live` excluded from cache

# Stockfish cache hit rate
sum by (cache) (count_over_time({container_name="maia-board"} |= "eval-content engine=sf" | regexp `cache=(?P<cache>\w+)` [5m]))

# Batch cache efficiency at submit
{container_name="maia-board"} |= "review-batch submit"
# cached / total = hits; pending = new engine work

# Move latency (live play lane)
{container_name="maia-board"} |= "move status=200 lane=play" | regexp `duration_ms=(?P<ms>\d+)` | unwrap ms

# Queue wait vs engine time (misses only; wait_ms=-1 = no admission)
{container_name="maia-board"} |= "move status=200" | regexp `wait_ms=(?P<wait>\d+)` | unwrap wait
# engine ~= exec_ms - wait_ms; high wait with flat engine = queueing

# Queue pressure
count_over_time({container_name="maia-board"} |= "status=503" [5m])
count_over_time({container_name="maia-board"} |= "status=409" [5m])
{container_name="maia-board"} |= "review-batch busy"
{container_name="maia-board"} |= "review-batch submit"

# Degraded fallback rate (79M -> 5M)
count_over_time({container_name="maia-board"} |= "move status=200" |= "degraded=true" [5m])
/
count_over_time({container_name="maia-board"} |= "move status=200" [5m])

# Errors and busy
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

`svc-maia-board` dashboard lives in the separate `home-server` repo
(Komodo stack). Add app panels with the LogQL above against Loki `loki`.
Keep log lines stable and parseable (`key=value`, one line, stable prefix:
`game-save`, `move`, `evaluate`, `review-batch ...`). Document new signals
in the table above and in `spec/lifecycle-manifest.json` (signals):
`scripts/check-lifecycle-sync.mjs` (run by `scripts/verify.sh`) fails on
route/lane/component/signal/limit drift from code or
`lifecycle-visualization.html`. New endpoints and worker adapters need
manifest entries.
