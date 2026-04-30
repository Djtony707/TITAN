import { validateCommand, executeCommand } from '../src/skills/builtin/shell.ts';
import { validatePath, expandPath } from '../src/skills/builtin/filesystem.ts';

const results: {tool:string;test:string;result:string;error:string}[] = [];
function log(tool: string, test: string, result: string, error='') {
  results.push({tool,test,result,error:error.slice(0,200)});
}

async function runTests() {
  console.log('TITAN Tool Direct Tests (validate only)\n');

  // shell validation
  const e1 = validateCommand('echo hello');
  log('shell', 'echo hello', e1 ? 'FAIL' : 'PASS', e1 || '');

  const e2 = validateCommand('rm -rf /');
  log('shell', 'rm -rf / blocked', e2 ? 'PASS' : 'FAIL', e2 || '');

  const e3 = validateCommand('sleep 65');
  log('shell', 'sleep 65 (not blocked)', e3 ? 'FAIL' : 'PASS', e3 || '');

  // filesystem path validation
  const p1 = validatePath('/tmp/test.txt');
  log('filesystem', '/tmp path allowed', p1 ? 'FAIL' : 'PASS', p1 || '');

  const p2 = validatePath('/opt/TITAN');
  log('filesystem', '/opt/TITAN blocked', p2 ? 'PASS' : 'FAIL', p2 || '');

  const p3 = validatePath('~/.ssh/id_rsa');
  log('filesystem', '.ssh blocked', p3 ? 'PASS' : 'FAIL', p3 || '');

  // direct command execution tests
  try {
    const out1 = await executeCommand('echo hello');
    log('shell', 'exec echo hello', out1.includes('hello') ? 'PASS' : 'FAIL', out1.slice(0,200));
  } catch(e) { log('shell','exec echo hello','FAIL', String(e)); }

  // timeout test: 2s timeout on sleep 5
  try {
    const out2 = await executeCommand('sleep 5', undefined, 2000);
    log('shell','exec sleep 5 with 2s timeout','FAIL', 'No timeout: '+out2.slice(0,100));
  } catch(e) {
    log('shell','exec sleep 5 with 2s timeout', String(e).includes('timed out') ? 'PASS' : 'FAIL', String(e));
  }

  // background test
  try {
    const t0 = Date.now();
    // executeCommand doesn't support background directly, but startBackgroundProcess is separate
    log('shell','background skipped','SKIP','No direct background function importable');
  } catch(e) { log('shell','background','FAIL',String(e)); }

  console.log('\n| tool       | test                                    | result | error |');
  console.log('|------------|-----------------------------------------|--------|-------|');
  for (const r of results) {
    console.log(`| ${r.tool.padEnd(10)} | ${r.test.padEnd(39)} | ${r.result.padEnd(6)} | ${r.error.padEnd(5)} |`);
  }
  const passed = results.filter(r => r.result === 'PASS').length;
  const failed = results.filter(r => r.result === 'FAIL').length;
  const skipped = results.filter(r => r.result === 'SKIP').length;
  console.log(`\nTotal: ${passed} PASS, ${failed} FAIL, ${skipped} SKIP`);
}

runTests();
