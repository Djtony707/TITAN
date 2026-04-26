/**
 * Titan 3.0 Space Engine
 * Manages spaces (widget layouts) with localStorage persistence.
 */

import type { Space, WidgetDef } from '../types';
import { getYSpace, addYWidget, removeYWidget, updateYWidget, observeSpace, defToYWidget, dedupeYSpaceWidgets, clearYSpace, destroyYSpace } from '../crdt/CrdtEngine';

const STORAGE_KEY = 'titan2-spaces';
const USE_CRDT = true;

function makeWidget(
  id: string, name: string, source: string, x: number, y: number, w: number, h: number
): WidgetDef {
  return {
    id,
    name,
    format: 'system',
    source,
    x, y, w, h,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

const BUILTIN_SPACES: Space[] = [
  {
    id: 'home',
    name: 'Home',
    icon: 'Home',
    color: '#6366f1',
    widgets: [
      // v8: `home-chat` removed. The floating FloatingChatDock is now the
      // sole chat surface — no grid chat widget to create the dup Tony
      // flagged. The welcome + voice stretch a little wider with the
      // freed column space.
      makeWidget('home-welcome', 'Welcome', 'system:soma', 0, 0, 6, 5),
      makeWidget('home-voice', 'Voice', 'system:voice', 6, 0, 6, 5),
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'soma',
    name: 'SOMA',
    icon: 'Brain',
    color: '#8b5cf6',
    widgets: [
      makeWidget('soma-main', 'SOMA', 'system:soma', 0, 0, 8, 8),
      makeWidget('soma-memory', 'Memory Graph', 'system:memory-graph', 8, 0, 4, 8),
    ],
    agentInstructions: 'This is the SOMA consciousness space. Help the user explore consciousness, memory, and self-improvement.',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'command',
    name: 'Command Post',
    icon: 'Terminal',
    color: '#ef4444',
    widgets: [
      makeWidget('cp-hub', 'Command Post', 'system:command-post', 0, 0, 12, 10),
    ],
    agentInstructions: 'This is the Command Post. Help the user manage agents, runs, and operations.',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'intelligence',
    name: 'Intelligence',
    icon: 'Network',
    color: '#10b981',
    widgets: [
      makeWidget('intel-autopilot', 'Autopilot', 'system:intelligence-autopilot', 0, 0, 6, 5),
      makeWidget('intel-workflows', 'Workflows', 'system:intelligence-workflows', 6, 0, 6, 5),
      makeWidget('intel-learning', 'Learning', 'system:intelligence-learning', 0, 5, 6, 5),
      makeWidget('intel-memory', 'Memory Graph', 'system:memory-graph', 6, 5, 6, 5),
      makeWidget('intel-selfimprove', 'Self-Improve', 'system:intelligence-self-improve', 0, 10, 6, 5),
      makeWidget('intel-personas', 'Personas', 'system:intelligence-personas', 6, 10, 6, 5),
    ],
    agentInstructions: 'This is the Intelligence space. Help the user explore memory graphs, wiki, and knowledge.',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'infra',
    name: 'Infrastructure',
    icon: 'Server',
    color: '#f59e0b',
    widgets: [
      makeWidget('infra-homelab', 'Homelab', 'system:infra-homelab', 0, 0, 6, 6),
      makeWidget('infra-gpu', 'GPU / NVIDIA', 'system:infra-gpu', 6, 0, 6, 6),
      makeWidget('infra-files', 'Files', 'system:infra-files', 0, 6, 4, 5),
      makeWidget('infra-logs', 'Logs', 'system:infra-logs', 4, 6, 4, 5),
      makeWidget('infra-telemetry', 'Telemetry', 'system:infra-telemetry', 8, 6, 4, 5),
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'tools',
    name: 'Tools',
    icon: 'Wrench',
    color: '#06b6d4',
    widgets: [
      makeWidget('tools-skills', 'Skills', 'system:tools-skills', 0, 0, 6, 6),
      makeWidget('tools-mcp', 'MCP Servers', 'system:tools-mcp', 6, 0, 6, 6),
      makeWidget('tools-integrations', 'Integrations', 'system:tools-integrations', 0, 6, 4, 5),
      makeWidget('tools-channels', 'Channels', 'system:tools-channels', 4, 6, 4, 5),
      makeWidget('tools-mesh', 'Mesh Network', 'system:tools-mesh', 8, 6, 4, 5),
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'settings',
    name: 'Settings',
    icon: 'Settings',
    color: '#6b7280',
    // Paired layout (two columns). Prior v6 seed made every settings
    // widget w=12 which meant nothing could sit beside them — Tony hit
    // this trying to drop a second widget next to Specialist Models.
    // v7 moves each widget to w=6 so the whole Settings space is a clean
    // two-column grid that the user can rearrange freely.
    widgets: [
      makeWidget('settings-specialists', 'Specialist Models', 'system:settings-specialists', 0, 0, 6, 8),
      makeWidget('settings-privacy', 'Privacy & Telemetry', 'system:settings-privacy', 6, 0, 6, 8),
      makeWidget('settings-general', 'General', 'system:settings-general', 0, 8, 6, 8),
      makeWidget('settings-security', 'Security', 'system:settings-security', 6, 8, 6, 8),
      makeWidget('settings-audit', 'Audit Log', 'system:settings-audit', 0, 16, 12, 6),
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

// v4: one-time reseed that actually waits for IndexedDB hydration and dedupes.
// Prior versions checked `widgets.length === 0` synchronously before IDB had
// finished reading, so the code seeded fresh widgets every boot AND the CRDT
// then merged in IDB's stored widgets → duplication compounding every restart.
//
// v5: add SettingsSpecialistsWidget to the settings Space so existing users
// see it without having to wipe their CRDT state. `healYSpaceOnSync` only
// backfills missing widget IDs, so user-added widgets + existing layouts
// are preserved; only the new "settings-specialists" widget is added.
//
// v6 (5.0 "Spacewalk"): add settings-privacy widget for the telemetry
// consent controls. Same backfill semantics — user-added widgets preserved.
//
// v7 (5.0 "Spacewalk" hotfix): the v6 Settings space seeded every widget
// at w=12 (full-width), making side-by-side placement impossible. v7
// reseeds Settings to a two-column grid. The healer on this bump
// REWRITES geometry for built-in widget IDs so existing users get the
// new pair layout; user-added widgets are left untouched because their
// IDs don't match any built-in entry.
//
// v8 (5.0 "Spacewalk" chat-unification): `home-chat` grid widget is
// removed — the floating FloatingChatDock is now the sole chat. The
// healer DELETES any widget whose id is in REMOVED_BUILTIN_IDS so the
// duplicate chat Tony flagged disappears for existing installs too.
//
// v9 (5.0 "Spacewalk" empty-widget cleanup): deletes any widget with
// empty source so blank iframes disappear for existing installs.
const SEED_VERSION = 9;
const REMOVED_BUILTIN_IDS: Record<string, Set<string>> = {
  home: new Set(['home-chat']),
};

/**
 * Hydration-aware healer. Runs for every space after `whenSynced` resolves:
 *   1. Dedupes any existing widget entries by ID (heals pre-existing duplication)
 *   2. If the space's seedVersion is stale, adds any MISSING built-in widget IDs
 *      — does NOT blanket-replace so user-added widgets are preserved
 *
 * Callable fire-and-forget. Changes propagate to the canvas via the existing
 * `observe()` subscription.
 */
function healYSpaceOnSync(space: Space, needsReseed: boolean): void {
  if (!USE_CRDT) return;
  const { widgets, meta, whenSynced } = getYSpace(space.id);
  whenSynced.then(() => {
    try {
      // Step 1: strip duplicates already in Yjs
      const removed = dedupeYSpaceWidgets(space.id);
      if (removed > 0) {
        // eslint-disable-next-line no-console
        console.info(`[SpaceEngine] healed ${removed} duplicate widget(s) in "${space.id}"`);
      }

      // Step 2: on version bump, reconcile built-in widgets with the
      // current seed.
      //   - Removed built-in IDs (REMOVED_BUILTIN_IDS[spaceId]) → deleted
      //   - Missing built-in IDs → appended (backfill)
      //   - Existing built-in IDs → geometry rewritten to match seed
      //     (so v7's new paired Settings layout actually lands for users
      //     who already have v6's full-width widgets)
      //   - Non-built-in IDs (user-added widgets) → never touched
      //   - Empty-source widgets → deleted (v9 cleanup)
      if (needsReseed) {
        const removedIds = REMOVED_BUILTIN_IDS[space.id] ?? new Set<string>();
        // Delete removed widgets first (iterate in reverse so index
        // mutations during `delete` don't skip items).
        for (let i = widgets.length - 1; i >= 0; i--) {
          const yw = widgets.get(i);
          const id = yw?.get('id');
          if (typeof id === 'string' && removedIds.has(id)) {
            widgets.delete(i, 1);
          }
        }
        // v9 cleanup: purge widgets with empty source
        for (let i = widgets.length - 1; i >= 0; i--) {
          const yw = widgets.get(i);
          const src = yw?.get('source');
          if (typeof src !== 'string' || src.trim() === '') {
            widgets.delete(i, 1);
          }
        }

        const builtinById = new Map<string, typeof space.widgets[number]>();
        for (const w of space.widgets) builtinById.set(w.id, w);
        const existingBuiltinIds = new Set<string>();
        widgets.forEach(yw => {
          const id = yw.get('id');
          if (typeof id === 'string' && builtinById.has(id)) {
            existingBuiltinIds.add(id);
            const seed = builtinById.get(id)!;
            yw.set('x', seed.x);
            yw.set('y', seed.y);
            yw.set('w', seed.w);
            yw.set('h', seed.h);
          }
        });
        for (const w of space.widgets) {
          if (!existingBuiltinIds.has(w.id)) widgets.push([defToYWidget(w)]);
        }
        meta.set('seedVersion', SEED_VERSION);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[SpaceEngine] healYSpaceOnSync failed for "${space.id}":`, err);
    }
  });
}

function loadFromStorage(): Space[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const version = parseInt(localStorage.getItem(`${STORAGE_KEY}-version`) || '0', 10);
    const needsReseed = version < SEED_VERSION;

    // Kick off async heal for every builtin space. Canvas receives the
    // deduped/backfilled state via `observe()` once whenSynced resolves.
    if (USE_CRDT) {
      for (const space of BUILTIN_SPACES) {
        healYSpaceOnSync(space, needsReseed);
      }
    }

    if (!raw || needsReseed) {
      localStorage.setItem(`${STORAGE_KEY}-version`, String(SEED_VERSION));
      const spaces = BUILTIN_SPACES.map(s => ({ ...s, widgets: [...s.widgets] }));
      saveToStorage(spaces);
      return spaces;
    }

    const parsed = JSON.parse(raw) as Space[];
    // Sanitize: strip corrupted widgets and ensure valid layout values
    for (const s of parsed) {
      if (!Array.isArray(s.widgets)) s.widgets = [];
      s.widgets = s.widgets
        .filter(w => w && typeof w.id === 'string')
        .map(w => ({
          ...w,
          x: Number.isFinite(w.x) ? Math.max(0, Math.floor(w.x)) : 0,
          y: Number.isFinite(w.y) ? Math.max(0, Math.floor(w.y)) : 0,
          w: Number.isFinite(w.w) ? Math.max(1, Math.floor(w.w)) : 4,
          h: Number.isFinite(w.h) ? Math.max(1, Math.floor(w.h)) : 4,
        }));
    }
    // Dedupe in-memory copy too (in case prior boots saved duplicates to localStorage)
    for (const s of parsed) {
      const seen = new Set<string>();
      s.widgets = s.widgets.filter(w => (seen.has(w.id) ? false : (seen.add(w.id), true)));
    }
    const map = new Map(parsed.map(s => [s.id, s]));
    BUILTIN_SPACES.forEach(b => {
      const existing = map.get(b.id);
      if (!existing) {
        map.set(b.id, { ...b, widgets: [...b.widgets] });
      } else if (existing.widgets.length === 0 && b.widgets.length > 0) {
        existing.widgets = b.widgets.map(w => ({ ...w }));
      }
    });
    return Array.from(map.values());
  } catch {
    return BUILTIN_SPACES.map(s => ({ ...s, widgets: [...s.widgets] }));
  }
}

let saveTimeout: ReturnType<typeof setTimeout> | null = null;
function saveToStorage(spaces: Space[]) {
  // Debounce: batch rapid mutations (drag, resize, multi-widget ops)
  // into a single localStorage write to avoid main-thread jank
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(spaces));
  }, 250);
}

let spacesCache: Space[] | null = null;

export const SpaceEngine = {
  list(): Space[] {
    if (!spacesCache) spacesCache = loadFromStorage();
    return spacesCache;
  },

  get(id: string): Space | undefined {
    return this.list().find(s => s.id === id);
  },

  create(name: string): Space {
    const space: Space = {
      id: `space_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      name,
      widgets: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    spacesCache = [...this.list(), space];
    saveToStorage(spacesCache);
    return space;
  },

  save(space: Space) {
    space.updatedAt = new Date().toISOString();
    spacesCache = this.list().map(s => s.id === space.id ? space : s);
    saveToStorage(spacesCache);
  },

  remove(id: string) {
    spacesCache = this.list().filter(s => s.id !== id);
    saveToStorage(spacesCache);
  },

  addWidget(spaceId: string, widget: Omit<WidgetDef, 'id' | 'createdAt' | 'updatedAt'>): WidgetDef {
    if (!widget.source || widget.source.trim() === '') {
      throw new Error('Widget source cannot be empty');
    }
    if (USE_CRDT) {
      const widgetDef = addYWidget(spaceId, widget);
      // Also sync to localStorage for metadata
      const space = this.get(spaceId);
      if (space) {
        space.widgets = [...space.widgets, widgetDef];
        this.save(space);
      }
      return widgetDef;
    }

    const space = this.get(spaceId);
    if (!space) throw new Error(`Space ${spaceId} not found`);
    const fullWidget: WidgetDef = {
      ...widget,
      id: `widget_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    space.widgets = [...space.widgets, fullWidget];
    this.save(space);
    return fullWidget;
  },

  updateWidget(spaceId: string, widgetId: string, patch: Partial<WidgetDef>) {
    if (USE_CRDT) {
      updateYWidget(spaceId, widgetId, patch);
    }
    const space = this.get(spaceId);
    if (!space) return;
    space.widgets = space.widgets.map(w =>
      w.id === widgetId ? { ...w, ...patch, updatedAt: Date.now() } : w
    );
    this.save(space);
  },

  removeWidget(spaceId: string, widgetId: string) {
    if (USE_CRDT) {
      removeYWidget(spaceId, widgetId);
    }
    const space = this.get(spaceId);
    if (!space) return;
    space.widgets = space.widgets.filter(w => w.id !== widgetId);
    this.save(space);
  },

  updateLayout(spaceId: string, layout: Array<{ i: string; x: number; y: number; w: number; h: number }>) {
    if (USE_CRDT) {
      for (const l of layout) {
        updateYWidget(spaceId, l.i, { x: l.x, y: l.y, w: l.w, h: l.h });
      }
    }
    const space = this.get(spaceId);
    if (!space) return;
    space.widgets = space.widgets.map(w => {
      const l = layout.find(item => item && item.i === w.id);
      if (!l) return w;
      return {
        ...w,
        x: Number.isFinite(l.x) ? Math.max(0, Math.floor(l.x)) : 0,
        y: Number.isFinite(l.y) ? Math.max(0, Math.floor(l.y)) : 0,
        w: Number.isFinite(l.w) ? Math.max(1, Math.floor(l.w)) : 4,
        h: Number.isFinite(l.h) ? Math.max(1, Math.floor(l.h)) : 4,
        updatedAt: Date.now(),
      };
    });
    this.save(space);
  },

  observe(spaceId: string, onChange: (widgets: WidgetDef[]) => void): () => void {
    if (USE_CRDT) {
      return observeSpace(spaceId, onChange);
    }
    return () => {};
  },

  /**
   * Hard-reset a space: wipe all widgets from Yjs + IndexedDB + localStorage.
   * Used by the canvas Clear button so deleted widgets don't re-appear after
   * a page reload (the old IDB state would otherwise resurrect them).
   */
  async clearSpace(spaceId: string): Promise<void> {
    if (USE_CRDT) {
      const { whenSynced } = getYSpace(spaceId);
      await whenSynced;
      clearYSpace(spaceId);
      destroyYSpace(spaceId);
      // Safety-net: delete the IndexedDB database so the next boot starts
      // completely fresh for this space. The DB name matches the constructor
      // arg passed to IndexeddbPersistence in CrdtEngine.
      try {
        const req = indexedDB.deleteDatabase(`titan-space-${spaceId}`);
        await new Promise<void>((resolve, reject) => {
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error);
          req.onblocked = () => resolve(); // resolve anyway — old connection will close
        });
      } catch {
        /* non-fatal */
      }
    }
    // Wipe localStorage copy too
    const all = this.list();
    const target = all.find(s => s.id === spaceId);
    if (target) {
      target.widgets = [];
      saveToStorage(all);
    }
  },
};
