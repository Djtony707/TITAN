/**
 * TITAN Tool Direct Tester
 * Imports built-in tool modules directly and exercises them.
 */
import { registerShellSkill } from '/Users/michaelelliott/Desktop/TitanBot/TITAN-main/dist/skills/builtin/shell.js';
import { registerFilesystemSkill } from '/Users/michaelelliott/Desktop/TitanBot/TITAN-main/dist/skills/builtin/filesystem.js';
import { registerApplyPatchSkill } from '/Users/michaelelliott/Desktop/TitanBot/TITAN-main/dist/skills/builtin/apply_patch.js';
import { getRegisteredTools } from '/Users/michaelelliott/Desktop/TitanBot/TITAN-main/dist/agent/toolRunner.js';

registerShellSkill();
registerFilesystemSkill();
registerApplyPatchSkill();

const results = [];
function log(tool, test, result, error = '') {
  results.push({ tool, test, result, error: String(error).slice(0,200) });
}

const tools = getRegisteredTools();
const shell = tools.find(t => t.name === 'shell');
const readFile = tools.find(t => t.name === 'read_file');
const writeFile = tools.find(t => t.name === 'write_file');
const listDir = tools.find(t => t.name === 'list_dir');
const editFile = tools.find(t => t.name === 'edit_file');
const applyPatch = tools.find(t => t.name === 'apply_patch');

async function runTests() {
  console.log('Starting tool tests...\n');

  // Test 1: shell echo hello
  {
    const t0 = Date.now();
    try {
      const out = await shell.execute({ command: 'echo hello' });
      log('shell', 'echo hello', out.includes('hello') ? 'PASS' : 'FAIL', out.slice(0,200));
    } catch (e) { log('shell', 'echo hello', 'FAIL', e.message); }
  }

  // Test 2: shell rm -rf / blocked
  {
    try {
      const out = await shell.execute({ command: 'rm -rf /' });
      log('shell', 'rm -rf / blocked', out.includes('blocked') || out.includes('not allowed') || out.toLowerCase().includes('denied') || out.includes('destructive') || out.includes('not allow') || out.includes('Command blocked') || out.includes('not be run') ? 'PASS' : 'FAIL', out.slice(0,300));
    } catch (e) { log('shell', 'rm -rf / blocked', 'FAIL', e.message); }
  }

  // Test 3: shell sleep 65 timeout
  {
    const t0 = Date.now();
    try {
      const out = await shell.execute({ command: 'sleep 65', timeout: 2000 });
      log('shell', 'sleep 65 timeout', out.toLowerCase().includes('timed out') ? 'PASS' : 'FAIL', out.slice(0,200));
    } catch (e) {
      log('shell', 'sleep 65 timeout', e.message.includes('timed out') || e.message.includes('timeout') ? 'PASS' : 'FAIL', e.message);
    }
  }

  // Test 4: shell background sleep 5 returns immediately
  {
    const t0 = Date.now();
    try {
      const out = await shell.execute({ command: 'sleep 5', background: true });
      const dur = Date.now() - t0;
      // Should return immediately (< 3s for a background process)
      const ok = dur < 3000 && (out.includes('started') || out.includes('Background') || out.includes('Process'));
      log('shell', 'background sleep 5', ok ? 'PASS' : 'FAIL', `dur=${dur}ms out=${out.slice(0,200)}`);
    } catch (e) { log('shell', 'background sleep 5', 'FAIL', e.message); }
  }

  // Test 5: read_file in /opt/TITAN
  {
    try {
      const out = await readFile.execute({ path: '/opt/TITAN' });
      log('read_file', 'read /opt/TITAN', out.includes('Error') || out.includes('not found') || out.includes('denied') ? 'PASS' : 'FAIL', out.slice(0,200));
    } catch (e) { log('read_file', 'read /opt/TITAN', 'FAIL', e.message); }
  }

  // Test 6: write_file temp file, verify
  {
    try {
      const path = '/tmp/titan_test_6.txt';
      const content = 'Hello TITAN test 6';
      const out = await writeFile.execute({ path, content });
      // verify it exists
      const after = await readFile.execute({ path });
      log('write_file', 'write temp file + verify', after.includes('Hello TITAN test 6') ? 'PASS' : 'FAIL', `write=${out.slice(0,100)} read=${after.slice(0,100)}`);
    } catch (e) { log('write_file', 'write temp file + verify', 'FAIL', e.message); }
  }

  // Test 7: list_dir /opt/TITAN
  {
    try {
      const out = await listDir.execute({ path: '/opt/TITAN' });
      // Allowed (home dir is /Users/michaelelliott, /tmp is allowed; /opt/TITAN is separate, likely denied)
      // If /opt/TITAN is blocked, we expect an access-denied style message
      if (out.includes('Access denied') || out.includes('denied') || out.includes('must be within home directory') || out.includes('not found')) {
        log('list_dir', 'list /opt/TITAN', 'PASS', out.slice(0,200));
      } else {
        log('list_dir', 'list /opt/TITAN', 'FAIL', out.slice(0,200));
      }
    } catch (e) { log('list_dir', 'list /opt/TITAN', 'FAIL', e.message); }
  }

  // Test 8: edit_file on temp file
  {
    try {
      const path = '/tmp/titan_test_8.txt';
      await writeFile.execute({ path, content: 'original line one\noriginal line two\n' });
      const out = await editFile.execute({ path, target: 'original line one', replacement: 'edited line one' });
      const after = await readFile.execute({ path });
      log('edit_file', 'edit temp file', out.includes('Successfully') && after.includes('edited line one') ? 'PASS' : 'FAIL',
        `edit=${out.slice(0,200)} read=${after.slice(0,200)}`);
    } catch (e) { log('edit_file', 'edit temp file', 'FAIL', e.message); }
  }

  // Test 9: apply_patch to temp file
  {
    try {
      const path = '/tmp/titan_test_9.txt';
      await writeFile.execute({ path, content: 'line one\nline two\nline three\n' });
      const patch = `--- /tmp/titan_test_9.txt\n+++ /tmp/titan_test_9.txt\n@@ -1,3 +1,3 @@\n line one\n-line two\n+patched line two\n line three\n`;
      const out = await applyPatch.execute({ path, patch });
      const after = await readFile.execute({ path });
      log('apply_patch', 'patch temp file', out.includes('Successfully') && after.includes('patched line two') ? 'PASS' : 'FAIL',
        `patch=${out.slice(0,200)} read=${after.slice(0,200)}`);
    } catch (e) { log('apply_patch', 'patch temp file', 'FAIL', e.message); }
  }

  console.log('\n| tool       | test                                    | result | error |');
  console.log('|------------|-----------------------------------------|--------|-------|');
  for (const r of results) {
    console.log(`| ${String(r.tool).padEnd(10)} | ${r.test.padEnd(39)} | ${r.result.padEnd(6)} | ${r.error.slice(0,50).padEnd(5)} |`);
  }

  const passed = results.filter(r => r.result === 'PASS').length;
  const failed = results.filter(r => r.result === 'FAIL').length;
  console.log(`\nTotal: ${passed} PASS, ${failed} FAIL`);

  // Cleanup
  try { shell.execute({ command: 'rm -f /tmp/titan_test_*.txt' }); } catch {}
}

runTests();
