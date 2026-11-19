const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");

const root = __dirname;
const dataDirectory = path.join(root, "data");
fs.mkdirSync(dataDirectory, { recursive: true });
const database = new DatabaseSync(path.join(dataDirectory, "reshh.sqlite"));
database.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS incidents (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, severity TEXT NOT NULL,
    description TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, timeline TEXT NOT NULL, service_name TEXT
  );
  CREATE TABLE IF NOT EXISTS samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT, sampled_at TEXT NOT NULL,
    cpu_percent REAL, memory_used_bytes INTEGER NOT NULL,
    memory_total_bytes INTEGER NOT NULL, uptime_seconds REAL NOT NULL
  );
  CREATE TABLE IF NOT EXISTS incident_evidence (
    id TEXT PRIMARY KEY, incident_id TEXT NOT NULL, source TEXT NOT NULL,
    observed_at TEXT NOT NULL, classification TEXT NOT NULL, payload TEXT NOT NULL,
    FOREIGN KEY(incident_id) REFERENCES incidents(id)
  );
  CREATE TABLE IF NOT EXISTS recovery_checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT, incident_id TEXT NOT NULL,
    service_name TEXT NOT NULL, checked_at TEXT NOT NULL, status TEXT NOT NULL,
    http_status INTEGER, response_time_ms INTEGER, error TEXT,
    FOREIGN KEY(incident_id) REFERENCES incidents(id)
  );
`);
database.exec("PRAGMA foreign_keys = ON");
if (!database.prepare("PRAGMA table_info(incidents)").all().some(column => column.name === "service_name")) {
  database.exec("ALTER TABLE incidents ADD COLUMN service_name TEXT");
}

const port = Number(process.env.PORT || 8000);
const host = process.env.HOST || "127.0.0.1";
const startedAt = Date.now();
let previousCpu = os.cpus().map(cpu => ({ ...cpu.times }));
let latestMetrics;
let closing = false;

function cpuUsage() {
  const current = os.cpus().map(cpu => cpu.times);
  let idle = 0;
  let total = 0;
  for (let i = 0; i < current.length; i++) {
    const before = previousCpu[i];
    if (!before) continue;
    for (const key of Object.keys(current[i])) {
      const difference = current[i][key] - (before[key] || 0);
      total += difference;
      if (key === "idle") idle += difference;
    }
  }
  previousCpu = current.map(times => ({ ...times }));
  return total > 0 ? Math.round((1 - idle / total) * 1000) / 10 : null;
}

function sampleMetrics() {
  const memory = process.platform === "win32" ? os.totalmem() : os.totalmem();
  const free = os.freemem();
  latestMetrics = {
    sampledAt: new Date().toISOString(),
    cpuPercent: cpuUsage(),
    memoryUsedBytes: memory - free,
    memoryTotalBytes: memory,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    systemUptimeSeconds: os.uptime(),
    host: os.hostname(),
    platform: `${os.platform()} ${os.release()}`,
    processMemoryBytes: process.memoryUsage().rss,
    loadAverage: os.platform() === "win32" ? null : os.loadavg(),
    cpuCount: os.cpus().length
  };
  database.prepare(
    "INSERT INTO samples(sampled_at,cpu_percent,memory_used_bytes,memory_total_bytes,uptime_seconds) VALUES(?,?,?,?,?)"
  ).run(latestMetrics.sampledAt, latestMetrics.cpuPercent, latestMetrics.memoryUsedBytes, memory, latestMetrics.uptimeSeconds);
  database.prepare("DELETE FROM samples WHERE id NOT IN (SELECT id FROM samples ORDER BY id DESC LIMIT 1000)").run();
  return latestMetrics;
}

const incidentSelect = database.prepare("SELECT * FROM incidents ORDER BY created_at DESC");
function incidentFromRow(row) {
  if (!row) return null;
  return { ...row, timeline: JSON.parse(row.timeline) };
}
function allIncidents() {
  return incidentSelect.all().map(incidentFromRow);
}

function evidenceForIncident(id) {
  return database.prepare(
    "SELECT id,source,observed_at,classification,payload FROM incident_evidence WHERE incident_id=? ORDER BY observed_at"
  ).all(id).map(row => ({
    id: row.id,
    source: row.source,
    observedAt: row.observed_at,
    classification: row.classification,
    data: JSON.parse(row.payload)
  }));
}

function saveEvidence(incidentId, source, observedAt, classification, payload) {
  const record = {
    id: `evidence_${Date.now().toString(36)}_${require("node:crypto").randomBytes(4).toString("hex")}`,
    incidentId,
    source,
    observedAt,
    classification,
    data: payload
  };
  database.prepare(
    "INSERT INTO incident_evidence(id,incident_id,source,observed_at,classification,payload) VALUES(?,?,?,?,?,?)"
  ).run(record.id, incidentId, source, observedAt, classification, JSON.stringify(payload));
  return record;
}

function serviceTargets() {
  return [
    { name: "Reshh API", url: `http://127.0.0.1:${port}/api/health` },
    ...configuredServices
  ];
}

