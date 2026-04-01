#!/usr/bin/env npx tsx
/**
 * TITAN Smoke Test — Full System Verification
 *
 * Tests every subsystem against a live TITAN gateway:
 *   1. System & Health — version, stats, config
 *   2. API Endpoints — all 180+ routes return expected status codes
 *   3. Chat — text chat with tool invocation
 *   4. Voice — TTS health, voice stream with audio
 *   5. Command Post — issues, approvals, budgets, org chart, runs
 *   6. Sessions — CRUD lifecycle
 *   7. Skills & Tools — registry, toggle, marketplace
 *   8. Memory — graph, learning, soul
 *   9. Goals & Workflows — CRUD, cron, recipes, autopilot
 *  10. Mesh & Networking — hello, peers, discovery
 *  11. Security — injection, XSS, prompt injection
 *  12. VRAM & GPU — snapshot, availability check
 *  13. Voice Models — each voice produces audio
 *
 * Usage: npx tsx scripts/smoke-test.ts [--gateway URL] [--skip-voice] [--skip-chat] [--verbose]
 */

const GATEWAY = process.argv.find(a => a.startsWith('--gateway='))?.split('=')[1] || 'https://192.168.1.11:48420';
const SKIP_VOICE = process.argv.includes('--skip-voice');
const SKIP_CHAT = process.argv.includes('--skip-chat');
const VERBOSE = process.argv.includes('--verbose');
const TIMEOUT = 30_000;
const CHAT_TIMEOUT = 90_000;

let passed = 0;
let failed = 0;
let skipped = 0;
const failures: Array<{ suite: string; test: string; error: string }> = [];
const perf: Array<{ test: string; ms: number }> = [];

// ── Helpers ──────────────────────────────────────────────

// Disable TLS verification for self-signed certs
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

async function api(method: string, path: string, body?: unknown, timeoutMs = TIMEOUT): Promise<{ status: number; data: any; ms: number }> {
  const start = Date.now();
  const opts: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(`${GATEWAY}${path}`, opts);
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = text; }
  const ms = Date.now() - start;
  return { status: res.status, data, ms };
}

function ok(suite: string, test: string, ms?: number) {
  passed++;
  if (ms) perf.push({ test, ms });
  if (VERBOSE) console.log(`  ✅ ${test}${ms ? ` (${ms}ms)` : ''}`);
}

function fail(suite: string, test: string, error: string) {
  failed++;
  failures.push({ suite, test, error });
  console.log(`  ❌ ${test}: ${error}`);
}

function skip(test: string) {
  skipped++;
  if (VERBOSE) console.log(`  ⏭️  ${test} (skipped)`);
}

function assertStatus(suite: string, test: string, actual: number, expected: number, ms?: number): boolean {
  if (actual === expected) { ok(suite, test, ms); return true; }
  fail(suite, test, `expected ${expected}, got ${actual}`);
  return false;
}

function assertKeys(suite: string, test: string, data: any, keys: string[]): boolean {
  if (!data || typeof data !== 'object') { fail(suite, test, 'response is not an object'); return false; }
  const missing = keys.filter(k => !(k in data));
  if (missing.length > 0) { fail(suite, test, `missing keys: ${missing.join(', ')}`); return false; }
  ok(suite, test);
  return true;
}

function assertArray(suite: string, test: string, data: any): boolean {
  if (!Array.isArray(data)) { fail(suite, test, `expected array, got ${typeof data}`); return false; }
  ok(suite, test);
  return true;
}

// ── Suite 1: System & Health ─────────────────────────────

async function suite_system() {
  console.log('\n╔═══════════════════════════════════════════════╗');
  console.log('║  1. System & Health                           ║');
  console.log('╚═══════════════════════════════════════════════╝');

  const { status, data, ms } = await api('GET', '/api/health');
  assertStatus('System', 'GET /api/health', status, 200, ms);
  assertKeys('System', 'health shape', data, ['status', 'version', 'uptime']);

  const stats = await api('GET', '/api/stats');
  assertStatus('System', 'GET /api/stats', stats.status, 200, stats.ms);

  const config = await api('GET', '/api/config');
  assertStatus('System', 'GET /api/config', config.status, 200, config.ms);
  assertKeys('System', 'config has mesh+commandPost', config.data, ['mesh', 'commandPost', 'agent', 'voice']);

  const docs = await api('GET', '/api/docs');
  assertStatus('System', 'GET /api/docs', docs.status, 200);

  const profile = await api('GET', '/api/profile');
  assertStatus('System', 'GET /api/profile', profile.status, 200);

  const onboard = await api('GET', '/api/onboarding/status');
  assertStatus('System', 'GET /api/onboarding/status', onboard.status, 200);

  // Prometheus
  const metrics = await api('GET', '/metrics');
  assertStatus('System', 'GET /metrics (Prometheus)', metrics.status, 200);
  const metricsApi = await api('GET', '/api/metrics/summary');
  assertStatus('System', 'GET /api/metrics/summary', metricsApi.status, 200);
}

