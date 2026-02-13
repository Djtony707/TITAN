# TITAN Security Architecture

> Security-first design. Provably safer than alternatives.

## Threat Model & Mitigations

| Threat | TITAN Mitigation | OpenClaw Status |
|--------|------------------|-----------------|
| **Malicious Skills** | WASM sandbox with WASI, capability-based permissions | ❌ No sandboxing |
| **Prompt Injection** | Input sanitization + mandatory approval gates | ⚠️ Optional |
| **Workspace Escape** | Strict path canonicalization + bounds checking | ⚠️ Directory-only |
| **Secret Exfiltration** | Secrets isolated in env, never in logs/skills | ❌ In-code exposure |
| **Command Injection** | Allowlist-based command execution only | ❌ Vulnerable |
| **Resource Exhaustion** | Memory limits, timeouts, circuit breakers | ❌ None |
| **Audit Trail** | Immutable execution traces stored in SQLite | ⚠️ Optional |

## Security Features

### 1. WASM Sandboxing (titan-skills)
All skills run in a Wasmtime sandbox with WASI:
- No direct filesystem access
- No network access (unless explicitly granted)
- No secret access
- Capability-based permissions
- Resource limits enforced

### 2. Permission Classes

| Class | Tools | Collaborative Mode | Supervised Mode |
|-------|-------|-------------------|-----------------|
| **READ** | list_dir, read_file, search_text | Auto-approved | Requires approval |
| **WRITE** | write_file, git_commit | Requires approval | Requires approval |
| **EXEC** | run_command, execute | Requires approval | Requires approval |
| **NET** | http_get, api_call | Requires approval | Requires approval |

### 3. Approval Workflow
- All WRITE/EXEC/NET operations require explicit approval
- Discord integration for human-in-the-loop
- Timeout on pending approvals (default: 5 minutes)
- Audit trail of all approvals/denials

### 4. Workspace Isolation
- Path canonicalization prevents escape
- Strict boundary enforcement
- All paths validated against workspace root
- Relative path resolution blocked outside workspace

### 5. Emergency Controls
```bash
# Emergency killswitch
titan --killswitch

# Discord command
!emergency
```

Stops all autonomous operations immediately.

### 6. Input Validation
- All user inputs sanitized
- Command injection prevention via allowlist
- Path traversal detection
- Rate limiting on requests

### 7. Resource Limits
- Memory caps per operation
- Timeout enforcement (default: 30s)
- Maximum file size limits
- Concurrent operation limits

### 8. Audit Logging
- Immutable execution traces
- SQLite-backed with checksums
- Tamper-evident log structure
- Exportable for compliance

## Security Checklist

Before production deployment:

- [ ] Run `./scripts/security-check.sh`
- [ ] Configure workspace boundaries
- [ ] Set up Discord approval channel
- [ ] Review permission class settings
- [ ] Test emergency killswitch
- [ ] Verify WASM sandbox constraints
- [ ] Enable audit logging
- [ ] Set resource limits
- [ ] Review skill capabilities
- [ ] Test command injection resistance

## Comparison

**TITAN vs OpenClaw Security:**

| Feature | TITAN | OpenClaw |
|---------|-------|----------|
| Skill Sandboxing | ✅ WASM + WASI | ❌ None |
| Mandatory Approvals | ✅ Required for sensitive ops | ⚠️ Optional |
| Secret Isolation | ✅ Environment only | ❌ Code/log exposure |
| Audit Trail | ✅ Immutable + required | ⚠️ Optional |
| Workspace Boundaries | ✅ Strict path validation | ⚠️ Directory-only |
| Resource Limits | ✅ Built-in | ❌ None |

## Reporting Security Issues

Please report security vulnerabilities to [security@titan.dev](mailto:security@titan.dev).

---

**TITAN: Security by design, not by afterthought.**
