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
      makeWidget('home-overview', 'Overview', 'system:overview', 0, 5, 6, 5),
      makeWidget('home-sessions', 'Sessions', 'system:sessions', 6, 5, 6, 5),
      makeWidget('home-watch', 'Watch', 'system:watch', 0, 10, 12, 7),
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
      makeWidget('cp-proposals', 'Self-Proposals', 'system:self-proposals', 0, 10, 12, 6),
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
      makeWidget('intel-wiki', 'Memory Wiki', 'system:memory-wiki', 0, 15, 6, 6),
      makeWidget('intel-autoresearch', 'Autoresearch', 'system:autoresearch', 6, 15, 6, 6),
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
      makeWidget('infra-vram', 'VRAM', 'system:vram', 0, 11, 6, 5),
      makeWidget('infra-fleet', 'Fleet', 'system:fleet', 6, 11, 6, 5),
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
      makeWidget('tools-recipes', 'Recipes', 'system:recipes', 0, 11, 6, 5),
      // beta.22 — 'tools-paperclip' deleted from the seed. system:paperclip
      // was killed in v6.0 step 1 as pre-v5 branding; the seed kept inserting
      // a broken widget on every fresh install. Existing installs are healed
      // by REMOVED_BUILTIN_IDS below (Tools space) plus the v9 empty-source
      // sweep, which together remove the orphan from Yjs.
      makeWidget('tools-browser', 'Browser', 'system:browser', 6, 11, 6, 5),
      makeWidget('tools-cron', 'Cron', 'system:cron', 0, 16, 6, 5),
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
//
// SEED_VERSION intentionally NOT bumped for the v6.1.0-beta.22 paperclip
// cleanup. The `needsReseed` branch in loadFromStorage() (line ~283) does
// a wholesale replace of persisted spaces with BUILTIN_SPACES, which
// would drop every user-added widget on the next boot — Codex P1 flagged
// this on the first review pass. Instead, the paperclip removal is
// handled surgically: `REMOVED_BUILTIN_IDS` is consulted on EVERY load
// (CRDT via healYSpaceOnSync, localStorage via the post-parse filter in
// loadFromStorage), so the broken widget gets stripped without touching
// user customizations.
const SEED_VERSION = 11;
const REMOVED_BUILTIN_IDS: Record<string, Set<string>> = {
  home: new Set(['home-chat']),
  // v6.1.0-beta.22 — tools-paperclip is dead: system:paperclip was killed
  // in v6.0 step 1 (pre-v5 branding) but the seed kept inserting it and
  // the dedup healer only matched widget IDs, not widgets whose source
  // had been removed from SYSTEM_COMPONENTS. Every existing install
  // carried a broken "Unknown system widget" Paperclip panel in Tools.
  tools: new Set(['tools-paperclip']),
};

