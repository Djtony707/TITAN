# TITAN security remediation — 2026-10-21

This local candidate starts from GitHub `main` at `63d0a7438192e9216faa39457124574ab53e6ecb`. It has not been pushed, merged, published, or deployed. Existing application settings, model files and running services were not changed.

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

[`GHSA-vfj7-8cjw-p6xm`](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) affects `braces` through 3.0.3. The advisory lists no patched release, and 3.0.3 remains the published latest version. In the standalone voice app it is reached through ESLint configuration → fast-glob → micromatch. Production-only `pnpm audit --prod` reports zero findings, and `pnpm why braces --prod` has no dependency path. ESLint coverage was retained.

The root npm package dry run contains 1,426 files and excludes `titan-voice-ui/`. Root Dockerfiles and Compose's main voice stack also do not build that standalone app. This bounds the current finding to that app's development/build tooling; it does not establish that arbitrary untrusted glob patterns are safe. Do not expose development tooling to untrusted inputs or call the complete repository audit clean. Recheck the advisory before a release and require a patched compatible dependency path before clearing this finding.

## Verification and remaining release gates

- Clean root and UI `npm ci --ignore-scripts`; voice `pnpm install --frozen-lockfile --ignore-scripts`; the example installs and type-checks from its new lock. Install lifecycle scripts were deliberately not used for this authoring check.
- Backend, Mission Control and standalone voice production builds pass. Root and voice type checking pass. Root lint has zero errors and 254 warnings, matching the existing documented warning set.
- A local Git compatibility fixture exercised `init`, `add`, `status` and `revparse`, and verified rejection of the disclosed `VISUAL`, trailer-command, config-include and abbreviated-exec cases. The node-llama-cpp API exports load; no model was loaded or inferred.
- All 11 Eval Gate suites pass at the existing per-suite threshold: 55/57 overall. `pipeline` is 4/5 and `tool-routing-v2` is 7/8, the known baseline scores. This used an isolated loopback stub gateway which was stopped afterward.
- The complete unit run reported all 415 test files: 414 passed and `tests/config.test.ts` failed one stale default-model assertion. That same failure was reproduced on untouched `main` with its original dependency lock. Product defaults were preserved. The runner subsequently hung during teardown with owned MCP test subprocesses; those were stopped. This is not a fully green release gate or a successful runner exit.
- GitHub secret-scanning returned no open alerts. Code-scanning returned no analysis, and the default-setup API explicitly reports `not-configured`; there is no CodeQL workflow in this candidate. Missing code-analysis coverage is not a clean scan.
- GitNexus impact/change-detection calls could not analyze this checkout because the available service has no TITAN index. Dependency changes were reviewed directly; no existing production TypeScript functions were modified in this dependency increment.

Existing Dependabot PRs, including the earlier consolidation draft #174 and standalone-voice removal draft #176, were inspected but not merged or edited. The standalone voice app was retained. GitHub alerts remain open until a reviewed change reaches the default branch and GitHub re-evaluates it.

## Reusable maintenance rules

Run each package manager in the project whose `packageManager` pin it must honor. Running `pnpm --version` from the root can select a different version from running it inside the voice app. Audit every committed dependency surface, including examples and optional packages; a clean root audit cannot establish that nested locks are clean. For this test suite, a global `TITAN_HOME` overrides tests' own home-directory isolation and produces misleading failures; isolate the inherited home while preserving per-test overrides.