function serviceTarget(name) {
  return serviceTargets().find(service => service.name === name);
}

function saveRecoveryCheck(incidentId, serviceName, result) {
  database.prepare(
    "INSERT INTO recovery_checks(incident_id,service_name,checked_at,status,http_status,response_time_ms,error) VALUES(?,?,?,?,?,?,?)"
  ).run(
    incidentId, serviceName, result.checkedAt, result.status,
    result.httpStatus ?? null, result.responseTimeMs ?? null, result.error ?? null
  );
  return saveEvidence(
    incidentId,
    "service_health_check",
    result.checkedAt,
    "measured_backend_http_check",
    { serviceName, ...result }
  );
}

function persistIncident(incident) {
  database.prepare("UPDATE incidents SET status=?,updated_at=?,timeline=?,service_name=? WHERE id=?")
    .run(incident.status, incident.updated_at, JSON.stringify(incident.timeline), incident.service_name || null, incident.id);
}

const configuredServices = (() => {
  try {
    const value = JSON.parse(process.env.RESH_SERVICES || "[]");
    if (!Array.isArray(value)) throw new Error("RESH_SERVICES must be a JSON array");
    return value.map(service => {
      if (!service || typeof service.name !== "string" || typeof service.url !== "string") {
        throw new Error("Each configured service requires string name and url fields");
      }
      const url = new URL(service.url);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error("Service URLs must use HTTP or HTTPS");
      return { name: service.name, url: url.toString() };
    });
  } catch (error) {
    console.error("Invalid RESH_SERVICES configuration:", error.message);
    process.exit(1);
  }
})();

const dockerCommand = process.platform === "win32" ? "docker.exe" : "docker";
let dockerStatus = { status: "checking", detail: "Checking Docker Engine and containers" };
let prometheusStatus = {
  status: "not_configured",
  detail: "Set PROMETHEUS_URL to query a Prometheus server."
};

function runCommand(command, args, timeoutMs) {
  return new Promise(resolve => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", chunk => { stdout += chunk.toString(); });
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.on("error", error => finish({ ok: false, error: error.message, code: error.code, stdout, stderr }));
    child.on("close", code => finish({ ok: code === 0, code, stdout: stdout.trim(), stderr: stderr.trim() }));
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, error: `Command timed out after ${timeoutMs} ms`, stdout: stdout.trim(), stderr: stderr.trim() });
    }, timeoutMs);
    timer.unref();
  });
}

function dockerError(result, command) {
  if (result.code === "ENOENT") return "Docker CLI is not installed or is not on PATH.";
  if (result.error) return result.error;
  return result.stderr || `${command} exited with code ${result.code}.`;
}

