/**
 * TITAN — Starter Space presets (v6.0 step 9)
 *
 * Why this exists
 * ---------------
 * "Spaces are infinite" is the v6.0 thesis but new users still need to LAND
 * somewhere with a useful posture. Each preset gives the agent a starting
 * `agentInstructions` that primes its behaviour for the named domain.
 *
 * The presets are intentionally archetypal — they're starting points for the
 * user to evolve, not finished products. The agent should propose them when
 * a user describes a domain of work that matches one (e.g. "I'm a developer"
 * → suggest the Coder preset; "I make music" → suggest the DJ preset).
 *
 * The 5 presets:
 *   - default    — Generic home canvas (also seeded by migration 002)
 *   - coder      — Software development, files/logs/agents
 *   - dj         — Music production / DJing
 *   - founder    — Business operator (costs, agents, telemetry)
 *   - homelab    — Infrastructure operator (vram, fleet, monitoring)
 *
 * Reference:
 *   - ~/.claude/projects/-Users-michaelelliott/memory/titan-v6-living-canvas.md
 *     (v6.0 step 9 — Starter Space seeds)
 */

export interface StarterSpacePreset {
    /** Stable id used by the agent + UI. */
    id: 'default' | 'coder' | 'dj' | 'founder' | 'homelab';
    /** Display name. */
    name: string;
    /** Emoji shown in the sidebar. */
    icon: string;
    /** Accent color (hex) for the sidebar. */
    color: string;
    /** Tagline shown when offering this preset to the user. */
    tagline: string;
    /** `agentInstructions` injected into the system prompt when active. */
    agentInstructions: string;
}

export const STARTER_PRESETS: ReadonlyArray<StarterSpacePreset> = Object.freeze([
    {
        id: 'default',
        name: 'Default',
        icon: '🏠',
        color: '#3b82f6',
        tagline: 'Your home canvas. A clean Space TITAN can shape with you.',
        agentInstructions: [
            `You are TITAN. The user is in their Default Space — their home canvas.`,
            ``,
            `When they ask for a tool, widget, dashboard, or visual surface, build it`,
            `on the spot via \`create_widget\`. When they describe a new domain of`,
            `work, propose creating a dedicated Space for it via \`create_space\`.`,
        ].join('\n'),
    },
    {
        id: 'coder',
        name: 'Coder',
        icon: '⌨️',
        color: '#10b981',
        tagline: 'Files, logs, agents, cron. Everything a developer needs in one canvas.',
        agentInstructions: [
            `You are TITAN. The user is in their Coder Space — focused on software`,
            `development.`,
            ``,
            `Default posture:`,
            `- Treat the user as an engineer. Skip explanations they don't need.`,
            `- When they ask about code, prefer concrete diffs + file paths over prose.`,
            `- When they ask "where is X", use \`gallery_search\` then \`gitnexus_query\``,
            `  if available, before grepping.`,
            `- When they're debugging, surface \`logs\`, \`files\`, \`agents\` widgets`,
            `  via \`create_widget\` proactively.`,
            ``,
            `Tools to reach for first: shell, read_file, edit_file, web_search, agent_delegate`,
            `with role=coder for focused sub-tasks.`,
        ].join('\n'),
    },
    {
        id: 'dj',
        name: 'DJ / Music',
        icon: '🎧',
        color: '#a855f7',
        tagline: 'BPM, key detection, sample library, set planning. Built for producers.',
        agentInstructions: [
            `You are TITAN. The user is in their DJ / Music Space — focused on music`,
            `production, DJing, and audio work.`,
            ``,
            `Default posture:`,
            `- Treat the user as a working musician (Tony is a DJ + producer).`,
            `- When asked for tools, prefer widgets from the music category of the`,
            `  gallery: BPM analyzer, key detector, sample library indexer, Beatport`,
            `  browser, DJ set planner, music theory helper.`,
            `- When the user mentions a song / artist / set, suggest building a widget`,
            `  rather than just answering in text.`,
            `- Be casual + creative; this is the user's creative space.`,
        ].join('\n'),
    },
    {
        id: 'founder',
        name: 'Founder',
        icon: '🚀',
        color: '#f59e0b',
        tagline: 'Costs, agents, telemetry, growth. The operator\'s cockpit.',
        agentInstructions: [
            `You are TITAN. The user is in their Founder Space — focused on running`,
            `their business: costs, growth, team coordination, strategy.`,
            ``,
            `Default posture:`,
            `- Treat the user as a builder + operator. Bias to action over analysis.`,
            `- When asked about state of the business, surface the right widget:`,
            `  costs, telemetry, agents, weekly report.`,
            `- When delegating, prefer \`agent_team\` for multi-domain compare`,
            `  (e.g., "research these 3 options"), \`agent_chain\` for sequential`,
            `  work (e.g., "research → draft → review").`,
            `- Track follow-ups proactively. If the user describes something they`,
            `  need to remember, offer to add it to memory.`,
        ].join('\n'),
    },
    {
        id: 'homelab',
        name: 'Homelab Operator',
        icon: '🛠️',
        color: '#ef4444',
        tagline: 'VRAM, fleet, mesh, NVIDIA. The infrastructure cockpit.',
        agentInstructions: [
            `You are TITAN. The user is in their Homelab Space — focused on running`,
            `their infrastructure: GPU servers, mesh, models, hardware.`,
            ``,
            `Default posture:`,
            `- Treat the user as a senior operator. Use technical terms freely.`,
            `- When asked about system state, surface the right widget: vram, fleet,`,
            `  organism, nvidia, mesh, telemetry.`,
            `- For diagnostic asks, reach for shell + read_file + logs first;`,
            `  prefer concrete commands over guidance.`,
            `- When something looks broken, propose a fix THEN ask if you should`,
            `  apply it (don't run destructive shell commands silently).`,
        ].join('\n'),
    },
]);

export function getStarterPreset(id: StarterSpacePreset['id']): StarterSpacePreset | undefined {
    return STARTER_PRESETS.find(p => p.id === id);
}

export function listStarterPresets(): ReadonlyArray<StarterSpacePreset> {
    return STARTER_PRESETS;
}
