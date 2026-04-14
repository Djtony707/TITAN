# Hunt Finding #18 — Template literal escapes breaking 40 runtime strings

**Date:** 2026-04-14
**Severity:** HIGH — shipped broken code (execSync + log strings + tool IDs)
**Discovered during:** Phase 3 live log inspection

## Symptom

Gateway log contained literal `${...}` placeholders that should have been interpolated:

```
2026-04-14 14:47:40 INFO [ParallelTools] ⚡ Executing ${calls.length} tools in parallel (max ${MAX_TOOL_CONCURRENCY})
2026-04-14 14:47:40 INFO [ParallelTools] ✅ Parallel execution: ${calls.length} tools in ${Date.now() - start}ms
```

Grepping the source for the same pattern revealed **40 real runtime bugs** across 4 files:

| File | Count | Impact |
|---|---|---|
| `src/agent/parallelTools.ts` | 4 | Log spam only |
| `src/agent/agentLoop.ts` | 4 | **2 are tool call ID collisions** (fab-${Date.now()} + intent-${Date.now()}) and 2 are log strings |
| `src/skills/builtin/security_scan.ts` | 14 | Tool output returns literal `${X}` — broken skill |
| `src/skills/builtin/changelog_gen.ts` | 22 | **execSync passes literal `${range}` to git** — skill completely broken |

### Most severe: `changelog_gen` was dead on arrival

```ts
// BEFORE (never worked since the file was written)
const range = since ? `\${since}..\${until}` : `-50`;
const log = execSync(
    `git log \${range} --pretty=format:"%h|%s|%an|%as" --no-merges`,
    { cwd: dir, timeout: 10000 }
).toString().trim();
```

The `\$` escape sequence in a backtick template literal produces a literal `${...}` in the output instead of interpolating the expression. So `execSync` was actually running:

```sh
git log ${range} --pretty=format:"%h|%s|%an|%as" --no-merges
```

— which shell parses with `${range}` as an empty variable expansion, so git saw `git log  --pretty=format:...` (no range argument). On most repos this returned the full history instead of the requested range. On empty repos or strict shell configs it failed outright.

Both `generate_changelog` and `summarize_pr` tools were broken. They had been registered and reachable since v2026.9.0 but could not produce correct output.

### Second most severe: duplicate tool call IDs in FabricationGuard / IntentParser

```ts
// BEFORE
response.toolCalls = [{
    id: `fab-\${Date.now()}`,  // ← literal string, same every invocation
    type: 'function' as const,
    function: { name: 'write_file', arguments: ... },
}];
```

Every FabricationGuard rescue used the **exact same tool call ID** `fab-${Date.now()}` (literal). Same for IntentParser: `intent-${Date.now()}`. When more than one fabrication fired in the same session, TITAN's tool-pair validation would see two assistant messages with the same `toolCallId` and drop one, causing silent rescue failure.

## Root cause

A code formatter or find/replace operation at some point in the past inserted backslashes before every `${` in every template literal (probably trying to escape them for a shell context), and the mistake was never caught because:

1. TypeScript doesn't flag it — `\$` in a template literal is valid source
2. No tests exercise `changelog_gen` or `security_scan` skills end-to-end
3. `parallelTools.ts` log strings are only visible when parallel execution actually fires
4. The FabricationGuard / IntentParser paths are rarely hit outside of weak-model test runs
5. ESLint has no rule for this

## Fix

Blanket search-and-replace of `\${` → `${` across all files except `src/skills/scaffold.ts` and `src/agent/generator.ts` (which legitimately emit literal `${...}` in generated source code for third-party skill templates).

```bash
python3 -c "
for f in ['src/agent/parallelTools.ts',
          'src/agent/agentLoop.ts',
          'src/skills/builtin/security_scan.ts',
          'src/skills/builtin/changelog_gen.ts']:
    with open(f) as r: s = r.read()
    with open(f, 'w') as w: w.write(s.replace('\\\${', '\${'))
"
```

## Regression test

`tests/hunt-regression.test.ts` has a new test that lints the entire `src/` tree for forbidden `\${` patterns outside the whitelisted code-gen files. Any future reintroduction fails the test.

```ts
it('source code: no backslash-dollar template literal escapes outside code-gen files', () => {
    const srcDir = join(process.cwd(), 'src');
    const files = globSync('**/*.ts', { cwd: srcDir });
    const whitelisted = new Set(['skills/scaffold.ts', 'agent/generator.ts']);
    const violations: string[] = [];
    for (const rel of files) {
        if (whitelisted.has(rel)) continue;
        const content = readFileSync(join(srcDir, rel), 'utf-8');
        if (content.includes('\\${')) {
            violations.push(rel);
        }
    }
    expect(violations).toEqual([]);
});
```

## Files modified

- `src/agent/parallelTools.ts` — 4 fixes (log strings)
- `src/agent/agentLoop.ts` — 4 fixes (2 log strings + 2 tool call IDs)
- `src/skills/builtin/security_scan.ts` — 14 fixes (log + output strings)
- `src/skills/builtin/changelog_gen.ts` — 22 fixes (git commands + output)
- `tests/hunt-regression.test.ts` — new lint test

## Class-level lesson

TypeScript has no warning for backslash-before-dollar inside template literals because it's legal syntax. ESLint has no default rule for it either. The only reliable guard is an explicit source-code lint test, which is what this finding adds.

Pattern to watch for in future code: any widespread mechanical transformation (code formatter, LLM-assisted refactor, sed script) that touches template literals should be validated with a grep for `\${` before merge.
