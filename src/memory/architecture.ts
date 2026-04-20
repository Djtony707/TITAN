/**
 * TITAN — Architecture Map (v4.10.0-local polish)
 *
 * Structured knowledge of TITAN's own internal wiring, injected into
 * specialist prompts when a goal is self-mod tagged. Fixes the pattern
 * we saw 2026-04-19 morning: TITAN wrote solid auto-heal modules
 * (repair-strategies.ts, dep-monitor/types.ts) but left them dangling
 * because specialists don't know "after you write X, wire into Y."
 *
 * Each subsystem lists:
 *   - purpose    — one-line summary
 *   - files      — canonical file paths
 *   - integrationPoints — "when you do X, you must also Y"
 *   - examples   — existing patterns to follow
 *
 * Rendered as a compact prompt block for Builder/Analyst/etc during
 * self-mod work.
 */

export interface IntegrationPoint {
    when: string;
    mustAlso: string[];
    example?: string;
}

export interface Subsystem {
    id: string;
    purpose: string;
    files: string[];
    integrationPoints: IntegrationPoint[];
    /** Keywords that trigger this subsystem's relevance to a goal. */
    triggers?: string[];
}

// ── The map ──────────────────────────────────────────────────────

export const TITAN_ARCHITECTURE: Subsystem[] = [
    {
        id: 'goal-driver',
        purpose: 'Phase state machine that owns a goal from active→done. Replaces the old passive initiative model.',
        files: [
            'src/agent/goalDriver.ts',
            'src/agent/goalDriverTypes.ts',
            'src/agent/driverScheduler.ts',
            'src/agent/fallbackChain.ts',
            'src/agent/budgetEnforcer.ts',
            'src/agent/specialistRouter.ts',
            'src/agent/subtaskTaxonomy.ts',
            'src/agent/verifier.ts',
        ],
        triggers: ['driver', 'goal', 'phase', 'scheduler', 'subtask'],
        integrationPoints: [
            {
                when: 'Adding a new subtask kind',
                mustAlso: [
                    'Add to SubtaskKind type in src/agent/subtaskTaxonomy.ts',
                    'Add classification keywords to classifySubtask() switch',
                    'Add an entry to ROUTE_TABLE in src/agent/specialistRouter.ts',
                    'Add a verifier function to src/agent/verifier.ts + register in verifyByKind switch',
                ],
                example: 'See how `research` kind is defined: taxonomy → router (scout) → verifier (source markers + length)',
            },
            {
                when: 'Adding a new driver phase',
                mustAlso: [
                    'Add to DriverPhase union in src/agent/goalDriverTypes.ts',
                    'Add a tickXxx() function in goalDriver.ts',
                    'Add case to the switch in tickDriver()',
                    'Update the phase-color map in ui/src/components/command-post/CPDrivers.tsx',
                ],
            },
            {
                when: 'Adding a new specialist',
                mustAlso: [
                    'Add to SPECIALISTS array in src/agent/specialists.ts',
                    'Add to ROUTE_TABLE in src/agent/specialistRouter.ts for relevant kind',
                    'Update fallbackChain.ts model ladder if the specialist has a unique model preference',
                ],
                example: 'Scout/Builder/Writer/Analyst all follow this pattern in specialists.ts',
            },
        ],
    },
    {
        id: 'soma',
        purpose: 'Homeostatic drives (purpose, hunger, curiosity, safety, social) with pressure feedback + goal proposer.',
        files: [
            'src/organism/drives.ts',
            'src/organism/pressure.ts',
            'src/agent/goalProposer.ts',
            'src/agent/somaFeedback.ts',
        ],
        triggers: ['drive', 'soma', 'pressure', 'curiosity', 'hunger', 'purpose', 'safety', 'social'],
        integrationPoints: [
            {
                when: 'Adding a new drive',
                mustAlso: [
                    'Add DriveId to src/organism/drives.ts union',
                    'Add DriveDefinition to DRIVES array with setpoint, weight, input mapper',
                    'Add input snapshot field to DriveSnapshot + buildSnapshot()',
                    'Add delta entry to GOAL_COMPLETE_DELTA / GOAL_FAILED_DELTA in src/agent/somaFeedback.ts',
                    'Add per-event cap in src/safety/metricGuard.ts PER_EVENT_DELTA_CAP',
                ],
            },
            {
                when: 'Adding a drive input signal',
                mustAlso: [
                    'Install a global provider in src/gateway/server.ts (e.g. __titan_metrics_summary)',
                    'Read it inside buildSnapshot() in drives.ts',
                    'Feed into the drive definition\'s input mapper',
                ],
                example: 'See __titan_unresolved_error_patterns for curiosity drive',
            },
        ],
    },
    {
        id: 'self-repair',
        purpose: 'Meta-watcher daemon: sweeps every 5 min for stuck drives / stalled goals / anomalies / integrity dips. Proposes fixes via approvals, never auto-executes.',
        files: ['src/safety/selfRepair.ts', 'src/safety/fixOscillation.ts', 'src/safety/killSwitch.ts'],
        triggers: ['repair', 'self-repair', 'heal', 'auto-heal', 'oscillation', 'kill-switch'],
        integrationPoints: [
            {
                when: 'Adding a new self-repair check',
                mustAlso: [
                    'Add SelfRepairFinding.kind to src/safety/selfRepair.ts union',
                    'Write an async checkXxx(out) function + add to Promise.all in runSelfRepairSweep',
                    'Include stable dedupe key (driveId or goalId) in evidence so dedupe logic works',
                ],
                example: 'See checkDrivesStuckHigh, checkGoalsStuckActive, checkIntegrityRatio',
            },
            {
                when: 'Wiring a new auto-heal strategy module (e.g. src/lib/auto-heal/*)',
                mustAlso: [
                    'Import the strategy class into src/safety/selfRepair.ts or a new src/safety/autoHealRunner.ts',
                    'Call strategy.canHandle(issue) during a fix-oscillation event',
                    'If it returns true, call strategy.execute(issue) and record result as RepairResult',
                    'Fire a self_mod_pr approval if the strategy wants to modify /opt/TITAN',
                    'Log every repair attempt via episodic (kind=significant_learning)',
                ],
                example: 'src/lib/auto-heal/repair-strategies.ts has 6 strategy classes — MissingPackageRepair, BrokenImportRepair, etc. Each has canHandle+planActions+execute. None are wired yet.',
            },
        ],
    },
    {
        id: 'self-mod-staging',
        purpose: 'Staging pipeline for self-modifications: scope-locked writes divert to ~/.titan/self-mod-staging/<goalId>/, file a self_mod_pr approval, apply on human approve. Full safety chain: write → stage → secret/license scan → Opus review → apply.',
        files: [
            'src/agent/selfModStaging.ts',
            'src/agent/stagingScanners.ts',
            'src/agent/rollbackGoal.ts',
            'src/safety/opusReview.ts',
        ],
        triggers: ['self-mod', 'staging', 'scope-lock', 'self-modification', 'review', 'opus'],
        integrationPoints: [
            {
                when: 'Adding a self-mod trigger keyword',
                mustAlso: [
                    'Add regex to SELF_MOD_TAG_PATTERNS in src/agent/selfModStaging.ts',
                    'Optional: add to autonomy.selfMod.tags config default in src/config/schema.ts',
                ],
            },
            {
                when: 'Adding a secret/license scanner pattern',
                mustAlso: [
                    'Add to SECRET_PATTERNS or LICENSE_PATTERNS in src/agent/stagingScanners.ts',
                    'Include falsePositivePatterns if the literal might match in legitimate code',
                ],
            },
            {
                when: 'Tweaking the Opus review prompt or criteria',
                mustAlso: [
                    'Modify buildReviewPrompt() in src/safety/opusReview.ts',
                    'Keep the JSON verdict shape stable (verdict/confidence/concerns/suggestions)',
                    'Config under autonomy.selfMod.reviewer — enabled, model, maxDiffChars, blockOnReject',
                ],
                example: 'The review runs between scanner pass + file copy in applyStagedPR. Verdict "reject" or "needs_changes" blocks the apply with concerns surfaced in the approval payload.',
            },
        ],
    },
    {
        id: 'tools',
        purpose: 'Tool registry + executor. Every tool TITAN uses flows through toolRunner.executeTool().',
        files: [
            'src/agent/toolRunner.ts',
            'src/agent/toolCategories.ts',
            'src/skills/registry.ts',
        ],
        triggers: ['tool', 'skill', 'toolrunner', 'executeTool'],
        integrationPoints: [
            {
                when: 'Adding a new tool',
                mustAlso: [
                    'Create src/skills/builtin/<name>.ts exporting registerXxxSkill()',
                    'Register inside registry.ts via SKILL_REGISTRARS map',
                    'If it mutates files, add to MUTATING_TOOLS set in src/agent/toolRunner.ts',
                    'If it spawns sub-agents, add to BLOCKED_CHILD_TOOLS in src/agent/subagentSafety.ts',
                ],
                example: 'See src/skills/builtin/shell.ts or weather.ts for the full pattern',
            },
            {
                when: 'Making a tool kill-switch-aware',
                mustAlso: [
                    'Add to MUTATING_TOOLS in toolRunner.ts (automatically gated by kill switch + scope lock)',
                ],
            },
        ],
    },
    {
        id: 'api',
        purpose: 'Express HTTP server. All /api/* endpoints live in src/gateway/server.ts.',
        files: ['src/gateway/server.ts'],
        triggers: ['api', 'endpoint', 'http', 'route', 'server'],
        integrationPoints: [
            {
                when: 'Adding a new API endpoint',
                mustAlso: [
                    'Add app.<method>(...) in src/gateway/server.ts, near related endpoints',
                    'Auth is enforced by middleware above — no per-route guard needed',
                    'Wrap handler body in try/catch returning 500 on error',
                    'If the data would be useful in the UI, add a corresponding panel or API client method',
                ],
                example: 'See /api/drivers, /api/approvals/categorized, /api/files/edited for the pattern',
            },
            {
                when: 'Adding an SSE stream endpoint',
                mustAlso: [
                    'Copy pattern from existing /api/activity/stream',
                    'Use globalThis.__titan_sse_broadcast + subscribers list',
                    'Clean up on req.on("close")',
                ],
            },
        ],
    },
    {
        id: 'ui',
        purpose: 'React 19 SPA in ui/. Mission Control panels tabs live in CommandPostHub.tsx.',
        files: [
            'ui/src/components/admin/CommandPostHub.tsx',
            'ui/src/components/command-post/',
        ],
        triggers: ['ui', 'react', 'panel', 'tab', 'mission control', 'dashboard'],
        integrationPoints: [
            {
                when: 'Adding a new Command Post tab',
                mustAlso: [
                    'Create ui/src/components/command-post/CPYourName.tsx as default-exported component',
                    'Add to TABS array in ui/src/components/admin/CommandPostHub.tsx',
                    'Add lazy import at top of file',
                    'Add case in the render switch for the new tab name',
                    'Follow the PageHeader + lazy-Suspense pattern',
                ],
                example: 'CPDrivers, CPDigest, CPFiles — all follow this pattern',
            },
        ],
    },
    {
        id: 'memory',
        purpose: 'Identity, episodic, working, experiments, playbooks. Long-term state persistence.',
        files: [
            'src/memory/identity.ts',
            'src/memory/episodic.ts',
            'src/memory/workingMemory.ts',
            'src/memory/experiments.ts',
            'src/memory/learning.ts',
            'src/agent/playbooks.ts',
            'src/agent/retrospectives.ts',
        ],
        triggers: ['memory', 'episodic', 'experiment', 'playbook', 'retrospective', 'knowledge'],
        integrationPoints: [
            {
                when: 'Adding a new episodic event kind',
                mustAlso: [
                    'Add to EpisodeKind union in src/memory/episodic.ts',
                    'Call recordEpisode({kind, summary, detail, tags}) at the relevant event site',
                    'Consider adding a filter case in src/agent/editedFiles.ts listResearch()',
                ],
            },
            {
                when: 'Persisting new per-goal state',
                mustAlso: [
                    'Create an interface + writeFileSync to ~/.titan/<your-file>.json or .jsonl',
                    'Use atomic rename (writeFileSync .tmp → renameSync) to avoid partial writes',
                    'Add schemaVersion field + migration on load',
                    'Bound the file (ring buffer or trim) so it doesn\'t grow unbounded',
                ],
                example: 'See goalDriver.ts saveState() pattern',
            },
        ],
    },
    {
        id: 'approvals',
        purpose: 'Command Post approval queue. Every approval has a payload + can be approved/rejected. Handlers fire on approve.',
        files: ['src/agent/commandPost.ts'],
        triggers: ['approval', 'approve', 'human-in-loop', 'command-post'],
        integrationPoints: [
            {
                when: 'Adding a new approval kind',
                mustAlso: [
                    'Decide if it\'s a standalone type (like hire_agent) OR a custom+kind (like self_mod_pr)',
                    'Call createApproval({type, requestedBy, payload, linkedIssueIds}) at the trigger site',
                    'Add handler logic to approveApproval() / rejectApproval() in commandPost.ts',
                    'Add entry to categorizeApproval() so UI can sort by urgency',
                    'Update extractHeadline() in ui/src/components/command-post/CPApprovals.tsx for rendering',
                ],
                example: 'self_mod_pr is handled in approveApproval with the applyStagedPR() call',
            },
        ],
    },
];