async function checkDocker() {
  const [infoResult, containersResult] = await Promise.all([
    runCommand(dockerCommand, ["info", "--format", "{{json .}}"], 3500),
    runCommand(dockerCommand, ["ps", "--all", "--no-trunc", "--format", "{{json .}}"], 3500)
  ]);
  if (!infoResult.ok) {
    return {
      status: "unavailable",
      checkedAt: new Date().toISOString(),
      detail: dockerError(infoResult, "docker info"),
      containers: []
    };
  }
  let info;
  try {
    const raw = JSON.parse(infoResult.stdout);
    info = {
      serverVersion: raw.ServerVersion,
      name: raw.Name,
      operatingSystem: raw.OperatingSystem,
      architecture: raw.Architecture,
      cpuCount: raw.NCPU,
      memoryBytes: raw.MemTotal,
      containers: raw.Containers,
      containersRunning: raw.ContainersRunning,
      containersPaused: raw.ContainersPaused,
      containersStopped: raw.ContainersStopped
    };
  } catch (error) {
    return {
      status: "unavailable",
      checkedAt: new Date().toISOString(),
      detail: `Docker Engine responded, but its info output could not be parsed: ${error.message}`,
      containers: []
    };
  }
  if (!containersResult.ok) {
    return {
      status: "connected",
      checkedAt: new Date().toISOString(),
      detail: `Docker Engine ${info.serverVersion} on ${info.name}; container listing failed: ${dockerError(containersResult, "docker ps")}`,
      info,
      containers: [],
      containersError: dockerError(containersResult, "docker ps")
    };
  }
  try {
    const containers = containersResult.stdout
      ? containersResult.stdout.split(/\r?\n/).filter(Boolean).map(line => {
        const container = JSON.parse(line);
        return {
          id: container.ID,
          name: container.Names,
          image: container.Image,
          state: container.State,
          status: container.Status,
          ports: container.Ports
        };
      })
      : [];
    return {
      status: "connected",
      checkedAt: new Date().toISOString(),
      detail: `Docker Engine ${info.serverVersion} on ${info.name}; ${containers.length} containers returned by the Engine.`,
      info,
      containers
    };
  } catch (error) {
    return {
      status: "connected",
      checkedAt: new Date().toISOString(),
      detail: `Docker Engine ${info.serverVersion} is available, but container output could not be parsed: ${error.message}`,
      info,
      containers: [],
      containersError: error.message
    };
  }
}

const prometheusQueries = [
  { name: "Scraped targets", query: "up" },
  { name: "Node CPU utilization", query: '100 * (1 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])))' },
  { name: "Node memory total", query: "node_memory_MemTotal_bytes" },
  { name: "Node memory available", query: "node_memory_MemAvailable_bytes" },
  { name: "Windows CPU time", query: "windows_cpu_time_total" },
  { name: "Windows memory available", query: "windows_memory_available_bytes" }
];