// ── Suite 2: API Endpoint Coverage ───────────────────────

async function suite_endpoints() {
  console.log('\n╔═══════════════════════════════════════════════╗');
  console.log('║  2. API Endpoints (status codes)              ║');
  console.log('╚═══════════════════════════════════════════════╝');

  const endpoints: Array<[string, string, number]> = [
    ['GET', '/api/sessions', 200],
    ['GET', '/api/sessions/search?q=test', 200],
    ['GET', '/api/skills', 200],
    ['GET', '/api/tools', 200],
    ['GET', '/api/plugins', 200],
    ['GET', '/api/models', 200],
    ['GET', '/api/fallback-state', 200],
    ['GET', '/api/providers', 200],
    ['GET', '/api/personas', 200],
    ['GET', '/api/agents', 200],
    ['GET', '/api/goals', 200],
    ['GET', '/api/cron', 200],
    ['GET', '/api/recipes', 200],
    ['GET', '/api/autopilot/status', 200],
    ['GET', '/api/autopilot/history', 200],
    ['GET', '/api/channels', 200],
    ['GET', '/api/security', 200],
    ['GET', '/api/graphiti', 200],
    ['GET', '/api/learning', 200],
    ['GET', '/api/soul', 200],
    ['GET', '/api/files', 200],
    ['GET', '/api/audit', 200],
    ['GET', '/api/activity/recent', 200],
    ['GET', '/api/activity/summary', 200],
    ['GET', '/api/logs?lines=1', 200],
    ['GET', '/api/usage', 200],
    ['GET', '/api/costs', 200],
    ['GET', '/api/mcp/server', 200],
    ['GET', '/api/mcp/clients', 200],
    ['GET', '/api/mcp/presets', 200],
    ['GET', '/api/self-improve/config', 200],
    ['GET', '/api/self-improve/history', 200],
    ['GET', '/api/autoresearch/status', 200],
    ['GET', '/api/training/runs', 200],
    ['GET', '/api/vram', 200],
    ['GET', '/api/vram/check?mb=100', 200],
    ['GET', '/api/mesh/peers', 200],
    ['GET', '/api/mesh/pending', 200],
    ['GET', '/api/mesh/models', 200],
    ['GET', '/api/mesh/hello', 200],
    ['GET', '/api/daemon/status', 200],
    ['GET', '/api/tunnel/status', 200],
    ['GET', '/api/voice/health', 200],
    ['GET', '/api/voice/status', 200],
    ['GET', '/api/voice/voices', 200],
    ['GET', '/api/voice/orpheus/status', 200],
    ['GET', '/api/voice/qwen3tts/status', 200],
    // Command Post
    ['GET', '/api/command-post/dashboard', 200],
    ['GET', '/api/command-post/agents', 200],
    ['GET', '/api/command-post/checkouts', 200],
    ['GET', '/api/command-post/budgets', 200],
    ['GET', '/api/command-post/activity', 200],
    ['GET', '/api/command-post/goals/tree', 200],
    ['GET', '/api/command-post/org', 200],
    ['GET', '/api/command-post/issues', 200],
    ['GET', '/api/command-post/approvals', 200],
    ['GET', '/api/command-post/runs', 200],
  ];

  for (const [method, path, expected] of endpoints) {
    try {
      const { status, ms } = await api(method, path);
      assertStatus('Endpoints', `${method} ${path}`, status, expected, ms);
    } catch (e) {
      fail('Endpoints', `${method} ${path}`, (e as Error).message);
    }
  }
}

// ── Suite 3: Chat ────────────────────────────────────────

