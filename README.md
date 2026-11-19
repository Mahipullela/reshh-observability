# Reshh

Local-first observability and incident-response dashboard. It serves the browser app and REST API from one Node.js process and persists incidents and telemetry samples in SQLite.

## Run on Windows

Requires Node.js 22.5 or newer; no npm install is needed.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\start.ps1
```

Startup returns after a bounded HTTP health check and opens the dashboard in your default browser. It reuses an already healthy server, rejects an occupied port that is not Reshh, and logs server output under `data\`. The managed process ID, port, and script path are recorded in `data\reshh-server.json`. Stop the managed server with `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\stop.ps1`. The dashboard is at `http://127.0.0.1:8000/`; health endpoint: `http://127.0.0.1:8000/api/health`. Change the port using `$env:PORT=8001` before starting. The server binds to loopback by default. To expose it on a trusted network, set `HOST=0.0.0.0` and configure an appropriate firewall and `CORS_ORIGIN`; do not expose this unauthenticated local tool to the public internet.

## Verified and optional integrations

System CPU (computed from actual OS CPU counter deltas), memory, uptime, host, platform, core count, and process RSS come from Node.js operating-system/process APIs. Telemetry samples, incident lifecycle changes, evidence, and recovery checks are stored in `data/reshh.sqlite`; the frontend refreshes every 15 seconds. Windows load average is omitted because Node.js does not provide a real Windows load-average reading.

Docker integration executes `docker info` and `docker ps` and displays only daemon data those commands return. An installed CLI without a reachable daemon is shown as unavailable with the CLI's actual error.

Prometheus can be configured with its base URL and optional bearer token. Reshh calls `/-/healthy` and the Prometheus `/api/v1/query` endpoint for `up`, common node-exporter CPU/memory, and Windows-exporter CPU/memory series. Empty query results are shown as empty; exporter metrics are not synthesized.

```powershell
$env:PROMETHEUS_URL='http://127.0.0.1:9090/'
# Optional; only set this when your Prometheus endpoint requires bearer authentication.
$env:PROMETHEUS_BEARER_TOKEN='<your-token>'
```

Additional HTTP(S) health checks can be configured as a JSON array:

```powershell
$env:RESH_SERVICES='[{"name":"Orders API","url":"http://127.0.0.1:9000/health"}]'
```

Cloud integrations, log ingestion, authentication and public hosting are not configured. Root-cause evidence distinguishes operator-reported details from measured host telemetry and HTTP checks; the application does not assert an unverified cause or create sample incidents.

Incident transitions are persisted and must follow `open` → `acknowledged` → `investigating` → `recovery` → `resolved`. Evidence can be captured from actual host telemetry, actual monitored-service HTTP checks, or explicitly marked as an unverified operator note. Recovery requires selecting an actual configured monitored endpoint; a failed check prevents resolution, and a passing check plus an operator verification note are both recorded. The process writes structured HTTP and incident events to stdout.
