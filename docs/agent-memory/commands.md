# Verified Commands

> Commands that have been tested and verified to work.
> Include the exact command, expected output, and any caveats.

---

## Test Commands

### Full Test Suite
```bash
cd ~/Desktop/TitanBot/TITAN-main
npx vitest run --reporter=basic --no-color
```
- **Expected:** 249 files passed, ~6593 tests, ~181s duration
- **Verified:** 2026-05-03 ✅
- **Caveat:** Takes ~3 minutes. Previous "hang" was just timeout being too short.

### Unit Tests Only (Fast)
```bash
cd ~/Desktop/TitanBot/TITAN-main
npx vitest run --reporter=basic tests/unit/
```
- **Expected:** 34 files, ~698 tests, ~8s duration
- **Verified:** 2026-05-03 ✅

## Git Commands

### Check Status
```bash
cd ~/Desktop/TitanBot/TITAN-main
git status
git log --oneline -5
```
- **Verified:** 2026-05-03 ✅

### Compare with Origin
```bash
cd ~/Desktop/TitanBot/TITAN-main
git log --oneline --graph --left-right --decorate origin/main...HEAD
```
- **Verified:** 2026-05-03 ✅

## Discovery Commands

### Find TITAN-Related Folders
```bash
find ~ -maxdepth 4 \( -iname "*titan*" -o -iname "*gitnexus*" \) ! -path "*/node_modules/*" ! -path "*/.git/*" 2>/dev/null
```
- **Verified:** 2026-05-03 ✅

### Check GitNexus Registry
```bash
cat ~/.gitnexus/registry.json
```
- **Verified:** 2026-05-03 ✅

### Build
```bash
cd ~/Desktop/TitanBot/TITAN-main
npm run build
```
- **Expected:** tsup builds `dist/` in ~400ms
- **Verified:** 2026-05-03 ✅ (371ms, `dist/cli/index.js` present)

### Type Check
```bash
cd ~/Desktop/TitanBot/TITAN-main
npm run typecheck
```
- **Expected:** `tsc --noEmit` passes with no errors
- **Verified:** 2026-05-03 ✅

## Titan PC (Read-Only)

### Check Remote Status
```bash
ssh titan 'cd /opt/TITAN && git status && git log --oneline -5'
```
- **Verified:** 2026-05-03 ✅

### Check Service Status
```bash
ssh titan 'systemctl status titan --no-pager'
```
- **Verified:** 2026-05-03 ✅

## Build Commands (Verified)

| Command | Status | Evidence |
|---|---|---|
| `npm run build` | ✅ Pass (371ms) | `dist/cli/index.js` generated |
| `npm run typecheck` | ✅ Pass | `tsc --noEmit` completed |
| `npm run lint` | ⏳ Not yet run | `eslint src/ --ext .ts` |
| `npm run dev` | ⏳ Not yet verified | `tsx src/cli/index.ts` |
| `titan gateway` | ⏳ Not yet verified | Production runs on Titan PC |

---

*Last updated: 2026-05-03 by KIMI-COO 🧠*
