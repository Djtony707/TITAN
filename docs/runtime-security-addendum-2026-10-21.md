# Runtime security addendum — 2026-10-21

This is a source assessment made after the dependency remediation. It does not establish an application exploit or the version of any running TITAN deployment. No production SSH, restart, provider request, publication or runtime replacement was performed for this assessment.

## Node security releases

The [official October 21 Node advisory](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases) identifies patched releases **22.23.4, 24.22.1 and 26.12.1**. It includes high-severity DNS, TLS and Brotli issues. A clean npm dependency audit does not inspect the Node executable or replace its built-in libraries.

## Electron 44.9.3 and 45.0.0: mixed backport state

[Electron 44.9.3 DEPS](https://github.com/electron/electron/blob/v44.9.3/DEPS#L6-L7) and [45.0.0 DEPS](https://github.com/electron/electron/blob/v45.0.0/DEPS#L6-L7) both select upstream Node 24.22.0. The [latest stable release](https://github.com/electron/electron/releases/tag/v45.0.0) is 45.0.0. These version labels alone do **not** prove which security fixes are absent: Electron also applies downstream patches and substitutes Chromium libraries.

Source inspection found the following specific gap:

| Fix | Upstream fixed source | Electron evidence |
| --- | --- | --- |
| DNS NUL input validation, CVE-2026-105482 | [Node commit 843a1627dc](https://github.com/nodejs/node/commit/843a1627dce1d1cbb7cf91489a89dbf837044b3f): callback/promise resolver and resolver utility validation | The [24.22.0 callback resolver](https://github.com/nodejs/node/blob/v24.22.0/lib/internal/dns/callback_resolver.js#L62) still uses the pre-fix string validation. No applied Electron Node patch touches any of the three affected resolver files. |
| TLS normalization and non-canonical IP validation | [de49c913f2](https://github.com/nodejs/node/commit/de49c913f232fd9c216bf164818c87c0cb645b7b) and [935918e342](https://github.com/nodejs/node/commit/935918e3427911f2bef315638d68308dfecc61ba), replacing validation in `lib/tls.js` | The [24.22.0 TLS implementation](https://github.com/nodejs/node/blob/v24.22.0/lib/tls.js#L430) retains the affected preimage. No applied Electron Node patch modifies `lib/tls.js`. |

All **64** applied Node patches from the [44.9.3 patch index](https://github.com/electron/electron/blob/v44.9.3/patches/node/.patches) and all **58** from the [45.0.0 index](https://github.com/electron/electron/blob/v45.0.0/patches/node/.patches) were inspected by their diff target paths. Neither release's applied patches touch `lib/tls.js`, `lib/internal/dns/callback_resolver.js`, `lib/internal/dns/promises.js` or `lib/internal/dns/utils.js`. This establishes missing upstream JS fixes in the reviewed tagged source; upgrading to 45.0.0 alone does not close them. It does not assert that every application route can supply the triggering input.

Two separate backport observations prevent an overbroad vulnerability claim:

- **Brotli CVE-2026-111497:** Electron's [Node GN patch](https://github.com/electron/electron/blob/v44.9.3/patches/node/build_add_gn_build_files.patch) links Chromium's Brotli decoder. Chromium 152.0.7977.167's [decoder](https://github.com/chromium/chromium/blob/152.0.7977.167/third_party/brotli/dec/decode.c#L1179) and [error header](https://github.com/chromium/chromium/blob/152.0.7977.167/third_party/brotli/include/brotli/decode.h#L88) already contain the exact invalid-block-switch handling added by [Node's fix 49dff6f57a](https://github.com/nodejs/node/commit/49dff6f57aa72cbbe13e480cd41ff4e46837c8fc). Do not classify Electron 44.9.3 as missing this decoder fix solely because its Node label is 24.22.0.
- **Compromised CA/SPKI chains:** the applied [Node TLS blocked-public-key patch](https://github.com/electron/electron/blob/v44.9.3/patches/node/tls_reject_chains_containing_blocked_public_keys.patch) is present in both reviewed patch indexes. It is a separate certificate-chain mitigation; it does not repair the missing JS hostname-validation changes.

The [44.9.3 security backport PR](https://github.com/electron/electron/pull/55149) names ANGLE, Chromium, PDFium, Skia and V8 changes. Its existence is not evidence that all of today's Node fixes were backported.

## TITAN runtime inventory and reachability

At candidate `f6774f6d`, `package.json` allowed Node `>=22.0.0`, and Doctor recommended any major >=20. Main Docker stages used floating `node:22-slim`/`node:22-alpine`; the GPU runtime used unpinned NodeSource 22.x; the standalone voice UI used `node:22-slim`; CI, publish and eval selected floating Node 22. These policies accepted affected versions and did not prove that cached images or installed hosts had today's patches.

The [official Docker image manifest](https://github.com/docker-library/official-images/blob/master/library/node) now lists `22.23.4-slim`, `22.23.4-alpine`, `24.22.1` and `26.12.1` tags. NodeSource's [official 22.x amd64 package index](https://deb.nodesource.com/node_22.x/dists/nodistro/main/binary-amd64/Packages.gz) lists `22.23.4-1nodesource1`. This establishes available build inputs, not that an existing deployment pulled or installed them.

TITAN uses native fetch extensively and has a configured SMTP STARTTLS path in `src/skills/builtin/email.ts` that passes the configured hostname to Node TLS. No direct DNS resolve API call was found in the reviewed application TypeScript. URL normalization, configured-host provenance, plugins and third-party libraries affect whether a particular trigger can reach the vulnerable primitives. No exploit or hostile payload was run. The confirmed deployment requirement is a patched Node runtime; production version and rollout still need separate authorized verification.

The local candidate now requires stable Node `^22.23.4 || ^24.22.1 || ^26.12.1` in all four package manifests. CLI import preflight, Doctor and direct gateway startup reject old, EOL, preview and unreviewed release lines before application work or provider dispatch. Every committed Node Docker stage and all five CI selectors use exact version tag `22.23.4`; the GPU runtime's NodeSource package is pinned to `22.23.4-1nodesource1`. These are version pins, not immutable image digests. The available NodeSource amd64 package metadata reports SHA-256 `e40ba508b45b2782ed453047d8e73fb9c4dd5358b70644eb9cc0e059ea2c959d`.

The runtime policy repairs were committed locally in `9de6a7ec`; later source security repairs and their final verification are recorded in the remediation report. Validation uses a separate official Node 24.22.1 executable, without changing the global runtime. Regression fixtures first demonstrated Doctor accepting affected/EOL versions, then proved refusal before configuration, network and service work. Docker tag/package availability was checked from the official indexes; Docker image builds and native GPU execution were not run. Separate operational inventory reported live Node 22.23.2; the prepared patched executable has not been activated. This source assessment did not perform production SSH or a service restart, and the committed policy is not proof of an updated running deployment.