// v6.1.0-beta.22 — source-based cleanup. Tony's installs accumulated
// user-added Paperclip and Daemon widgets via QuickLinks / CmdPalette
// before those launcher entries were removed this beta. Those widgets
// have random `widget_*` IDs, so REMOVED_BUILTIN_IDS doesn't match them —
// they survive as "Unknown system widget" panels forever. REMOVED_SOURCES
// catches them by source string regardless of ID. Consulted on every
// load by both healYSpaceOnSync (CRDT) and loadFromStorage (localStorage).
const REMOVED_SOURCES = new Set<string>([
  'system:paperclip',
  'system:daemon',
]);

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

      // Step 2a: ALWAYS strip removed-builtin IDs from Yjs, regardless of
      // version. Before v6.1.0-beta.22 this lived inside `if (needsReseed)`
      // so a dead builtin (e.g. tools-paperclip) only got cleaned up when
      // SEED_VERSION bumped. But bumping SEED_VERSION wipes user widgets
      // via the wholesale-reseed branch in loadFromStorage(), so the
      // cleanup couldn't ship that way. Pulling the removal out of the
      // version gate means an entry in REMOVED_BUILTIN_IDS reliably evicts
      // the widget from every existing install on the next CRDT sync,
      // without disturbing user-added widgets (those IDs aren't in the
      // builtin removal set).
      const removedIds = REMOVED_BUILTIN_IDS[space.id] ?? new Set<string>();
      if (removedIds.size > 0 || REMOVED_SOURCES.size > 0) {
        for (let i = widgets.length - 1; i >= 0; i--) {
          const yw = widgets.get(i);
          const id = yw?.get('id');
          const src = yw?.get('source');
          const idHit = typeof id === 'string' && removedIds.has(id);
          const srcHit = typeof src === 'string' && REMOVED_SOURCES.has(src);
          if (idHit || srcHit) {
            widgets.delete(i, 1);
          }
        }
      }

      // Step 2b: on version bump, reconcile built-in widgets with the
      // current seed.
      //   - Missing built-in IDs → appended (backfill)
      //   - Existing built-in IDs → geometry rewritten to match seed
      //     (so v7's new paired Settings layout actually lands for users
      //     who already have v6's full-width widgets)
      //   - Non-built-in IDs (user-added widgets) → never touched
      //   - Empty-source widgets → deleted (v9 cleanup)
      if (needsReseed) {
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
        // v6.1.0-beta.22 — strip widgets whose ID is in REMOVED_BUILTIN_IDS
        // for this space, OR whose source is in REMOVED_SOURCES regardless
        // of ID (catches user-added widgets created from the dead
        // QuickLinks / CmdPalette entries before they were removed; those
        // have random `widget_*` IDs). Mirror of the CRDT-side cleanup in
        // healYSpaceOnSync. Runs on every load (no version gate) so that
        // existing localStorage caches drop dead builtins like
        // 'tools-paperclip' without going through the wholesale-reseed
        // branch that would clobber user customizations.
        .filter(w => !(REMOVED_BUILTIN_IDS[s.id]?.has(w.id) ?? false))
        .filter(w => !(typeof w.source === 'string' && REMOVED_SOURCES.has(w.source)))
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
        // First time we've seen this builtin space — seed it with the
        // default widget set. New installs hit this path via the `!raw`
        // branch above; this covers the case where a new builtin space
        // is introduced in a later version.
        map.set(b.id, { ...b, widgets: [...b.widgets] });
      }
      // v6.0.3 — DO NOT auto-revive builtin widgets when an existing
      // space record has `widgets: []`. The earlier "if length === 0,
      // re-seed" branch silently re-introduced 5 builtin widgets into
      // memory on every load. Combined with `addWidget` persisting the
      // in-memory cache back to localStorage, the next CRDT phantom-
      // filter pass treated those builtins as user-truth, so 5 stale
      // panels exploded onto the canvas the moment the agent built ANY
      // new widget. A deliberately-cleared canvas now stays cleared.
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
      // v6.0.3 — Mirror to localStorage using the PERSISTED widget list
      // (not the in-memory cache). The cache can be primed by the
      // builtin-spaces seed; persisting that primed list would silently
      // mark builtin widget ids as "user truth" and the CRDT phantom-
      // filter would stop dropping them, dumping a bunch of stale
      // panels on the canvas right after a single create_widget. We
      // walk localStorage directly to get the exact persisted set, add
      // just the new widget, and write it back. Dedup defends against
      // double-fires from the SSE side-channel.
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        const persisted: Space[] = raw ? JSON.parse(raw) : [];
        const target = persisted.find(s => s.id === spaceId);
        if (target) {
          const existingIds = new Set((target.widgets || []).map(w => w.id));
          if (!existingIds.has(widgetDef.id)) {
            target.widgets = [...(target.widgets || []), widgetDef];
          }
          target.updatedAt = new Date().toISOString();
          spacesCache = persisted;
          saveToStorage(persisted);
        } else {
          // Space record doesn't exist in localStorage yet — create a
          // minimal one carrying only this widget. Builtins do NOT get
          // dragged in.
          const minimal: Space = {
            id: spaceId,
            name: spaceId,
            widgets: [widgetDef],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          spacesCache = [...persisted, minimal];
          saveToStorage(spacesCache);
        }
      } catch {
        // localStorage failure is non-fatal; the CRDT layer is the source of truth.
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