// ── Render ───────────────────────────────────────────────────────

/**
 * Render a compact architecture block for a specialist prompt.
 * If `goalContext` is provided (title + tags), we filter subsystems by
 * relevance to keep the block short. Otherwise render all subsystems.
 */
export function renderArchitectureBlock(goalContext?: { title?: string; tags?: string[] }): string {
    const haystack = `${goalContext?.title || ''} ${(goalContext?.tags || []).join(' ')}`.toLowerCase();
    const filtered = goalContext
        ? TITAN_ARCHITECTURE.filter(s =>
            (s.triggers || []).some(t => haystack.includes(t.toLowerCase()))
          )
        : TITAN_ARCHITECTURE;

    // Fall back to ALL subsystems if no triggers matched (better too much than too little)
    const picked = filtered.length > 0 ? filtered : TITAN_ARCHITECTURE;

    const lines: string[] = [
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        'TITAN SELF-MOD CONTEXT — know WHERE your code plugs in',
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        '',
        'TITAN is the codebase at /opt/TITAN. When you write a new module,',
        'you MUST also wire it into the relevant subsystem below. A file',
        'that isn\'t imported anywhere is dead code — the goal is NOT done',
        'until the integration is in place.',
        '',
    ];

    for (const s of picked) {
        lines.push(`## ${s.id.toUpperCase()} — ${s.purpose}`);
        lines.push(`files: ${s.files.slice(0, 4).join(', ')}${s.files.length > 4 ? ` (+${s.files.length - 4} more)` : ''}`);
        for (const ip of s.integrationPoints) {
            lines.push(`  · ${ip.when}:`);
            for (const m of ip.mustAlso) lines.push(`      - ${m}`);
            if (ip.example) lines.push(`      [example: ${ip.example}]`);
        }
        lines.push('');
    }
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('RULE: if you create a new file, add a subtask to your own plan titled');
    lines.push('"Wire <module> into <existing-file>" so the integration actually happens.');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    return lines.join('\n');
}

/**
 * Find subsystems likely relevant to a goal's title + tags.
 * Returns subsystem ids.
 */
export function relevantSubsystems(goalContext: { title?: string; tags?: string[] }): string[] {
    const haystack = `${goalContext.title || ''} ${(goalContext.tags || []).join(' ')}`.toLowerCase();
    return TITAN_ARCHITECTURE
        .filter(s => (s.triggers || []).some(t => haystack.includes(t.toLowerCase())))
        .map(s => s.id);
}