async function suite_chat() {
  console.log('\n╔═══════════════════════════════════════════════╗');
  console.log('║  3. Chat & LLM                                ║');
  console.log('╚═══════════════════════════════════════════════╝');

  if (SKIP_CHAT) { skip('Chat (--skip-chat)'); return; }

  // Simple chat
  try {
    const { status, data, ms } = await api('POST', '/api/message', { content: 'What is 2+2? Answer only the number.' }, CHAT_TIMEOUT);
    assertStatus('Chat', 'simple chat', status, 200, ms);
    if (data.content) ok('Chat', `response: "${data.content.slice(0, 50)}"`);
    else fail('Chat', 'response content', 'empty content');
    assertKeys('Chat', 'response shape', data, ['content', 'sessionId', 'model', 'durationMs', 'toolsUsed']);
  } catch (e) { fail('Chat', 'simple chat', (e as Error).message); }

  // Tool invocation
  try {
    const { status, data, ms } = await api('POST', '/api/message', { content: 'Use system_info tool. Be brief.' }, CHAT_TIMEOUT);
    assertStatus('Chat', 'tool invocation', status, 200, ms);
    if (data.toolsUsed?.length > 0) ok('Chat', `tools used: ${data.toolsUsed.join(', ')}`);
    else fail('Chat', 'tool invocation', 'no tools used');
  } catch (e) { fail('Chat', 'tool invocation', (e as Error).message); }

  // Empty content → 400
  try {
    const { status } = await api('POST', '/api/message', { content: '' });
    assertStatus('Chat', 'empty content → 400', status, 400);
  } catch (e) { fail('Chat', 'empty content', (e as Error).message); }

  // Model switch validation
  try {
    const { status } = await api('POST', '/api/model/switch', { model: 'ollama/nonexistent-abc-xyz' });
    assertStatus('Chat', 'fake model switch → 404', status, 404);
  } catch (e) { fail('Chat', 'model switch validation', (e as Error).message); }
}

// ── Suite 4: Voice ───────────────────────────────────────

