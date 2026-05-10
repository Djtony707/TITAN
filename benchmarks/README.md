# TITAN Benchmark Harness

> Automated health checks for TITAN.
> Run these to verify TITAN is healthy before and after changes.

---

## Benchmarks

### 1. Install Health
```bash
cd ~/Desktop/TitanBot/TITAN-main
node -v  # Should be >= 22
npm -v
ls node_modules | head -5
```

### 2. CLI Startup
```bash
cd ~/Desktop/TitanBot/TITAN-main
npx tsx src/cli/index.ts --help
```

### 3. Build
```bash
cd ~/Desktop/TitanBot/TITAN-main
npm run build
ls dist/cli/index.js
```

### 4. Type Check
```bash
cd ~/Desktop/TitanBot/TITAN-main
npm run typecheck
```

### 5. Unit Tests (Fast)
```bash
cd ~/Desktop/TitanBot/TITAN-main
npx vitest run --reporter=basic tests/unit/
```

### 6. Full Test Suite
```bash
cd ~/Desktop/TitanBot/TITAN-main
npx vitest run --reporter=basic
```

### 7. Lint
```bash
cd ~/Desktop/TitanBot/TITAN-main
npm run lint
```

### 8. Gateway Startup (Local)
```bash
cd ~/Desktop/TitanBot/TITAN-main
npm run dev:gateway
# Check http://localhost:48420
```

### 9. Titan PC Gateway Health (Remote)
```bash
ssh <titan-host> 'curl -sS http://127.0.0.1:48420/api/health | head -20'
```

### 10. Repo Sync Status
```bash
cd ~/Desktop/TitanBot/TITAN-main
git log --oneline --graph --left-right --decorate origin/main...HEAD
ssh <titan-host> 'cd /opt/TITAN && git log --oneline -1'
```

### 11. GitNexus Index Status
```bash
cat ~/.gitnexus/registry.json
ssh <titan-host> 'cat ~/.gitnexus/registry.json'
```

---

## Running All Benchmarks

```bash
./benchmarks/health-check.sh
```

Results are saved to `benchmarks/results/YYYY-MM-DD_HH-MM-SS.json`.

---

*Created: 2026-05-03 by KIMI-COO 🧠*