async function checkPrometheus() {
  const endpoint = process.env.PROMETHEUS_URL;
  if (!endpoint) {
    return {
      status: "not_configured",
      checkedAt: new Date().toISOString(),
      detail: "Set PROMETHEUS_URL to query Prometheus; no Prometheus metrics are currently available.",
      metrics: []
    };
  }
  let base;
  try {
    base = new URL(endpoint);
    if (!["http:", "https:"].includes(base.protocol)) throw new Error("URL must use HTTP or HTTPS");
  } catch (error) {
    return {
      status: "unavailable",
      checkedAt: new Date().toISOString(),
      detail: `PROMETHEUS_URL is invalid: ${error.message}`,
      metrics: []
    };
  }
  const headers = {};
  if (process.env.PROMETHEUS_BEARER_TOKEN) {
    headers.Authorization = `Bearer ${process.env.PROMETHEUS_BEARER_TOKEN}`;
  }
  const healthUrl = new URL("-/healthy", base.toString().endsWith("/") ? base : `${base}/`);
  const queryUrl = new URL("api/v1/query", base.toString().endsWith("/") ? base : `${base}/`);
  try {
    const health = await fetch(healthUrl, { headers, signal: AbortSignal.timeout(2500) });
    if (!health.ok) {
      return {
        status: "unavailable",
        checkedAt: new Date().toISOString(),
        detail: `Prometheus health endpoint returned HTTP ${health.status}.`,
        metrics: []
      };
    }
    const results = await Promise.all(prometheusQueries.map(async item => {
      const requestUrl = new URL(queryUrl);
      requestUrl.searchParams.set("query", item.query);
      try {
        const response = await fetch(requestUrl, { headers, signal: AbortSignal.timeout(3000) });
        if (!response.ok) return { ...item, error: `Prometheus query returned HTTP ${response.status}.`, results: [] };
        const payload = await response.json();
        if (payload.status !== "success") {
          return { ...item, error: payload.error || "Prometheus returned a query error.", results: [] };
        }
        return {
          ...item,
          resultType: payload.data?.resultType || "unknown",
          results: (payload.data?.result || []).slice(0, 100)
        };
      } catch (error) {
        return { ...item, error: `Prometheus query failed: ${error.message}`, results: [] };
      }
    }));
    const failures = results.filter(result => result.error);
    const populated = results.filter(result => result.results.length > 0).length;
    return {
      status: failures.length === results.length ? "unavailable" : "connected",
      checkedAt: new Date().toISOString(),
      detail: failures.length === results.length
        ? `Prometheus health check passed, but all metric queries failed: ${failures[0].error}`
        : `${healthUrl.origin} responded to the Prometheus HTTP API; ${populated}/${results.length} metric queries returned time series${failures.length ? `; ${failures.length} query errors` : ""}.`,
      healthUrl: healthUrl.toString(),
      apiUrl: queryUrl.toString(),
      metrics: results
    };
  } catch (error) {
    return {
      status: "unavailable",
      checkedAt: new Date().toISOString(),
      detail: `Prometheus could not be reached at ${healthUrl.origin}: ${error.message}`,
      metrics: []
    };
  }
}
function refreshIntegrations() {
  checkDocker().then(result => { dockerStatus = result; });
  checkPrometheus().then(result => { prometheusStatus = result; });
}
refreshIntegrations();
setInterval(refreshIntegrations, 15000).unref();

async function checkUrl(url) {
  const start = performance.now();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return {
      status: response.ok ? "healthy" : "degraded",
      httpStatus: response.status,
      responseTimeMs: Math.round(performance.now() - start),
      checkedAt: new Date().toISOString()
    };
  } catch (error) {
    return { status: "unavailable", error: error.message, checkedAt: new Date().toISOString() };
  }
}
async function getServices() {
  return Promise.all(serviceTargets().map(async service => ({
    ...service,
    ...(await checkUrl(service.url))
  })));
}
function integrationState() {
  return {
    localHost: { status: "connected", detail: `Live OS telemetry from ${os.hostname()}` },
    docker: {
      status: dockerStatus.status,
      detail: dockerStatus.detail,
      checkedAt: dockerStatus.checkedAt,
      containerCount: dockerStatus.containers?.length ?? null,
      info: dockerStatus.info,
      containersError: dockerStatus.containersError
    },
    prometheus: prometheusStatus,
    configuredServiceChecks: configuredServices.length
  };
}

function send(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": process.env.CORS_ORIGIN || `http://${host}:${port}`,
    "Access-Control-Allow-Methods": "GET,POST,PATCH,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  response.end(JSON.stringify(value));
}
async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 32768) throw Object.assign(new Error("Request body exceeds 32 KB"), { status: 413 });
  }
  try {
    const value = JSON.parse(body);
    if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("Expected a JSON object");
    return value;
  } catch (error) {
    throw Object.assign(new Error(`Invalid JSON body: ${error.message}`), { status: 400 });
  }
}
function addTimeline(incident, type, message) {
  return [...incident.timeline, { at: new Date().toISOString(), type, message }];
}

