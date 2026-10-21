import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

async function fixture(t, transport = 'http') {
  const calls = [];
  const gateway = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    calls.push({ path: req.url, body: body ? JSON.parse(body) : null });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.method === 'GET'
      ? { tools: [{ name: 'fixture_echo', description: 'Synthetic tool.', parameters: { type: 'object' } }] }
      : { echoed: JSON.parse(body).args }));
  });
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  const child = fork(fileURLToPath(new URL('./server-fixture.mjs', import.meta.url)), [], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    execArgv: ['--import', 'tsx'],
    env: { ...process.env, MCP_TRANSPORT: transport, MCP_PORT: '0', TITAN_URL: `http://127.0.0.1:${gateway.address().port}` },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });
  let output = '', errors = '';
  child.stdout.on('data', (chunk) => output += chunk);
  child.stderr.on('data', (chunk) => errors += chunk);
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill();
      await once(child, 'exit');
    }
    gateway.closeAllConnections();
    await new Promise((resolve) => gateway.close(resolve));
  });
  if (transport === 'stdio') return { child, calls, output: () => output };
  const bound = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(`Fixture did not listen: ${errors}`)), 10000);
    child.once('message', (message) => { clearTimeout(timer); resolve(message.bound); });
    child.once('exit', (code) => { clearTimeout(timer); reject(Error(`Fixture exited ${code}: ${errors}`)); });
  });
  return { child, calls, bound, url: `http://127.0.0.1:${bound.port}/mcp` };
}

const request = (name = 'fixture_echo') => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { text: 'café 🧭' } } });

test('HTTP transport binds only loopback and retains a valid gateway tool call', async (t) => {
  const f = await fixture(t);
  assert.equal(f.bound.address, '127.0.0.1');
  const response = await fetch(f.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request()) });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(JSON.parse(result.result.content[0].text), { echoed: { text: 'café 🧭' } });
  assert.deepEqual(f.calls, [{ path: '/api/tools/fixture_echo/call', body: { args: { text: 'café 🧭' } } }]);
});

test('an oversized HTTP request returns 413 without calling the gateway', async (t) => {
  const f = await fixture(t);
  const body = JSON.stringify({ ...request(), params: { name: 'fixture_echo', arguments: { text: 'x'.repeat(1_048_577) } } });
  for (const streamed of [false, true]) {
    const response = await fetch(f.url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: streamed ? new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(body)); controller.close(); } }) : body,
      ...(streamed ? { duplex: 'half' } : {}),
    });
    assert.equal(response.status, 413);
  }
  assert.deepEqual(f.calls, []);
});

test('HTTP bodies preserve UTF-8 characters split between network chunks', async (t) => {
  const f = await fixture(t);
  const body = Buffer.from(JSON.stringify(request()));
  const split = body.indexOf(Buffer.from('🧭')) + 1;
  const result = await new Promise((resolve, reject) => {
    const req = httpRequest(f.url, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
    });
    req.on('error', reject);
    req.write(body.subarray(0, split));
    setImmediate(() => req.end(body.subarray(split)));
  });
  assert.deepEqual(JSON.parse(result.result.content[0].text), { echoed: { text: 'café 🧭' } });
});

test('cross-origin browser requests cannot trigger local tools', async (t) => {
  const f = await fixture(t);
  const response = await fetch(f.url, { method: 'POST', headers: { Origin: 'https://untrusted.invalid', 'Content-Type': 'text/plain' }, body: JSON.stringify(request()) });
  assert.equal(response.status, 403);
  assert.deepEqual(f.calls, []);
});

test('stdio keeps initialize, discovery and tool-call replies without third-party runtime dependencies', async (t) => {
  const f = await fixture(t, 'stdio');
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'initialize' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { ...request(), id: 3 },
  ];
  const exited = once(f.child, 'exit');
  f.child.stdin.end(messages.map(JSON.stringify).join('\n') + '\n');
  assert.equal((await exited)[0], 0);
  const replies = f.output().split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));
  assert.equal(replies.length, 3);
  assert.equal(replies[0].result.serverInfo.name, 'titan-mcp');
  assert.equal(replies[1].result.tools[0].name, 'fixture_echo');
  assert.deepEqual(JSON.parse(replies[2].result.content[0].text), { echoed: { text: 'café 🧭' } });
});
