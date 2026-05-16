/**
 * Migration 005 — route-redirects
 *
 * v6.0's shell collapses 36 admin panels into the widget gallery. v5.x
 * users have bookmarks to `/admin/dream`, `/command-post/agents`,
 * `/admin/training`, etc. that would 404 after the shell rework. This
 * migration writes a redirect map the React Router config consumes at
 * boot to keep those bookmarks working — they land on `/space/default`
 * with the corresponding widget auto-pinned.
 *
 * No code change is forced; the file is purely declarative data the
 * frontend reads on first load.
 */
import { unlinkSync } from 'fs';
import { join } from 'path';
import type { Migration } from './runner.js';

interface RouteRedirect {
    from: string;
    /** target Space — defaults to "default" if absent. */
    spaceId?: string;
    /** Optional widget template id to auto-pin after redirect. */
    pinWidget?: string;
}

interface RedirectsFile {
    schema: 1;
    redirects: RouteRedirect[];
    generatedAt: string;
}

export const migration: Migration = {
    id: '005-route-redirects',
    version: '6.0.0-beta.1',
    description: 'Write a v5→v6 admin-route redirect map so existing bookmarks keep working.',

    async up(ctx) {
        const redirects: RouteRedirect[] = [
            // The 36 panels that move from fixed admin routes to widgets.
            { from: '/admin/dream',           pinWidget: 'system-dream' },
            { from: '/admin/training',        pinWidget: 'system-training' },
            { from: '/admin/vram',            pinWidget: 'system-vram' },
            { from: '/admin/cron',            pinWidget: 'system-cron' },
            { from: '/admin/logs',            pinWidget: 'system-logs' },
            { from: '/admin/activity',        pinWidget: 'system-activity' },
            { from: '/admin/agents',          pinWidget: 'system-agents' },
            { from: '/admin/memory-graph',    pinWidget: 'system-memory-graph' },
            { from: '/admin/memory-wiki',     pinWidget: 'system-memory-wiki' },
            { from: '/admin/organism',        pinWidget: 'system-organism' },
            { from: '/admin/fleet',           pinWidget: 'system-fleet' },
            { from: '/admin/files',           pinWidget: 'system-files' },
            { from: '/admin/personas',        pinWidget: 'system-personas' },
            { from: '/admin/persona-profiles', pinWidget: 'system-persona-profiles' },
            { from: '/admin/recipes',         pinWidget: 'system-recipes' },
            { from: '/admin/workflows',       pinWidget: 'system-workflows' },
            { from: '/admin/autopilot',       pinWidget: 'system-autopilot' },
            { from: '/admin/autonomy',        pinWidget: 'system-autonomy' },
            { from: '/admin/autoresearch',    pinWidget: 'system-autoresearch' },
            { from: '/admin/self-improve',    pinWidget: 'system-self-improve' },
            { from: '/admin/self-proposals',  pinWidget: 'system-self-proposals' },
            { from: '/admin/teams',           pinWidget: 'system-teams' },
            { from: '/admin/telemetry',       pinWidget: 'system-telemetry' },
            { from: '/admin/learning',        pinWidget: 'system-learning' },
            { from: '/admin/eval-harness',    pinWidget: 'system-eval-harness' },
            { from: '/admin/evals',           pinWidget: 'system-evals' },
            { from: '/admin/audit',           pinWidget: 'system-audit' },
            { from: '/admin/backup',          pinWidget: 'system-backup' },
            { from: '/admin/browser',         pinWidget: 'system-browser' },
            { from: '/admin/checkpoints',     pinWidget: 'system-checkpoints' },
            { from: '/admin/homelab',         pinWidget: 'system-homelab' },
            { from: '/admin/mcp',             pinWidget: 'system-mcp' },
            { from: '/admin/mesh',            pinWidget: 'system-mesh' },
            { from: '/admin/nvidia',          pinWidget: 'system-nvidia' },
            { from: '/admin/approval-progress', pinWidget: 'system-approvals' },
            { from: '/admin/overview',        pinWidget: 'system-overview' },
            // Command-post legacy routes redirect to their fixed admin home,
            // not to widget pins (Command-post stays a fixed page in v6).
            { from: '/command-post/agents',   spaceId: 'admin', pinWidget: 'system-agents' },
            { from: '/command-post/activity', spaceId: 'admin', pinWidget: 'system-activity' },
        ];

        // Idempotent write. If the user has hand-edited the file, leave
        // their version alone — we only overwrite when our generated set
        // differs in structure (catches the v5.7→v6 boot path).
        const existing = ctx.readJson<RedirectsFile>('route-redirects.json');
        if (existing && Array.isArray(existing.redirects) && existing.redirects.length >= redirects.length) {
            ctx.log(`Skipped — route-redirects.json already has ${existing.redirects.length} entries.`);
            return;
        }
        const out: RedirectsFile = {
            schema: 1,
            redirects,
            generatedAt: new Date().toISOString(),
        };
        ctx.writeJson('route-redirects.json', out);
        ctx.log(`Wrote ${redirects.length} v5→v6 route redirects.`);
    },

    async rollback(ctx) {
        // Removing the redirect map causes old bookmarks to 404 again —
        // bad UX but reversible by re-running the migration. Only remove
        // when the user has reverted to a v5.x codebase that won't read it.
        try {
            unlinkSync(join(ctx.titanHome, 'route-redirects.json'));
            ctx.log('Removed route-redirects.json.');
        } catch {
            ctx.log('rollback: route-redirects.json already absent.');
        }
    },
};
