# v6.0 Admin Buckets — A / B / C split

The v5.x dashboard had 45+ fixed admin pages — too many. v6.0 splits them
into three buckets so the user sees the right surface in the right place.

## Bucket A — Fixed admin pages (7, accessible via `⚙ Admin` link)

These configure TITAN itself. Every user needs them, and they don't belong
on a per-Space canvas. The Spaces sidebar's footer carries an `⚙ Admin`
link to the Command Post hub that exposes them.

| Page | Why fixed |
|---|---|
| `SettingsPanel` | Model / temperature / token knobs |
| `IntegrationsPanel` | API keys, OAuth |
| `SkillsPanel` | Enable / disable tools globally |
| `ChannelsPanel` | Discord / Slack / IRC / etc. |
| `SecurityPanel` | Auth tokens, scanner rules, redaction |
| `CommandPostPanel` | Multi-agent governance (budgets, checkout, ancestry) |
| `SessionsPanel` | Chat history index |

## Bucket B — Convert to pinnable system widgets (36)

These are data views. v6.0 surfaces them through the widget gallery as
`system:<name>` entries so users can pin them to whichever Space they want.
TitanCanvas already maps each `system:xxx` source to its React component
(`SYSTEM_COMPONENTS` map in `ui/src/titan2/canvas/TitanCanvas.tsx`).

`Activity`, `Agents`, `ApprovalProgress`, `Audit`, `Autonomy`, `Autopilot`,
`Autoresearch`, `Backup`, `Browser`, `Checkpoints`, `Cron`, `Dream`,
`EvalHarness`, `Eval`, `Files`, `Fleet`, `Homelab`, `Learning`, `Logs`,
`Mcp`, `MemoryGraph`, `MemoryWiki`, `Mesh`, `Nvidia`, `Organism`,
`Overview`, `PersonaProfiles`, `Personas`, `Recipes`, `SelfImprove`,
`SelfProposals`, `Teams`, `Telemetry`, `Training`, `Vram`, `Workflows`.

Migration 005 (`005-route-redirects.ts`) writes a redirect map at
`~/.titan/route-redirects.json` so existing bookmarks like `/admin/dream`
land on `/space/default` with the matching widget auto-pinned.

## Bucket C — Killed (2)

Removed in v6.0:

| Panel | Reason |
|---|---|
| `DaemonPanel` | Overlapped with `OrganismPanel`. The Organism (Soma) layer is the canonical "is TITAN's brain ticking" surface. |
| `PaperclipPanel` | Pre-v5 branding from the Paperclip era; no longer referenced from any modern code path. |

These files are deleted from the repo:
- `ui/src/components/admin/DaemonPanel.tsx`
- `ui/src/components/admin/PaperclipPanel.tsx`
- `ui/src/titan2/system/widgets/DaemonWidget.tsx`
- `ui/src/titan2/system/widgets/PaperclipWidget.tsx`

Their `system:daemon` and `system:paperclip` entries are removed from
both the `SYSTEM_COMPONENTS` map and the widget-gallery template list.

## How a v5.x user's bookmark survives the rework

1. User clicks `https://titan.local:48420/admin/dream` (an old v5 admin route)
2. Migration 005 has populated `~/.titan/route-redirects.json` with
   `{ from: "/admin/dream", pinWidget: "system-dream" }`
3. The React router (post-shell rework, Steps 1 + 2) reads that map at
   boot, sees the redirect, navigates to `/space/default`, and uses the
   `pinWidget` field to call `create_widget({ template: "system-dream" })`
4. User lands on their default Space with the Dream widget already pinned

No code change required from the user. The redirect map is the migration's
durable contract.