async function route(request, response) {
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Origin": process.env.CORS_ORIGIN || `http://${host}:${port}`,
      "Access-Control-Allow-Methods": "GET,POST,PATCH,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    return response.end();
  }
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const pathname = url.pathname;
  if (request.method === "GET" && pathname === "/api/health") {
    return send(response, 200, {
      status: "healthy",
      checkedAt: new Date().toISOString(),
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      database: database.prepare("SELECT 1 AS ok").get().ok === 1 ? "connected" : "unavailable",
      integrations: integrationState()
    });
  }
  if (request.method === "GET" && pathname === "/api/metrics") {
    const limit = Math.max(1, Math.min(300, Number(url.searchParams.get("limit")) || 60));
    const rows = database.prepare("SELECT * FROM samples ORDER BY id DESC LIMIT ?").all(limit).reverse();
    return send(response, 200, {
      current: latestMetrics,
      samples: rows,
      source: "local operating system telemetry (Node.js os APIs; process RSS from node:process)",
      samplingIntervalSeconds: 15,
      prometheus: prometheusStatus
    });
  }
  if (request.method === "GET" && pathname === "/api/services") {
    return send(response, 200, { services: await getServices(), integrations: integrationState() });
  }
  if (request.method === "GET" && pathname === "/api/containers") {
    return send(response, 200, {
      integration: integrationState().docker,
      info: dockerStatus.info || null,
      containers: dockerStatus.containers || [],
      containersError: dockerStatus.containersError || null,
      checkedAt: dockerStatus.checkedAt || null
    });
  }
  if (request.method === "GET" && pathname === "/api/dashboard") {
    const incidents = allIncidents();
    const metrics = latestMetrics;
    return send(response, 200, {
      generatedAt: new Date().toISOString(),
      metrics,
      services: await getServices(),
      integrations: integrationState(),
      incidents: {
        total: incidents.length,
        open: incidents.filter(item => item.status !== "resolved").length,
        critical: incidents.filter(item => item.severity === "critical" && item.status !== "resolved").length,
        recent: incidents.slice(0, 5)
      }
    });
  }
  if (request.method === "GET" && pathname === "/api/incidents") {
    return send(response, 200, { incidents: allIncidents() });
  }
  if (request.method === "POST" && pathname === "/api/incidents") {
    const body = await readJson(request);
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const description = typeof body.description === "string" ? body.description.trim() : "";
    const severity = body.severity;
    if (!title || title.length > 160) return send(response, 400, { error: "title is required and must be at most 160 characters" });
    if (description.length > 4000) return send(response, 400, { error: "description must be at most 4000 characters" });
    if (!["critical", "high", "medium", "low"].includes(severity)) {
      return send(response, 400, { error: "severity must be critical, high, medium, or low" });
    }
    const now = new Date().toISOString();
    const incident = {
      id: `inc_${Date.now().toString(36)}_${require("node:crypto").randomBytes(3).toString("hex")}`,
      title, severity, description, status: "open", created_at: now, updated_at: now,
      service_name: null,
      timeline: [{ at: now, type: "created", message: "Incident reported by an operator." }]
    };
    database.prepare("INSERT INTO incidents(id,title,severity,description,status,created_at,updated_at,timeline,service_name) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(incident.id, incident.title, incident.severity, incident.description, incident.status,
        now, now, JSON.stringify(incident.timeline), null);
    console.info(JSON.stringify({ event: "incident.created", incidentId: incident.id, severity }));
    return send(response, 201, { incident });
  }
  const evidenceMatch = pathname.match(/^\/api\/incidents\/([^/]+)\/evidence$/);
  if (evidenceMatch) {
    const id = decodeURIComponent(evidenceMatch[1]);
    const incident = incidentFromRow(database.prepare("SELECT * FROM incidents WHERE id=?").get(id));
    if (!incident) return send(response, 404, { error: "Incident not found" });
    if (request.method === "GET") {
      return send(response, 200, { incidentId: id, evidence: evidenceForIncident(id) });
    }
    if (request.method !== "POST") return send(response, 405, { error: "Method not allowed" });
    const body = await readJson(request);
    let source;
    let classification;
    let payload;
    let observedAt;
    if (body.type === "host_telemetry") {
      if (!latestMetrics) return send(response, 503, { error: "No operating-system telemetry sample is available yet" });
      source = "local_host_telemetry";
      classification = "measured_host_telemetry";
      observedAt = latestMetrics.sampledAt;
      payload = {
        host: latestMetrics.host,
        platform: latestMetrics.platform,
        cpuPercent: latestMetrics.cpuPercent,
        memoryUsedBytes: latestMetrics.memoryUsedBytes,
        memoryTotalBytes: latestMetrics.memoryTotalBytes,
        systemUptimeSeconds: latestMetrics.systemUptimeSeconds,
        processMemoryBytes: latestMetrics.processMemoryBytes,
        cpuCount: latestMetrics.cpuCount,
        sampledAt: latestMetrics.sampledAt,
        source: "Node.js os APIs and process.memoryUsage()"
      };
    } else if (body.type === "service_check") {
      if (typeof body.serviceName !== "string") {
        return send(response, 400, { error: "serviceName is required for a service check" });
      }
      const target = serviceTarget(body.serviceName);
      if (!target) {
        return send(response, 400, { error: "Select a service returned by GET /api/services" });
      }
      const result = await checkUrl(target.url);
      source = "http_service_check";
      classification = "measured_http_check";
      observedAt = result.checkedAt;
      payload = { serviceName: target.name, url: target.url, ...result };
    } else if (body.type === "operator_note") {
      const note = typeof body.note === "string" ? body.note.trim() : "";
      if (!note || note.length > 2000) {
        return send(response, 400, { error: "note is required and must be at most 2000 characters" });
      }
      source = "operator_note";
      classification = "operator_reported_unverified";
      observedAt = new Date().toISOString();
      payload = { note };
    } else {
      return send(response, 400, { error: "type must be host_telemetry, service_check, or operator_note" });
    }
    const now = new Date().toISOString();
    const evidence = saveEvidence(id, source, observedAt, classification, payload);
    incident.updated_at = now;
    incident.timeline = addTimeline(
      incident,
      "evidence_collected",
      `${source} collected (${classification}) at ${observedAt}.`
    );
    persistIncident(incident);
    console.info(JSON.stringify({ event: "incident.evidence_collected", incidentId: id, source, classification }));
    return send(response, 201, { evidence, incident });
  }
  const match = pathname.match(/^\/api\/incidents\/([^/]+)$/);
  if (request.method === "GET" && match) {
    const incident = incidentFromRow(database.prepare("SELECT * FROM incidents WHERE id=?").get(decodeURIComponent(match[1])));
    return incident ? send(response, 200, { incident }) : send(response, 404, { error: "Incident not found" });
  }
  if (request.method === "PATCH" && match) {
    const id = decodeURIComponent(match[1]);
    const incident = incidentFromRow(database.prepare("SELECT * FROM incidents WHERE id=?").get(id));
    if (!incident) return send(response, 404, { error: "Incident not found" });
    const body = await readJson(request);
    if (body.status === "recovery") {
      return send(response, 400, { error: "Use POST /api/recovery with a monitored serviceName to begin recovery" });
    }
    const transitions = { open: "acknowledged", acknowledged: "investigating", recovery: "resolved" };
    if (body.status !== transitions[incident.status]) {
      return send(response, 400, { error: `Invalid transition from ${incident.status}; expected ${transitions[incident.status] || "no further transition"}` });
    }
    if (body.status === "resolved" && (typeof body.verification !== "string" || !body.verification.trim())) {
      return send(response, 400, { error: "A recovery verification note is required before resolution" });
    }
    let verificationCheck;
    if (body.status === "resolved") {
      const target = incident.service_name && serviceTarget(incident.service_name);
      if (!target) {
        return send(response, 409, { error: "No monitored recovery target is assigned to this incident" });
      }
      verificationCheck = await checkUrl(target.url);
      saveRecoveryCheck(incident.id, target.name, verificationCheck);
      if (verificationCheck.status !== "healthy") {
        return send(response, 409, {
          error: `Recovery was not verified: ${target.name} returned ${verificationCheck.status}. Resolution was not recorded.`,
          verificationCheck
        });
      }
    }
    const now = new Date().toISOString();
    const note = typeof body.note === "string" ? body.note.trim().slice(0, 1000) : "";
    incident.status = body.status;
    incident.updated_at = now;
    incident.timeline = addTimeline(incident, body.status,
      body.status === "resolved" ? `Operator verification: ${body.verification.trim().slice(0, 1000)}. Measured ${incident.service_name} check returned HTTP ${verificationCheck.httpStatus} in ${verificationCheck.responseTimeMs} ms at ${verificationCheck.checkedAt}.` :
        note || `Incident moved to ${body.status}.`);
    persistIncident(incident);
    console.info(JSON.stringify({ event: "incident.updated", incidentId: id, status: body.status }));
    return send(response, 200, { incident, ...(verificationCheck ? { verificationCheck } : {}) });
  }
  if (request.method === "GET" && pathname === "/api/root-cause") {
    const id = url.searchParams.get("incidentId");
    const incident = id
      ? incidentFromRow(database.prepare("SELECT * FROM incidents WHERE id=?").get(id))
      : null;
    if (id && !incident) return send(response, 404, { error: "Incident not found" });
    const samples = database.prepare("SELECT * FROM samples ORDER BY id DESC LIMIT 10").all().reverse();
    const evidence = incident
      ? [
        ...(incident.description ? [{
          source: "operator_incident_description",
          observedAt: incident.created_at,
          classification: "operator_reported_unverified",
          data: { description: incident.description }
        }] : []),
        ...evidenceForIncident(id)
      ]
      : [];
    return send(response, 200, {
      incident,
      evidence,
      hypotheses: [],
      conclusion: evidence.some(item => item.classification === "measured_host_telemetry" || item.classification === "measured_http_check")
        ? "Measurements are available, but no root cause has been verified. These observations do not by themselves establish causation."
        : "No measured incident evidence has been collected. Operator reports are unverified; no root cause is asserted.",
      metrics: samples
    });
  }
  if (request.method === "POST" && pathname === "/api/recovery") {
    const body = await readJson(request);
    if (typeof body.incidentId !== "string") return send(response, 400, { error: "incidentId is required" });
    const id = body.incidentId;
    const incident = incidentFromRow(database.prepare("SELECT * FROM incidents WHERE id=?").get(id));
    if (!incident) return send(response, 404, { error: "Incident not found" });
    if (incident.status !== "investigating") {
      return send(response, 400, { error: "Only incidents under investigation can enter recovery" });
    }
    if (typeof body.serviceName !== "string" || !body.serviceName.trim()) {
      return send(response, 400, { error: "Select a monitored serviceName so recovery can be checked against a real endpoint" });
    }
    const target = serviceTarget(body.serviceName.trim());
    if (!target) {
      return send(response, 400, { error: "serviceName must match a service returned by GET /api/services" });
    }
    const initialCheck = await checkUrl(target.url);
    const now = new Date().toISOString();
    incident.status = "recovery";
    incident.updated_at = now;
    incident.service_name = target.name;
    incident.timeline = addTimeline(
      incident,
      "recovery",
      `Recovery monitoring started for ${target.name}; initial measured check: ${initialCheck.status}${initialCheck.httpStatus ? ` (HTTP ${initialCheck.httpStatus})` : ""}.`
    );
    saveRecoveryCheck(id, target.name, initialCheck);
    persistIncident(incident);
    console.info(JSON.stringify({ event: "recovery.started", incidentId: id }));
    return send(response, 200, { incident, monitoring: latestMetrics, recoveryCheck: initialCheck });
  }
  if (request.method === "GET" && pathname === "/api/recovery") {
    const active = [];
    for (const incident of allIncidents().filter(item => item.status === "recovery")) {
      const target = incident.service_name && serviceTarget(incident.service_name);
      const recoveryCheck = target
        ? await checkUrl(target.url)
        : {
          status: "unavailable",
          error: incident.service_name
            ? `Recovery target '${incident.service_name}' is no longer configured`
            : "No monitored recovery target is assigned",
          checkedAt: new Date().toISOString()
        };
      saveRecoveryCheck(incident.id, incident.service_name || "unconfigured", recoveryCheck);
      active.push({ ...incident, recoveryCheck });
    }
    return send(response, 200, {
      active,
      currentTelemetry: latestMetrics,
      checkedAt: new Date().toISOString()
    });
  }
  if (request.method === "GET" && pathname === "/api/analytics") {
    const counts = database.prepare(
      "SELECT severity, status, COUNT(*) AS count FROM incidents GROUP BY severity,status"
    ).all();
    const samples = database.prepare("SELECT * FROM samples ORDER BY id DESC LIMIT 60").all().reverse();
    return send(response, 200, {
      generatedAt: new Date().toISOString(),
      incidentsBySeverityAndStatus: counts,
      totalIncidents: allIncidents().length,
      telemetry: samples,
      source: "persisted incident records and local operating system measurements"
    });
  }
  if (request.method === "GET" && pathname === "/api/settings") {
    return send(response, 200, {
      host, port,
      integrations: integrationState(),
      configuredServices: configuredServices.map(({ name, url }) => ({ name, url })),
      prometheusBearerTokenConfigured: Boolean(process.env.PROMETHEUS_BEARER_TOKEN),
      dataStore: "SQLite",
      telemetryIntervalSeconds: 15
    });
  }
  return send(response, 404, { error: "API route not found" });
}

