# TITAN Security Architecture

Security in TITAN is enforced through sandboxing, approval gates, and strict workspace boundary checks.

## Core Controls

1. WASM sandboxing for skills (`titan-skills`)
- Skills are executed via Wasmtime with constrained runtime behavior.

2. Capability-based tool policy (`titan-tools`)
- Tools are grouped by capability class: `READ`, `WRITE`, `EXEC`, `NET`.
- Policy enforcement depends on configured autonomy mode.

3. Approval workflow (`titan-memory`, `titan-cli`, `titan-web`)
- Sensitive operations are routed through approval records.
- Approval decisions and outcomes are persisted for auditability.

4. Workspace boundary enforcement (`titan-common::path_guard`)
- Canonical path checks prevent escaping workspace root.
- Read/write path validation is centralized.

5. Immutable trace persistence (`titan-memory`)
- Goal traces and tool execution records are written to SQLite.

## Threats Addressed

- Malicious or buggy skill execution
- Path traversal and workspace escape attempts
- Command execution abuse through non-allowlisted binaries
- Unapproved high-risk operations
- Missing operational audit trail

## Operational Checklist

- Run `./scripts/security-check.sh`
- Run `./scripts/release-check.sh`
- Verify workspace path is correct via `titan doctor`
- Confirm approval queue behavior in your selected autonomy mode
- Validate communication integrations with `titan comm status <channel>`

## Reporting Security Issues

Report vulnerabilities to `security@titan.dev`.
