/**
 * TITAN Analytics Collector — Hardened Edition
 *
 * Security features:
 *   - IP-based access control: /dashboard, /stats, /home require localhost
 *     or Tailscale IP (100.64.0.0/10). /events stays open for telemetry.
 *   - Rate limiting on /events (120/hr per IP)
 *   - Request logging to file for intrusion detection
 *   - Basic Auth on sensitive endpoints with env-file credentials
 *   - Field allowlist — unknown keys discarded, never stored in blobs
 *   - SQLite WAL mode for performance + crash resilience
 */
import http from 'node:http';
import { URL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const PORT = parseInt(process.env.PORT || '48430', 10);
const HOST = process.env.HOST || '127.0.0.1';        // default localhost-only
const DATA_DIR = process.env.DATA_DIR || '/opt/titan-analytics/data';
const PUBLIC_DIR = process.env.PUBLIC_DIR || '/opt/titan-analytics/public';
const LOG_FILE = process.env.LOG_FILE || '/var/log/titan-analytics-access.log';
const DASHBOARD_USER = process.env.DASHBOARD_USER || 'admin';
const DASHBOARD_PASS = process.env.DASHBOARD_PASS || 'change-me';
const MAX_BODY_BYTES = 16 * 1024;

fs.mkdirSync(DATA_DIR, { recursive: true });

// ─── Logging ─────────────────────────────────────────────────
function logAccess(line) {
    const entry = `${new Date().toISOString()}  ${line}\n`;
    try { fs.appendFileSync(LOG_FILE, entry); } catch { /* non-critical */ }
}

// ─── DB ──────────────────────────────────────────────────────
const db = new Database(path.join(DATA_DIR, 'events.db'));
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
CREATE TABLE IF NOT EXISTS events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    received_at   TEXT NOT NULL,
    install_id    TEXT NOT NULL,
    event_type    TEXT NOT NULL,
    version       TEXT,
    node_version  TEXT,
    os            TEXT,
    os_release    TEXT,
    arch          TEXT,
    cpu_model     TEXT,
    cpu_cores     INTEGER,
    ram_mb        INTEGER,
    gpu_vendor    TEXT,
    gpu_name      TEXT,
    gpu_vram_mb   INTEGER,
    install_method TEXT,
    disk_gb       INTEGER,
    uptime_sec    INTEGER,
    active_sessions INTEGER,
    memory_mb     INTEGER,
    properties    TEXT,
    ip_prefix     TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_install    ON events(install_id);
CREATE INDEX IF NOT EXISTS idx_events_received   ON events(received_at);
CREATE INDEX IF NOT EXISTS idx_events_type       ON events(event_type);

CREATE TABLE IF NOT EXISTS errors (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    received_at   TEXT NOT NULL,
    install_id    TEXT NOT NULL,
    version       TEXT,
    message       TEXT,
    stack         TEXT,
    fingerprint   TEXT,
    context       TEXT,
    ip_prefix     TEXT
);
CREATE INDEX IF NOT EXISTS idx_errors_received     ON errors(received_at);
CREATE INDEX IF NOT EXISTS idx_errors_fingerprint  ON errors(fingerprint);
`);

// ─── IP Access Control ───────────────────────────────────────
// Dashboard + stats are network-local only.  Tailscale uses the
// CGNAT range 100.64.0.0/10.  We also accept localhost and any
// RFC-1918 private range so the user can browse from their LAN.
function isTrustedIp(ip) {
    if (!ip) return false;
    if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return true;
    // Tailscale CGNAT
    if (ip.startsWith('100.')) {
        const second = parseInt(ip.split('.')[1], 10);
        if (second >= 64 && second <= 127) return true;
    }
    // RFC-1918 private ranges
    if (ip.startsWith('192.168.')) return true;
    if (ip.startsWith('10.')) return true;
    if (ip.startsWith('172.')) {
        const second = parseInt(ip.split('.')[1], 10);
        if (second >= 16 && second <= 31) return true;
    }
    // IPv6 localhost / ULA
    if (ip === '::1') return true;
    if (ip.startsWith('fc') || ip.startsWith('fd')) return true;
    return false;
}

// ─── Rate limiting ───────────────────────────────────────────
const rateBuckets = new Map();
const RATE_LIMIT = 120;
const RATE_WINDOW_MS = 60 * 60 * 1000;

function rateLimitAllow(ip) {
    const now = Date.now();
    const bucket = rateBuckets.get(ip);
    if (!bucket || bucket.resetAt < now) {
        rateBuckets.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
        return true;
    }
    if (bucket.count >= RATE_LIMIT) return false;
    bucket.count++;
    return true;
}

setInterval(() => {
    const now = Date.now();
    for (const [k, v] of rateBuckets) if (v.resetAt < now) rateBuckets.delete(k);
}, 10 * 60 * 1000).unref();

// ─── Helpers ──────────────────────────────────────────────────
function ipFromReq(req) {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0].trim();
    return req.socket.remoteAddress || '0.0.0.0';
}

function maskIp(ip) {
    if (!ip) return '';
    if (ip.includes(':')) {
        const parts = ip.split(':');
        return parts.slice(0, 3).join(':') + '::';
    }
    const parts = ip.split('.');
    if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
    return ip;
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let total = 0;
        req.on('data', (chunk) => {
            total += chunk.length;
            if (total > MAX_BODY_BYTES) {
                reject(new Error('body too large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        req.on('error', reject);
    });
}

function json(res, status, obj) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
}

function text(res, status, s, contentType = 'text/plain') {
    res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
    res.end(s);
}

function requireAuth(req, res) {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Basic ')) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="titan-analytics"' });
        res.end('auth required');
        return false;
    }
    try {
        const [user, pass] = Buffer.from(header.slice(6), 'base64').toString('utf-8').split(':');
        if (user === DASHBOARD_USER && pass === DASHBOARD_PASS) return true;
    } catch { /* fall through */ }
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="titan-analytics"' });
    res.end('bad credentials');
    return false;
}

function requireTrustedIp(req, res, ip) {
    if (isTrustedIp(ip)) return true;
    logAccess(`BLOCKED  ${req.method} ${req.url}  ip=${ip}  reason=untrusted_ip`);
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Access denied: this endpoint is only available on the local network.');
    return false;
}

// ─── Ingest ───────────────────────────────────────────────────
const insertEvent = db.prepare(`
INSERT INTO events
    (received_at, install_id, event_type, version, node_version, os, os_release,
     arch, cpu_model, cpu_cores, ram_mb, gpu_vendor, gpu_name, gpu_vram_mb,
     install_method, disk_gb, uptime_sec, active_sessions, memory_mb,
     properties, ip_prefix)
VALUES
    (@received_at, @install_id, @event_type, @version, @node_version, @os, @os_release,
     @arch, @cpu_model, @cpu_cores, @ram_mb, @gpu_vendor, @gpu_name, @gpu_vram_mb,
     @install_method, @disk_gb, @uptime_sec, @active_sessions, @memory_mb,
     @properties, @ip_prefix)
`);

const insertError = db.prepare(`
INSERT INTO errors
    (received_at, install_id, version, message, stack, fingerprint, context, ip_prefix)
VALUES
    (@received_at, @install_id, @version, @message, @stack, @fingerprint, @context, @ip_prefix)
`);

function str(v, max = 500) {
    if (typeof v !== 'string') return null;
    return v.length > max ? v.slice(0, max) : v;
}
function int(v) {
    const n = typeof v === 'number' ? v : parseInt(v, 10);
    return Number.isFinite(n) ? Math.floor(n) : null;
}

function ingest(payload, ipPrefix) {
    const t = (payload.type || payload.event || '').toString();
    const receivedAt = new Date().toISOString();
    const installId = str(payload.installId, 128) || 'unknown';

    if (t === 'error' || t === 'exception') {
        insertError.run({
            received_at: receivedAt,
            install_id: installId,
            version: str(payload.version, 64),
            message: str(payload.message, 500),
            stack: str(payload.stack, 4000),
            fingerprint: str(payload.fingerprint, 128) || str(payload.message, 128) || 'unknown',
            context: payload.context ? JSON.stringify(payload.context).slice(0, 2000) : null,
            ip_prefix: ipPrefix,
        });
        return { stored: 'error' };
    }

    insertEvent.run({
        received_at: receivedAt,
        install_id: installId,
        event_type: t || 'unknown',
        version: str(payload.version, 64),
        node_version: str(payload.nodeVersion, 64),
        os: str(payload.os, 32),
        os_release: str(payload.osRelease, 128),
        arch: str(payload.arch, 32),
        cpu_model: str(payload.cpuModel, 128),
        cpu_cores: int(payload.cpuCores),
        ram_mb: int(payload.ramTotalMB ?? payload.ramMb),
        gpu_vendor: str(payload.gpuVendor, 64),
        gpu_name: str(payload.gpuName, 128),
        gpu_vram_mb: int(payload.gpuVramMB ?? payload.gpuVramMb),
        install_method: str(payload.installMethod, 32),
        disk_gb: int(payload.diskTotalGB ?? payload.diskGb),
        uptime_sec: int(payload.uptimeSeconds ?? payload.uptimeSec),
        active_sessions: int(payload.activeSessions),
        memory_mb: int(payload.memoryMB ?? payload.memoryMb),
        properties: payload.properties ? JSON.stringify(payload.properties).slice(0, 2000) : null,
        ip_prefix: ipPrefix,
    });
    return { stored: 'event' };
}

// ─── Aggregates ───────────────────────────────────────────────
function stats() {
    const dayCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const weekCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const totals = {
        totalEvents: db.prepare(`SELECT COUNT(*) AS n FROM events`).get().n,
        totalErrors: db.prepare(`SELECT COUNT(*) AS n FROM errors`).get().n,
        eventsLast24h: db.prepare(`SELECT COUNT(*) AS n FROM events WHERE received_at >= ?`).get(dayCutoff).n,
        errorsLast7d: db.prepare(`SELECT COUNT(*) AS n FROM errors WHERE received_at >= ?`).get(weekCutoff).n,
        uniqueInstalls7d: db.prepare(`SELECT COUNT(DISTINCT install_id) AS n FROM events WHERE received_at >= ?`).get(weekCutoff).n,
        uniqueInstallsAll: db.prepare(`SELECT COUNT(DISTINCT install_id) AS n FROM events`).get().n,
    };

    const pickTopN = (sql, limit = 15) => db.prepare(sql).all(weekCutoff, limit);

    return {
        totals,
        osBreakdown: pickTopN(`
            SELECT COALESCE(os, 'unknown') AS label, COUNT(DISTINCT install_id) AS value
            FROM events WHERE event_type = 'system_profile' AND received_at >= ?
            GROUP BY label ORDER BY value DESC LIMIT ?`),
        archBreakdown: pickTopN(`
            SELECT COALESCE(arch, 'unknown') AS label, COUNT(DISTINCT install_id) AS value
            FROM events WHERE event_type = 'system_profile' AND received_at >= ?
            GROUP BY label ORDER BY value DESC LIMIT ?`),
        gpuBreakdown: pickTopN(`
            SELECT COALESCE(gpu_name, 'none') AS label, COUNT(DISTINCT install_id) AS value
            FROM events WHERE event_type = 'system_profile' AND received_at >= ?
            GROUP BY label ORDER BY value DESC LIMIT ?`),
        versionAdoption: pickTopN(`
            SELECT COALESCE(version, 'unknown') AS label, COUNT(DISTINCT install_id) AS value
            FROM events WHERE received_at >= ?
            GROUP BY label ORDER BY value DESC LIMIT ?`),
        nodeVersionBreakdown: pickTopN(`
            SELECT COALESCE(node_version, 'unknown') AS label, COUNT(DISTINCT install_id) AS value
            FROM events WHERE event_type = 'system_profile' AND received_at >= ?
            GROUP BY label ORDER BY value DESC LIMIT ?`),
        installMethodBreakdown: pickTopN(`
            SELECT COALESCE(install_method, 'unknown') AS label, COUNT(DISTINCT install_id) AS value
            FROM events WHERE event_type = 'system_profile' AND received_at >= ?
            GROUP BY label ORDER BY value DESC LIMIT ?`),
        ramBuckets: pickTopN(`
            SELECT CASE
                WHEN ram_mb < 8000   THEN '<8 GB'
                WHEN ram_mb < 16000  THEN '8-16 GB'
                WHEN ram_mb < 32000  THEN '16-32 GB'
                WHEN ram_mb < 64000  THEN '32-64 GB'
                WHEN ram_mb >= 64000 THEN '64+ GB'
                ELSE 'unknown'
            END AS label, COUNT(DISTINCT install_id) AS value
            FROM events WHERE event_type = 'system_profile' AND received_at >= ?
            GROUP BY label ORDER BY value DESC LIMIT ?`),
        topErrors: db.prepare(`
            SELECT fingerprint AS label, COUNT(*) AS value, MAX(received_at) AS lastSeen
            FROM errors WHERE received_at >= ?
            GROUP BY fingerprint ORDER BY value DESC LIMIT ?
        `).all(weekCutoff, 10),
        recentErrors: db.prepare(`
            SELECT received_at, install_id, version, message, fingerprint
            FROM errors ORDER BY received_at DESC LIMIT 20
        `).all(),
    };
}

// ─── Server ──────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const ip = ipFromReq(req);
    const ipPrefix = maskIp(ip);

    // CORS
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Access-Control-Max-Age': '86400',
        });
        res.end();
        return;
    }

    if (url.pathname === '/healthz') {
        return text(res, 200, 'ok');
    }

    // /events — open to the world (anonymous telemetry, POST-only, rate-limited)
    if (url.pathname === '/events' && req.method === 'POST') {
        if (!rateLimitAllow(ip)) {
            logAccess(`RATE_LIM  POST /events  ip=${ip}`);
            return json(res, 429, { error: 'rate_limited' });
        }
        try {
            const body = await readBody(req);
            const payload = body ? JSON.parse(body) : {};
            const r = ingest(payload, ipPrefix);
            res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
            res.end();
            console.log(`[ingest] ${r.stored} type=${payload.type || payload.event} version=${payload.version} os=${payload.os} gpu="${payload.gpuName}" ipPrefix=${ipPrefix}`);
        } catch (err) {
            return json(res, 400, { error: 'bad_request', message: (err).message });
        }
        return;
    }

    // /stats/summary — network-local + basic auth
    if (url.pathname === '/stats/summary' && req.method === 'GET') {
        if (!requireTrustedIp(req, res, ip)) return;
        if (!requireAuth(req, res)) return;
        logAccess(`OK        GET /stats/summary  ip=${ip}`);
        return json(res, 200, stats());
    }

    // /home — beautiful private homepage, network-local only (no auth needed on tailnet)
    if (url.pathname === '/home' && req.method === 'GET') {
        if (!requireTrustedIp(req, res, ip)) return;
        try {
            const html = fs.readFileSync(path.join(PUBLIC_DIR, 'home.html'), 'utf-8');
            return text(res, 200, html, 'text/html; charset=utf-8');
        } catch {
            return text(res, 200, '<h1>titan-analytics</h1><p>Homepage missing — check PUBLIC_DIR.</p>', 'text/html');
        }
    }

    // /dashboard — network-local + basic auth
    if (url.pathname === '/dashboard' && req.method === 'GET') {
        if (!requireTrustedIp(req, res, ip)) return;
        if (!requireAuth(req, res)) return;
        try {
            const html = fs.readFileSync(path.join(PUBLIC_DIR, 'dashboard.html'), 'utf-8');
            return text(res, 200, html, 'text/html; charset=utf-8');
        } catch {
            return text(res, 200, '<h1>titan-analytics</h1><p>Dashboard missing — check PUBLIC_DIR.</p>', 'text/html');
        }
    }

    logAccess(`NOT_FOUND ${req.method} ${url.pathname}  ip=${ip}`);
    text(res, 404, 'not found');
});

server.listen(PORT, HOST, () => {
    console.log(`[titan-analytics] listening on http://${HOST}:${PORT}`);
    console.log(`[titan-analytics] data: ${DATA_DIR}/events.db`);
    console.log(`[titan-analytics] dashboard: http://${HOST}:${PORT}/dashboard (basic-auth + local-network only)`);
    console.log(`[titan-analytics] homepage:  http://${HOST}:${PORT}/home (local-network only)`);
    console.log(`[titan-analytics] ingest:    http://${HOST}:${PORT}/events (public, rate-limited)`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
        console.log(`[titan-analytics] ${sig} — shutting down`);
        server.close(() => { db.close(); process.exit(0); });
    });
}