function serveStatic(request, response) {
  const pathname = new URL(request.url, "http://localhost").pathname;
  const files = {
    "/": ["index.html", "text/html; charset=utf-8"],
    "/index.html": ["index.html", "text/html; charset=utf-8"],
    "/favicon.svg": ["favicon.svg", "image/svg+xml"],
    "/app.js": ["app.js", "text/javascript; charset=utf-8"],
    "/styles.css": ["styles.css", "text/css; charset=utf-8"]
  };
  const file = files[pathname];
  if (!file) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return response.end("Not found");
  }
  response.writeHead(200, {
    "Content-Type": file[1],
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff"
  });
  fs.createReadStream(path.join(root, "public", file[0])).pipe(response);
}

const server = http.createServer((request, response) => {
  const requestStartedAt = performance.now();
  const pathname = new URL(request.url, `http://${request.headers.host || "localhost"}`).pathname;
  const onComplete = () => console.info(JSON.stringify({
    event: "http.request", method: request.method, path: pathname,
    status: response.statusCode, durationMs: Math.round(performance.now() - requestStartedAt)
  }));
  response.on("finish", onComplete);
  if (pathname.startsWith("/api/")) {
    route(request, response).catch(error => {
      console.error(JSON.stringify({ event: "http.error", path: pathname, error: error.message }));
      if (!response.headersSent) send(response, error.status || 500, { error: error.message || "Internal server error" });
      else response.destroy(error);
    });
  } else if (request.method === "GET") {
    serveStatic(request, response);
  } else {
    send(response, 405, { error: "Method not allowed" });
  }
});

sampleMetrics();
const sampleTimer = setInterval(sampleMetrics, 15000);
server.listen(port, host, () => {
  console.info(`Reshh listening at http://${host}:${port}`);
  console.info(`SQLite database: ${path.join(dataDirectory, "reshh.sqlite")}`);
});

function shutdown(signal) {
  if (closing) return;
  closing = true;
  clearInterval(sampleTimer);
  console.info(`${signal}: closing HTTP server and database`);
  server.close(() => {
    database.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
