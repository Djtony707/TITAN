# TITAN security remediation — 2026-10-21

This local candidate starts from GitHub `main` at `63d0a7438192e9216faa39457124574ab53e6ecb`. It has not been pushed, merged, published, or deployed. Existing application settings, model files and running services were not changed. The separate [runtime security addendum](runtime-security-addendum-2026-10-21.md) records today's Node release requirements and the specific Electron backport gap.

## Dependency findings and repairs

GitHub reported 138 open Dependabot alerts: 6 critical, 49 high, 67 medium and 16 low. These are advisory/manifest records, not 138 independently reachable application exploits. Fresh package-manager audits provided the separate baseline below.

| Dependency graph | Before | Candidate |
| --- | --- | --- |
| Root npm lock | 30 findings: 3 critical, 15 high, 11 moderate, 1 low | 0 |
| Mission Control `ui/` npm lock | 6 high | 0 |
| Standalone `titan-voice-ui/` pnpm lock, all dependencies | 105 findings: 3 critical, 48 high, 46 moderate, 8 low | 1 high in development dependencies |
| Standalone voice app, production dependencies | Not separately measured before | 0 |
| MCP example | No lock; unused vulnerable SDK and an unavailable TITAN version requirement | 0; lock added for its actual development tools |

Lockfiles were regenerated with npm 11 and the voice app's pinned pnpm 9.15.9. Express remains on 4.x, React Router on 7.x, Next.js on 15.x, and node-llama-cpp on 3.x. The targeted `simple-git` 4.0.2 override removes unsafe-operation/parser advisories without downgrading or removing the local inference package. Existing TITAN provider and model APIs were not edited.

The MCP example imports Node built-ins and uses `fetch` to reach a separately running gateway. Its unused `@modelcontextprotocol/sdk` and nonexistent `titan-agent` dependency requirement were removed; this does not remove a runtime import or tool path. The failed Dependabot job for this example could not determine an installed SDK version because the old package had neither a lockfile nor an exact version.

`npm run audit:security` audits root, UI, MCP example and standalone voice app, including development dependencies and low-severity findings. Missing locks, advisory-service failures and missing/wrong package-manager versions fail the command. It currently fails on the explicitly retained advisory below; no audit exclusion or severity allowlist was added.

## Unresolved development advisory

