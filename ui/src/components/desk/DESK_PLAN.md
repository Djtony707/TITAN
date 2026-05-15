# TITAN Desk Aesthetic Convergence Plan (Option C)
## Version: alpha.46 target
## Status: IN PROGRESS

---

### Objective
Replace the dark-void aesthetic in ALL of TITAN with the warm wood-desk look from Mission Canvas.
Make everything feel like physical objects on a desk: paper sheets, leather cards, brass badges.

### Theme Variants
1. **oak** — warm caramel, current Mission Canvas default
2. **walnut** — dark chocolate brown, subdued
3. **mahogany** — reddish-brown, elegant
4. **white** — modern marble, clean

### Execution Steps

---

## Step 1 — Extract Shared DeskSurface Component ✅
**File:** `ui/src/components/desk/DeskSurface.tsx`
**Status:** COMPLETE
- Extracted CSS gradient wood surface, glow, vignette, dust motes
- 4 theme variants with deterministic random motes
- CSS keyframes for animations
- No external dependencies

## Step 2 — Apply DeskSurface to TitanCanvas
**File:** `ui/src/titan2/canvas/TitanCanvas.tsx`
**Status:** PENDING
- Import DeskSurface
- Wrap the return JSX in `<DeskSurface theme={currentTheme}>`
- Remove dark background classes from existing wrappers

## Step 3 — Widget Theming (Global CSS Variables)
**Files:**
- `ui/src/index.css` or `ui/src/main.tsx` CSS injection
**Status:** PENDING
- Define CSS custom properties per theme: `--desk-text`, `--desk-accent`, `--desk-border`, `--desk-paper`, etc.
- All widgets read these variables instead of hardcoded dark-theme colours.

## Step 4 — Per-Widget Visual Polish
**Files:** All `ui/src/titan2/system/*Widget*.tsx`, all `ui/src/pages/*.tsx`
**Status:** PENDING
- Widget chrome: swap `#18181b` card backgrounds for `var(--desk-paper)` or translucent warm overlays
- Add subtle drop shadow + slight border-radius to every widget
- Nav / header: warm leather strip instead of dark bar
- Buttons: brass / gold accent, hover states
- Inputs: paper-white with warm border

## Step 5 — Settings Theme Picker
**Files:**
- `ui/src/titan2/system/widgets/SettingsGeneralWidget.tsx`
- `ui/src/titan2/system/SettingsWidget.tsx`
**Status:** PENDING
- Add 4 radio buttons (oak/walnut/mahogany/white)
- Persist choice to `localStorage` key `titan-desk-theme`
- Broadcast change via `window.dispatchEvent(new CustomEvent('desk-theme', {detail}))`
- All `DeskSurface` instances listen and react

## Step 6 — Route Non-Canvas Pages as Desk Widgets
**Files:** `ui/src/App.tsx`
**Status:** PENDING
- Keep `/mission/:id/canvas` as-is (it already IS the desk)
- `TitanCanvas` (`/space/:spaceId`) becomes the universal desk
- Other routes (Settings, Mission Chat, Library) optionally embed a `<DeskSurface>` wrapper
- Future: merge Mission Chat into the desk as a "letter" item

## Step 7 — Build, Test, Ship
**Status:** PENDING
1. Build backend (`npm run build`)
2. Build frontend (`cd ui && npm run build`)
3. Bump version → alpha.46
4. rsync to Titan PC
5. Restart titan.service
6. Verify in browser

## Step 8 — Documentation
**Files:** Update `CHANGELOG`, `HANDOFF`, `README` after shipping

---

### Notes / Decisions
- `MissionCanvas` already has the desk CSS inline — after convergence, it could import DeskSurface too for consistency.
- react-grid-layout widgets need their dark card styles swapped for warm ones. The grid itself stays; only the widget containers change.
- Some widgets may look odd until their internal palettes are warmed. That's cosmetic polish we can iterate on.