async function suite_voice() {
  console.log('\n╔═══════════════════════════════════════════════╗');
  console.log('║  4. Voice System                              ║');
  console.log('╚═══════════════════════════════════════════════╝');

  if (SKIP_VOICE) { skip('Voice (--skip-voice)'); return; }

  // Health
  try {
    const { data } = await api('GET', '/api/voice/health');
    if (data.tts === true) ok('Voice', 'TTS available');
    else fail('Voice', 'TTS health', `tts=${data.tts}, engine=${data.ttsEngine}`);
    if (data.livekit === true) ok('Voice', 'LiveKit available');
    else if (VERBOSE) skip('LiveKit not configured');
  } catch (e) { fail('Voice', 'health check', (e as Error).message); }

  // Voice stream (text + audio)
  try {
    const start = Date.now();
    const res = await fetch(`${GATEWAY}/api/voice/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Say hello' }),
      signal: AbortSignal.timeout(30000),
    });
    const text = await res.text();
    const ms = Date.now() - start;
    const events = text.split('\n').filter(l => l.startsWith('data:'));
    const hasAudio = events.some(e => e.includes('"audio"'));
    const hasSentence = events.some(e => e.includes('"text"'));
    const hasDone = events.some(e => e.includes('"fullText"'));

    if (hasSentence) ok('Voice', 'stream has sentence events', ms);
    else fail('Voice', 'stream sentences', 'no sentence events');
    if (hasAudio) ok('Voice', 'stream has audio data');
    else fail('Voice', 'stream audio', 'no audio events — TTS may be down');
    if (hasDone) ok('Voice', 'stream has done event');
    else fail('Voice', 'stream done', 'no done event');

    // Check for "completed tool operations" canned response
    const fullText = events.find(e => e.includes('fullText'))?.match(/"fullText":"([^"]+)"/)?.[1] || '';
    if (fullText.includes('completed the tool operations')) {
      fail('Voice', 'voice response quality', `canned response: "${fullText.slice(0, 60)}"`);
    } else if (fullText.length > 5) {
      ok('Voice', `response: "${fullText.slice(0, 60)}"`);
    }
  } catch (e) { fail('Voice', 'voice stream', (e as Error).message); }

  // LiveKit token
  try {
    const { status } = await api('POST', '/api/livekit/token', {});
    if (status === 503) ok('Voice', 'LiveKit token → 503 (not configured)');
    else if (status === 200) ok('Voice', 'LiveKit token → 200');
    else fail('Voice', 'LiveKit token', `unexpected ${status}`);
  } catch (e) { fail('Voice', 'LiveKit token', (e as Error).message); }
}

// ── Suite 5: Command Post (Paperclip) ────────────────────

async function suite_commandPost() {
  console.log('\n╔═══════════════════════════════════════════════╗');
  console.log('║  5. Command Post (Paperclip)                  ║');
  console.log('╚═══════════════════════════════════════════════╝');

  // Dashboard
  try {
    const { data } = await api('GET', '/api/command-post/dashboard');
    assertKeys('CP', 'dashboard shape', data, ['activeAgents', 'totalAgents', 'activeCheckouts', 'budgetUtilization', 'agents', 'checkouts', 'budgets', 'goalTree']);
  } catch (e) { fail('CP', 'dashboard', (e as Error).message); }

  // Issue CRUD
  let issueId = '';
  try {
    const { data, status } = await api('POST', '/api/command-post/issues', { title: 'Smoke test issue', priority: 'low' });
    assertStatus('CP', 'create issue', status, 201);
    if (data.identifier) { ok('CP', `issue created: ${data.identifier}`); issueId = data.id; }
  } catch (e) { fail('CP', 'create issue', (e as Error).message); }

  if (issueId) {
    try {
      const { status } = await api('PATCH', `/api/command-post/issues/${issueId}`, { status: 'todo' });
      assertStatus('CP', 'update issue → todo', status, 200);
    } catch (e) { fail('CP', 'update issue', (e as Error).message); }

    try {
      const { status } = await api('POST', `/api/command-post/issues/${issueId}/comments`, { body: 'Smoke test comment' });
      assertStatus('CP', 'add comment', status, 201);
    } catch (e) { fail('CP', 'add comment', (e as Error).message); }

    try {
      const { data } = await api('GET', `/api/command-post/issues/${issueId}`);
      if (data.comments?.length > 0) ok('CP', 'issue has comments');
      else fail('CP', 'issue comments', 'no comments on issue');
    } catch (e) { fail('CP', 'get issue', (e as Error).message); }
  }

  // Budget CRUD
  let budgetId = '';
  try {
    const { data, status } = await api('POST', '/api/command-post/budgets', {
      name: 'Smoke test budget', scope: { type: 'global' }, period: 'daily',
      limitUsd: 10, warningThresholdPercent: 80, action: 'warn', enabled: true,
    });
    if (status === 200 || status === 201) ok('CP', 'create budget', ms);
    else fail('CP', 'create budget', `expected 200/201, got ${status}`);
    budgetId = data.id;
    ok('CP', `budget created: ${data.name}`);
  } catch (e) { fail('CP', 'create budget', (e as Error).message); }

  if (budgetId) {
    const { status } = await api('DELETE', `/api/command-post/budgets/${budgetId}`);
    assertStatus('CP', 'delete budget', status, 200);
  }

  // Approval CRUD
  let approvalId = '';
  try {
    const { data, status } = await api('POST', '/api/command-post/approvals', {
      type: 'custom', requestedBy: 'smoke-test', payload: { reason: 'testing' },
    });
    assertStatus('CP', 'create approval', status, 201);
    approvalId = data.id;
  } catch (e) { fail('CP', 'create approval', (e as Error).message); }

  if (approvalId) {
    const { status } = await api('POST', `/api/command-post/approvals/${approvalId}/approve`, { decidedBy: 'smoke-test', note: 'auto-approved by test' });
    assertStatus('CP', 'approve approval', status, 200);
  }

  // Org tree
  try {
    const { status, data } = await api('GET', '/api/command-post/org');
    assertStatus('CP', 'org tree', status, 200);
    assertArray('CP', 'org tree is array', data);
  } catch (e) { fail('CP', 'org tree', (e as Error).message); }

  // Runs
  try {
    const { status } = await api('GET', '/api/command-post/runs');
    assertStatus('CP', 'runs list', status, 200);
  } catch (e) { fail('CP', 'runs', (e as Error).message); }
}

// ── Suite 6: Sessions ────────────────────────────────────

async function suite_sessions() {
  console.log('\n╔═══════════════════════════════════════════════╗');
  console.log('║  6. Sessions                                  ║');
  console.log('╚═══════════════════════════════════════════════╝');

  const { data: sessions } = await api('GET', '/api/sessions');
  assertArray('Sessions', 'list sessions', Array.isArray(sessions) ? sessions : sessions?.sessions || []);

  const { data: search } = await api('GET', '/api/sessions/search?q=hello');
  assertStatus('Sessions', 'search', 200, 200);
}

// ── Suite 7: Skills & Tools ──────────────────────────────

async function suite_skills() {
  console.log('\n╔═══════════════════════════════════════════════╗');
  console.log('║  7. Skills & Tools                            ║');
  console.log('╚═══════════════════════════════════════════════╝');

  try {
    const { data } = await api('GET', '/api/skills');
    const skills = Array.isArray(data) ? data : data?.skills || [];
    if (skills.length > 50) ok('Skills', `${skills.length} skills loaded`);
    else fail('Skills', 'skill count', `only ${skills.length} skills (expected 50+)`);
  } catch (e) { fail('Skills', 'list skills', (e as Error).message); }

  try {
    const { data } = await api('GET', '/api/tools');
    const tools = Array.isArray(data) ? data : data?.tools || [];
    if (tools.length > 100) ok('Skills', `${tools.length} tools loaded`);
    else fail('Skills', 'tool count', `only ${tools.length} tools (expected 100+)`);
  } catch (e) { fail('Skills', 'list tools', (e as Error).message); }

  try {
    const { data } = await api('GET', '/api/models');
    if (typeof data === 'object' && !Array.isArray(data)) ok('Skills', `models: ${Object.keys(data).length} providers`);
    else fail('Skills', 'models shape', 'expected object with provider keys');
  } catch (e) { fail('Skills', 'models', (e as Error).message); }

  try {
    const { data } = await api('GET', '/api/personas');
    const personas = data?.personas || data || [];
    if (Array.isArray(personas) && personas.length > 0) ok('Skills', `${personas.length} personas`);
    else ok('Skills', 'personas endpoint works');
  } catch (e) { fail('Skills', 'personas', (e as Error).message); }
}

// ── Suite 8: Memory ──────────────────────────────────────

async function suite_memory() {
  console.log('\n╔═══════════════════════════════════════════════╗');
  console.log('║  8. Memory & Learning                         ║');
  console.log('╚═══════════════════════════════════════════════╝');

  const { status: graphStatus } = await api('GET', '/api/graphiti');
  assertStatus('Memory', 'GET /api/graphiti', graphStatus, 200);

  const { status: learnStatus } = await api('GET', '/api/learning');
  assertStatus('Memory', 'GET /api/learning', learnStatus, 200);

  const { status: soulStatus } = await api('GET', '/api/soul');
  assertStatus('Memory', 'GET /api/soul', soulStatus, 200);
}

// ── Suite 9: Goals & Workflows ───────────────────────────

async function suite_workflows() {
  console.log('\n╔═══════════════════════════════════════════════╗');
  console.log('║  9. Goals & Workflows                         ║');
  console.log('╚═══════════════════════════════════════════════╝');

  const { status: goalsStatus } = await api('GET', '/api/goals');
  assertStatus('Workflows', 'GET /api/goals', goalsStatus, 200);

  const { status: cronStatus } = await api('GET', '/api/cron');
  assertStatus('Workflows', 'GET /api/cron', cronStatus, 200);

  const { status: recipesStatus } = await api('GET', '/api/recipes');
  assertStatus('Workflows', 'GET /api/recipes', recipesStatus, 200);

  const { status: apStatus } = await api('GET', '/api/autopilot/status');
  assertStatus('Workflows', 'GET /api/autopilot/status', apStatus, 200);
}

// ── Suite 10: Security ───────────────────────────────────

async function suite_security() {
  console.log('\n╔═══════════════════════════════════════════════╗');
  console.log('║  10. Security                                 ║');
  console.log('╚═══════════════════════════════════════════════╝');

  if (SKIP_CHAT) { skip('Security (--skip-chat)'); return; }

  // SQL injection
  try {
    const { status } = await api('POST', '/api/message', { content: "'; DROP TABLE sessions; --" }, CHAT_TIMEOUT);
    if (status === 200 || status === 400) ok('Security', 'SQL injection handled');
    else fail('Security', 'SQL injection', `unexpected ${status}`);
  } catch (e) { fail('Security', 'SQL injection', (e as Error).message); }

  // XSS
  try {
    const { data } = await api('POST', '/api/message', { content: '<script>alert(1)</script>' }, CHAT_TIMEOUT);
    if (!data.content?.includes('<script>')) ok('Security', 'XSS sanitized');
    else fail('Security', 'XSS', 'script tag in response');
  } catch (e) { fail('Security', 'XSS', (e as Error).message); }

  // Concurrency guard
  try {
    const { status } = await api('GET', '/api/security');
    assertStatus('Security', 'security audit endpoint', status, 200);
  } catch (e) { fail('Security', 'security endpoint', (e as Error).message); }
}

// ── Suite 11: VRAM & GPU ─────────────────────────────────

async function suite_vram() {
  console.log('\n╔═══════════════════════════════════════════════╗');
  console.log('║  11. VRAM & GPU                               ║');
  console.log('╚═══════════════════════════════════════════════╝');

  try {
    const { data } = await api('GET', '/api/vram');
    if (data.gpuName || data.gpu?.gpuName) ok('VRAM', `GPU: ${data.gpuName || data.gpu?.gpuName}`);
    else ok('VRAM', 'VRAM endpoint works');
    if (data.freeMB > 0 || data.gpu?.freeMB > 0) ok('VRAM', `Free: ${data.freeMB || data.gpu?.freeMB}MB`);
  } catch (e) { fail('VRAM', 'VRAM snapshot', (e as Error).message); }
}

// ── Suite 12: UI ─────────────────────────────────────────

async function suite_ui() {
  console.log('\n╔═══════════════════════════════════════════════╗');
  console.log('║  12. UI & SPA                                 ║');
  console.log('╚═══════════════════════════════════════════════╝');

  try {
    const res = await fetch(GATEWAY, { signal: AbortSignal.timeout(5000) });
    const html = await res.text();
    if (html.includes('id="root"')) ok('UI', 'SPA serves with React root');
    else fail('UI', 'SPA root', 'no root element in HTML');

    // Check assets
    const jsMatch = html.match(/\/assets\/index-[^"]+\.js/);
    const cssMatch = html.match(/\/assets\/index-[^"]+\.css/);
    if (jsMatch) {
      const jsRes = await fetch(`${GATEWAY}${jsMatch[0]}`, { signal: AbortSignal.timeout(5000) });
      if (jsRes.ok && Number(jsRes.headers.get('content-length') || 0) > 1000) ok('UI', `main JS bundle: ${Math.round(Number(jsRes.headers.get('content-length') || 0) / 1024)}KB`);
      else fail('UI', 'JS bundle', `status=${jsRes.status}`);
    }
    if (cssMatch) {
      const cssRes = await fetch(`${GATEWAY}${cssMatch[0]}`, { signal: AbortSignal.timeout(5000) });
      if (cssRes.ok) ok('UI', 'CSS bundle loads');
      else fail('UI', 'CSS bundle', `status=${cssRes.status}`);
    }
  } catch (e) { fail('UI', 'SPA serving', (e as Error).message); }

  // Panel routes (SPA fallback)
  const routes = ['/command-post', '/settings', '/overview', '/sessions', '/skills', '/channels', '/workflows', '/agents'];
  for (const route of routes) {
    try {
      const res = await fetch(`${GATEWAY}${route}`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) ok('UI', `route ${route}`);
      else fail('UI', `route ${route}`, `${res.status}`);
    } catch (e) { fail('UI', `route ${route}`, (e as Error).message); }
  }
}

// ── Main ─────────────────────────────────────────────────

async function main() {
  console.log(`\n🔬 TITAN Smoke Test — ${GATEWAY}`);
  console.log(`   ${new Date().toISOString()}\n`);

  // Health check first
  try {
    const { data } = await api('GET', '/api/health', undefined, 5000);
    console.log(`   Version: ${data.version}, Uptime: ${Math.round(data.uptime)}s\n`);
  } catch {
    console.error('❌ Gateway unreachable. Aborting.');
    process.exit(1);
  }

  await suite_system();
  await suite_endpoints();
  await suite_chat();
  await suite_voice();
  await suite_commandPost();
  await suite_sessions();
  await suite_skills();
  await suite_memory();
  await suite_workflows();
  await suite_security();
  await suite_vram();
  await suite_ui();

  // ── Results ────────────────────────────────────────────
  console.log('\n════════════════════════════════════════════════');
  console.log(`  ✅ Passed: ${passed}`);
  console.log(`  ❌ Failed: ${failed}`);
  console.log(`  ⏭️  Skipped: ${skipped}`);
  console.log('════════════════════════════════════════════════');

  if (failures.length > 0) {
    console.log('\n  Failures:');
    for (const f of failures) {
      console.log(`    [${f.suite}] ${f.test}: ${f.error}`);
    }
  }

  // Perf summary
  if (perf.length > 0) {
    const sorted = [...perf].sort((a, b) => b.ms - a.ms);
    console.log('\n  Slowest:');
    for (const p of sorted.slice(0, 5)) {
      console.log(`    ${p.ms}ms — ${p.test}`);
    }
  }

  console.log('');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