[`GHSA-vfj7-8cjw-p6xm`](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) affects `braces` through 3.0.3. The advisory lists no patched release, and 3.0.3 remains the published latest version. The [upstream issue](https://github.com/micromatch/braces/issues/70) remains open. In the standalone voice app, the installed development paths include:

- `eslint-config-next@15.5.28` → `@next/eslint-plugin-next@15.5.28` → `fast-glob@3.3.1` → `micromatch@4.0.8` → `braces@3.0.3`.
- `eslint-config-next@15.5.28` → `@typescript-eslint/parser@8.32.1` → `@typescript-eslint/typescript-estree@8.32.1` → `fast-glob@3.3.3` → `micromatch@4.0.8` → `braces@3.0.3`; the TypeScript plugin and import plugin also reach this parser.

These are used by `pnpm lint` (`next lint`) and the normal Next.js build lint check, not by the root Vitest runner. `eslint.config.mjs` extends `next/core-web-vitals` and `next/typescript`; the actual lint command passes with warnings. Next's plugin can pass configured `settings.next.rootDir` patterns to fast-glob, and TypeScript-ESLint can pass configured project globs. Fast-glob's brace-expansion helper calls `micromatch.braces(..., { expand: true })`, which invokes the affected recursive library. Current checked-in lint configuration does not supply an untrusted root/project glob. Removing this dependency would remove active lint coverage, so it was retained. Production-only `pnpm audit --prod` reports zero findings, and `pnpm why braces --prod` has no dependency path.

The root npm package dry run contains 1,426 files and excludes `titan-voice-ui/`. Root Dockerfiles and Compose's main voice stack also do not build that standalone app. This bounds the current finding to that app's development/build tooling; it does not establish that arbitrary untrusted glob patterns are safe. Do not expose development tooling to untrusted inputs or call the complete repository audit clean. Recheck the advisory before a release and require a patched compatible dependency path before clearing this finding.

## Verification and remaining release gates

- Clean root and UI `npm ci --ignore-scripts`; voice `pnpm install --frozen-lockfile --ignore-scripts`; the example installs and type-checks from its new lock. Install lifecycle scripts were deliberately not used for this authoring check.
- Backend, Mission Control and standalone voice production builds pass. Root and voice type checking pass. Root lint has zero errors and 254 warnings, matching the existing documented warning set.
- A local Git compatibility fixture exercised `init`, `add`, `status` and `revparse`, and verified rejection of the disclosed `VISUAL`, trailer-command, config-include and abbreviated-exec cases. The node-llama-cpp API exports load; no model was loaded or inferred.
- All 11 Eval Gate suites pass at the existing per-suite threshold: 55/57 overall. `pipeline` is 4/5 and `tool-routing-v2` is 7/8, the known baseline scores. This used an isolated loopback stub gateway which was stopped afterward.
- The first correctly isolated complete unit run reported all 415 test files: 414 passed and `tests/config.test.ts` failed one environment-dependent default-model assertion. That same failure was reproduced on untouched `main` with its original dependency lock. The test now isolates its configuration home and first-class provider-key inputs, retains the original Ollama alias expectations, and adds a provider-aware alias assertion. Product defaults were preserved. Earlier runner teardown also left test-owned MCP subprocesses; those were stopped and the implicit real-CLI tests were repaired as described below. Earlier logs are retained and are not counted as a successful final runner exit.
- Final unit suite after runtime preflight and fixture repairs, using patched Node 24.22.1: **416 files passed; 8,741 tests passed and 9 skipped (8,750 total)**, exit code 0 in 81.79 seconds. All 326 targeted runtime/config/CLI/channel/safety cases also passed. No owned fixture/MCP processes remained. Backend, UI and voice builds passed after the runtime source changes; type check and lint were rerun after the last fixture repair. Lint remains zero errors / 254 warnings.
- GitHub secret-scanning returned no open alerts. Code-scanning returned no analysis, and the default-setup API explicitly reports `not-configured`. This candidate now includes a reviewed local CodeQL workflow as described below; its first hosted analysis remains pending. Missing code-analysis results are not a clean scan.
- GitNexus impact/change-detection calls could not analyze this checkout because the available service has no TITAN index. Source and dependency changes received direct review, including an independent review of runtime preflight boundaries and version pins.

Existing Dependabot PRs, including the earlier consolidation draft #174 and standalone-voice removal draft #176, were inspected but not merged or edited. The standalone voice app was retained. GitHub alerts remain open until a reviewed change reaches the default branch and GitHub re-evaluates it.

## Local HTTP example and credential repairs

The optional MCP HTTP example previously bound all interfaces and proxied tool calls without authentication. It now binds `127.0.0.1`, refuses browser `Origin` requests and limits request bodies to 1 MiB of bytes. The limit is enforced for both declared-length and chunked requests before gateway dispatch. UTF-8 is decoded after collecting bounded bytes, so split multibyte characters survive. Five real loopback fixture tests cover valid tool calls, both oversized-body encodings, split UTF-8, browser-origin refusal and unchanged stdio discovery/calls. Before the change, the exposure, limit and browser-origin cases failed; all five now pass, along with the example's TypeScript check. No remote gateway or paid provider was contacted by these fixtures.

Three literal media integration credentials in `docker-compose.yml` were replaced with `SONARR_API_KEY`, `RADARR_API_KEY` and `TMDB_API_KEY` environment substitutions. Empty entries in `.env.example` describe configuration without including values. `docker compose --env-file /dev/null config --format json` was validated with synthetic values; no containers were started. Existing credentials must be rotated at their issuing services before reuse; removing them from the current file does not remove historical exposure.

Gitleaks 8.30.1 scanned all Git history and 1,853 current tracked files with `--redact=100`, without suppressions. History had 30 detections, including historical Compose credentials and a TITAN gateway bearer token in `docs/HANDOFF-2026-05-03.md:97` (commit `13791ec0fe41`). The surrounding documentation identifies the Titan PC service on loopback port 48420, deployed under `/opt/TITAN`, and its `Authorization: Bearer` field for `/api/health` and `/api/social/state`. The token's validity was not tested; the owner must rotate it at that gateway if still used. Current-source detections decreased from 19 to 16 after the Compose repair. The remaining 16 are synthetic test values and a secret-detection regex in `src/agent/stagingScanners.ts:45`. A clean GitHub secret-alert list therefore must not be treated as proof that generic credentials were never exposed. Reports are redacted; no secret values are included in this handoff.

## Provider discovery and safe unit tests

The existing Claude provider's binary discovery used `--print hello`, including from `healthCheck()` and model discovery before the explicit chat opt-in gate. It now checks only filesystem installation metadata: the PATH candidate must resolve to a regular file and pass `fs.accessSync(..., X_OK)`. No executable is started, including for version metadata. This is executable-presence information, not authentication or successful inference. The existing autonomous `providerOptions.allowClaudeCode` denial guard is preserved; no route is enabled by this change. Red-before/green-after fixtures prohibit child-process starts during health checks, cover regular files, non-executable files, directories and working/broken symlinks, and prove blocked chat starts no executable. Model discovery's executable-invocation log is empty.

Existing adapter tests, their integration-test duplicates, the Claude health test and the model-discovery tests could launch installed authenticated CLIs. Four test files now use controlled executable fixtures, and model-discovery HTTP calls are mocked. The fixtures assert prompt/stdin arguments, callback metadata, output, error exit codes and timeout behavior; the affected tests plus config/picker tests pass 97 cases. Earlier full-suite attempts did start installed CLIs and their MCP subprocesses. Whether those attempts reached inference or incurred charges was not established and is not reported as zero. The owned test tree was stopped, and prior logs were preserved.

Real CLI checks are outside `npm test`. `npm run test:external-cli` refuses unless both `TITAN_ALLOW_REAL_CLI_TESTS=1` and `--allow-real-provider-calls --provider=codex` are explicitly supplied after authorization. The refusal path was verified, including rejection of `--provider=claude-code` even with both authorization flags. The manual gate supports only Codex; no real-provider integration command was run during this repair.

## Patched runtime requirement

All four package manifests now require stable Node `^22.23.4 || ^24.22.1 || ^26.12.1`, matching the [official October security release](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases). CLI import preflight runs before other application modules, while Doctor and direct gateway startup also reject unsupported runtimes before configuration, logging, network or provider dispatch. Older releases, EOL lines, previews and unreviewed majors are refused. This is a startup requirement, not an update to an installed host.

Docker Node stages and all five Node CI selectors now use exact version tag `22.23.4`; the GPU runtime's NodeSource package is pinned to `22.23.4-1nodesource1`. Official Docker tag and NodeSource package availability were verified. Docker image builds and native GPU execution were not run. Validation used a separate Node 24.22.1 executable; the global runtime and production services were retained. Production runtime inventory and an authorized rollout remain release gates.

The first suite run on that executable exposed a test-only launcher shebang that could not represent its path containing spaces, plus one old floating Docker-tag expectation. The fixture now executes a separately written payload through a shell-quoted absolute Node path, preserving argument/stdin/error/timeout assertions. The Docker test requires the exact patched Alpine tag. No product defaults or adapter assertions were loosened.

The next run passed all 416 files and 8,741 assertions but exited 1 on five pending import rejections during teardown in `kill-switch-retune.test.ts`. Those threshold tests now isolate daemon/goal/agent side effects and wait for pending imports; their kill-threshold assertions remain and a scoped-pause assertion was added. An existing Matrix unit test also attempted SDK network requests to matrix.org with a synthetic token. It now uses a controlled SDK and asserts its complete connection/disconnection contract. No production channel or safety code was changed by these fixture repairs.

The successful final suite used a scratch, process-scoped guard that refuses non-loopback Node TCP/TLS/DNS/UDP/fetch operations. Its self-test proved refusal before external dispatch and preserved real loopback HTTP. An existing WhatsApp/Baileys unit SDK attempted its websocket connection and received that refusal. The guard adds no dependency and changes no host firewall. It is not an OS sandbox for arbitrary native children, and the ordinary default suite without this guard is not claimed to be fully network-isolated. No runner errors were ignored.

## Code-analysis setup

The repository is public, which is eligible for [CodeQL code scanning](https://docs.github.com/en/code-security/concepts/code-scanning/codeql/codeql-code-scanning). `.github/workflows/codeql.yml` prepares JavaScript/TypeScript analysis with `build-mode: none` and the documented [`security-extended` query suite](https://docs.github.com/en/code-security/reference/code-scanning/workflow-configuration-options). It triggers on main-branch pushes, pull requests targeting main and manual dispatch, with no schedule or application build/install step. Permissions are limited to contents read, actions read and security-events write; checkout does not persist credentials.

The official [CodeQL action v4.39.1 release](https://github.com/github/codeql-action/releases/tag/v4.39.1) was verified against its annotated Git tag, which resolves to immutable commit `9b3254085494b55a0f7c4c2b3d2d52cc712ce370`. Both init and analyze use that commit; checkout's official v7 ref resolves to `3d3c42e5aac5ba805825da76410c181273ba90b1`. Local YAML parsing and trigger/permission/action-input checks pass. The workflow was independently reviewed. No hosted workflow or analysis upload was started, and the existing GitHub coverage gap remains until an authorized push and successful first analysis.

## Reusable maintenance rules

Run each package manager in the project whose `packageManager` pin it must honor. Running `pnpm --version` from the root can select a different version from running it inside the voice app. Audit every committed dependency surface, including examples and optional packages; a clean root audit cannot establish that nested locks are clean. For this test suite, a global `TITAN_HOME` overrides tests' own home-directory isolation and produces misleading failures; isolate the inherited home while preserving per-test overrides.
