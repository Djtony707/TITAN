import { registerShellSkill } from '/Users/michaelelliott/Desktop/TitanBot/TITAN-main/dist/skills/builtin/shell.js';
import { registerFilesystemSkill } from '/Users/michaelelliott/Desktop/TitanBot/TITAN-main/dist/skills/builtin/filesystem.js';
import { registerApplyPatchSkill } from '/Users/michaelelliott/Desktop/TitanBot/TITAN-main/dist/skills/builtin/apply_patch.js';
import { getRegisteredTools } from '/Users/michaelelliott/Desktop/TitanBot/TITAN-main/dist/agent/toolRunner.js';

registerShellSkill();
registerFilesystemSkill();
registerApplyPatchSkill();

const results = [];
function log(tool, test, result, error='') {
  results.push({tool, test, result, error: String(error).slice(0,200)});
}

const tools = getRegisteredTools();
const shell   = tools.find(t => t.name === 'shell');
const readFile= tools.find(t => t.name === 'read_file');
const writeFile= tools.find(t => t.name === 'write_file');
const listDir = tools.find(t => t.name === 'list_dir');
const editFile= tools.find(t => t.name === 'edit_file');
const applyPatch= tools.find(t => t.name === 'apply_patch');

function withTimeout(promise, ms, label) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} >${ms}ms`)), ms))]);
}

async function runTests() {
  console.log('TITAN Tool Tests\n');

  // 1. shell echo hello
  try {
    const out = await withTimeout(shell.execute({ command: 'echo hello' }), 5000, 'echo hello');
    log('shell','echo hello', out.trim()==='hello' ? 'PASS' : 'FAIL', out.slice(0,200));
  } catch(e) { log('shell','echo hello','FAIL', e.message); }

  // 2. shell rm -rf / blocked
  try {
    const out = await withTimeout(shell.execute({ command: 'rm -rf /' }), 5000, 'rm -rf /');
    const blocked = out.toLowerCase().includes('blocked') || out.toLowerCase().includes('not allowed') || out.includes('security') || out.includes('destructive');
    log('shell','rm -rf / blocked', blocked ? 'PASS' : 'FAIL', out.slice(0,300));
  } catch(e) { log('shell','rm -rf / blocked','FAIL', e.message); }

  // 3. shell sleep 65 timeout
  try {
    const out = await withTimeout(shell.execute({ command: 'sleep 65', timeout: 2000 }), 4000, 'sleep65');
    log('shell','sleep 65 timeout', out.toLowerCase().includes('timed out') || out.toLowerCase().includes('timeout') ? 'PASS' : 'FAIL', out.slice(0,200));
  } catch(e) {
    log('shell','sleep 65 timeout', e.message.toLowerCase().includes('timed out') ? 'PASS' : 'FAIL', e.message);
  }

  // 4. background sleep 5
  try {
    const t0 = Date.now();
    const out = await withTimeout(shell.execute({ command: 'sleep 5', background: true }), 12000, 'bg sleep5');
    const dur = Date.now() - t0;
    const ok = dur < 10000 && typeof out === 'string' && (out.includes('started') || out.includes('Background') || out.includes('Process') || out.includes('nohup'));
    log('shell','background sleep 5', ok ? 'PASS' : 'FAIL', `dur=${dur}ms out=${out.slice(0,200)}`);
  } catch(e) { log('shell','background sleep 5','FAIL', e.message); }

  // 5. read_file /opt/TITAN
  try {
    const out = await withTimeout(readFile.execute({ path: '/opt/TITAN/package.json' }), 5000, 'read opt');
    log('read_file','read /opt/TITAN', out.includes('denied') || out.includes('must be within') ? 'PASS' : 'FAIL', out.slice(0,200));
  } catch(e) { log('read_file','read /opt/TITAN','FAIL', e.message); }

  // 6. write_file temp + verify
  try {
    const path='/tmp/titan_tester_6.txt';
    await withTimeout(writeFile.execute({ path, content:'titan_test_6_content' }), 5000, 'write tmp');
    const r = await withTimeout(readFile.execute({ path }), 5000, 'read tmp');
    log('write_file','write temp + verify', r.includes('titan_test_6_content') ? 'PASS' : 'FAIL', r.slice(0,100));
  } catch(e) { log('write_file','write temp + verify','FAIL', e.message); }

  // 7. list_dir /opt/TITAN
  try {
    const out = await withTimeout(listDir.execute({ path: '/opt/TITAN' }), 5000, 'list opt');
    log('list_dir','list /opt/TITAN', out.includes('denied') || out.includes('must be within') ? 'PASS' : 'FAIL', out.slice(0,200));
  } catch(e) { log('list_dir','list /opt/TITAN','FAIL', e.message); }

  // 8. edit_file temp
  try {
    const path='/tmp/titan_tester_8.txt';
    await withTimeout(writeFile.execute({ path, content:'original_line_one\noriginal_line_two\n' }), 5000, 'write8');
    const out = await withTimeout(editFile.execute({ path, target:'original_line_one', replacement:'edited_line_one' }), 5000, 'edit8');
    const r = await withTimeout(readFile.execute({ path }), 5000, 'read8');
    log('edit_file','edit temp file', out.includes('Successfully') && r.includes('edited_line_one') ? 'PASS' : 'FAIL', out.slice(0,80));
  } catch(e) { log('edit_file','edit temp file','FAIL', e.message); }

  // 9. apply_patch temp file
  try {
    const path='/tmp/titan_tester_9.txt';
    await withTimeout(writeFile.execute({ path, content:'line one\nline two\nline three\n' }), 5000, 'write9');
    const patch=`diff --git a/tmp/titan_tester_9.txt b/tmp/titan_tester_9.txt\n--- a/tmp/titan_tester_9.txt\n+++ b/tmp/titan_tester_9.txt\n@@ -1,3 +1,3 @@\n line one\n-line two\n+patched line two\n line three\n`;
    const out = await withTimeout(applyPatch.execute({ patch, cwd:'/' }), 5000, 'patch9');
    const r = await withTimeout(readFile.execute({ path }), 5000, 'read9');
    log('apply_patch','patch temp file', (out.includes('Patched') || out.includes('Created')) && r.includes('patched line two') ? 'PASS' : 'FAIL', out.slice(0,100));
  } catch(e) { log('apply_patch','patch temp file','FAIL', e.message); }

  console.log('\n| tool       | test                                    | result | error |');
  console.log('|------------|-----------------------------------------|--------|-------|');
  for (const r of results) {
    console.log(`| ${String(r.tool).padEnd(10)} | ${r.test.padEnd(39)} | ${r.result.padEnd(6)} | ${r.error.slice(0,50).padEnd(5)} |`);
  }
  const passed = results.filter(r => r.result==='PASS').length;
  const failed = results.filter(r => r.result==='FAIL').length;
  console.log(`\nTotal: ${passed} PASS, ${failed} FAIL`);
  process.exit(0);
}

runTests();
