/**
 * WidgetGallery — Space Agent parity (v5.0).
 *
 * A gallery of curated widget-generation prompts. Clicking a card
 * dispatches `titan:chat:prompt` + `titan:chat:toggle { open: true }`
 * so the chat dock opens and auto-sends the prompt. The chat's LLM
 * then uses `titan.canvas.createWidget(...)` to generate the widget
 * on the current space — no extra wiring needed.
 *
 * Why a gallery:
 *   - Generating a widget from scratch often fails because the LLM
 *     has to guess the exact shape of the titan.* API. These prompts
 *     are pre-tuned to produce widgets that actually render on the
 *     first try.
 *   - Gives new TITAN users an immediate sense of what the canvas can
 *     do without requiring them to read the system prompt or guess.
 *
 * Categories mirror Space Agent's sections (Productivity / Data / Fun
 * / System) but are TITAN-flavoured.
 */
import React, { useEffect, useState } from 'react';
import { X, Sparkles, Send, LayoutGrid } from 'lucide-react';

interface Props {
    open: boolean;
    onClose: () => void;
}

type Category = 'Productivity' | 'Data' | 'Fun' | 'System';

interface Prompt {
    category: Category;
    title: string;
    blurb: string;
    prompt: string;
}

// Pre-tuned prompts. Each one explicitly asks for a widget via
// `titan.canvas.createWidget(...)`, names the format, and includes the
// sizing so the generated widget lands well without needing the user
// to clarify. Keep them under ~360 chars so the LLM doesn't hallucinate
// extra constraints.
const PROMPTS: Prompt[] = [
    {
        category: 'Productivity',
        title: 'Todo list',
        blurb: 'A simple add/complete/delete list with state persistence.',
        prompt: 'Create a todo list widget. Use format "react", width 4, height 6. Persist items via titan.state.set/get with key "todo-items". Show an input + add button at the top, then the list below with checkbox + delete. When a task is complete, strike it through.',
    },
    {
        category: 'Productivity',
        title: 'Quick notes',
        blurb: 'Freeform scratchpad with autosave.',
        prompt: 'Create a scratchpad note widget. Format "react", 4x6. Single <textarea> filling the panel, debounce saves to titan.state.set("scratch-pad") every 400ms, restore from titan.state.get on mount.',
    },
    {
        category: 'Data',
        title: 'Weather',
        blurb: 'Current conditions + 3-day forecast.',
        prompt: 'Create a weather widget. Format "react", 5x5. Use titan.fetch to hit https://api.open-meteo.com/v1/forecast?latitude=37&longitude=-122&current_weather=true&daily=temperature_2m_max,temperature_2m_min&timezone=auto and render current temp + next 3 days. Handle the loading state with a spinner.',
    },
    {
        category: 'Data',
        title: 'GitHub repo stats',
        blurb: 'Stars / forks / last-commit for a repo.',
        prompt: 'Create a GitHub repo stats widget. Format "react", 5x4. Input field for "owner/repo" (default "Djtony707/TITAN"). Use titan.fetch to hit https://api.github.com/repos/{owner}/{repo} and display stars, forks, open issues, and last push date.',
    },
    {
        category: 'Data',
        title: 'Crypto price ticker',
        blurb: 'Live BTC + ETH via CoinGecko.',
        prompt: 'Create a crypto ticker widget. Format "react", 4x3. Poll titan.fetch on https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd every 30s. Show BTC and ETH USD price with tiny up/down arrow vs. last value.',
    },
    {
        category: 'System',
        title: 'TITAN stats',
        blurb: 'Live gateway health + skill/tool counts.',
        prompt: 'Create a TITAN stats widget. Format "react", 4x4. Use titan.api.call("/health") and titan.api.call("/stats") to display version, uptime, skills, and tools. Refresh every 15 seconds.',
    },
    {
        category: 'System',
        title: 'Cron jobs',
        blurb: 'Scheduled jobs + next run times.',
        prompt: 'Create a cron jobs widget. Format "react", 6x5. Use titan.api.call("/cron") to list jobs. Show each job with its name, schedule, and next run time (ISO string is fine). Refresh every 30s.',
    },
    {
        category: 'Fun',
        title: 'Pomodoro timer',
        blurb: '25/5 focus timer with sound cue.',
        prompt: 'Create a pomodoro timer widget. Format "react", 4x4. Big countdown display, start/pause/reset buttons, toggles between 25-minute focus and 5-minute break. Beep when switching (just play a short oscillator tone via AudioContext).',
    },
    {
        category: 'Fun',
        title: 'Conway&rsquo;s Game of Life',
        blurb: 'Canvas-based cellular automaton.',
        prompt: 'Create a Game of Life widget. Format "vanilla", 6x6. Render a 40x40 grid on a <canvas>, randomize on load, step 6 times per second. Click a cell to toggle it. Reset button at the top.',
    },
    {
        category: 'Fun',
        title: 'Mini drawing board',
        blurb: 'Freehand sketch with clear.',
        prompt: 'Create a drawing board widget. Format "vanilla", 6x6. Render a full-size <canvas>, draw a black line on pointer drag, clear button in a corner. Don\'t use any libraries.',
    },
];

const CATEGORY_COLOR: Record<Category, string> = {
    Productivity: '#a78bfa',
    Data: '#34d399',
    System: '#60a5fa',
    Fun: '#f59e0b',
};

export function WidgetGallery({ open, onClose }: Props) {
    const [active, setActive] = useState<Category | 'All'>('All');

    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, onClose]);

    if (!open) return null;

    const filtered = active === 'All' ? PROMPTS : PROMPTS.filter(p => p.category === active);

    const runPrompt = (p: Prompt) => {
        // Open the chat dock if it isn't already, then send the prompt.
        // ChatWidget listens for `titan:chat:prompt` and treats it as a
        // user-typed message.
        window.dispatchEvent(new CustomEvent('titan:chat:toggle', { detail: { open: true } }));
        // Give the dock a tick to mount / resolve the expanded state
        // before the ChatWidget's listener attaches (matters on first open).
        setTimeout(() => {
            window.dispatchEvent(new CustomEvent('titan:chat:prompt', { detail: { text: p.prompt } }));
        }, 120);
        onClose();
    };

    return (
        <div
            className="fixed inset-0 z-[2147483150] flex items-center justify-center p-4"
            style={{ background: 'rgba(0, 0, 0, 0.66)', backdropFilter: 'blur(4px)' }}
            onClick={onClose}
        >
            <div
                className="w-full max-w-3xl rounded-2xl border border-[#27272a] bg-[#0c0c10] shadow-2xl flex flex-col"
                style={{ height: 'min(620px, 85vh)' }}
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-3 border-b border-[#27272a]">
                    <div className="flex items-center gap-2">
                        <Sparkles className="w-4 h-4 text-[#a78bfa]" />
                        <h3 className="font-semibold text-white text-sm">Widget gallery</h3>
                        <span className="text-[10px] text-[#71717a]">Pick a prompt — TITAN will build it on this space.</span>
                    </div>
                    <button
                        onClick={onClose}
                        className="p-1 rounded text-[#71717a] hover:bg-[#18181b] hover:text-white transition-colors"
                        title="Close (Esc)"
                    >
                        <X className="w-4 h-4" />
                    </button>
                </div>

                {/* Category filter */}
                <div className="flex items-center gap-1.5 px-5 py-2 border-b border-[#27272a] text-[11px] overflow-x-auto">
                    {(['All', 'Productivity', 'Data', 'System', 'Fun'] as const).map(cat => (
                        <button
                            key={cat}
                            onClick={() => setActive(cat)}
                            className={`px-2.5 py-1 rounded-full border transition-colors whitespace-nowrap ${
                                active === cat
                                    ? 'border-[#6366f1] bg-[#6366f1]/15 text-white'
                                    : 'border-[#27272a] bg-transparent text-[#a1a1aa] hover:border-[#3f3f46] hover:text-white'
                            }`}
                        >
                            {cat}
                            {cat !== 'All' && (
                                <span className="ml-1.5 text-[9px] opacity-70">
                                    {PROMPTS.filter(p => p.category === cat).length}
                                </span>
                            )}
                        </button>
                    ))}
                </div>

                {/* Prompt grid */}
                <div className="flex-1 overflow-auto p-4">
                    <div className="grid grid-cols-2 gap-3">
                        {filtered.map(p => (
                            <button
                                key={p.title}
                                onClick={() => runPrompt(p)}
                                className="text-left p-3 rounded-lg border border-[#27272a] bg-[#18181b]/60 hover:border-[#6366f1]/50 hover:bg-[#18181b] transition-colors group"
                            >
                                <div className="flex items-center justify-between gap-2 mb-1">
                                    <div className="flex items-center gap-2 min-w-0">
                                        <span
                                            className="w-1.5 h-1.5 rounded-full shrink-0"
                                            style={{ background: CATEGORY_COLOR[p.category] }}
                                        />
                                        <span className="text-[12px] font-medium text-white truncate">{p.title}</span>
                                    </div>
                                    <Send className="w-3 h-3 text-[#52525b] group-hover:text-[#a5b4fc] transition-colors shrink-0" />
                                </div>
                                <div className="text-[11px] text-[#a1a1aa] leading-relaxed line-clamp-2">
                                    {p.blurb}
                                </div>
                                <div className="text-[9px] text-[#52525b] mt-1.5 uppercase tracking-wider">
                                    {p.category}
                                </div>
                            </button>
                        ))}
                    </div>
                    <div className="mt-4 p-3 rounded-lg border border-dashed border-[#27272a] bg-[#0a0a0e] flex items-start gap-2">
                        <LayoutGrid className="w-3.5 h-3.5 text-[#71717a] mt-0.5 shrink-0" />
                        <div className="text-[11px] text-[#a1a1aa] leading-relaxed">
                            Don&rsquo;t see what you want? Open the chat (click the mascot) and describe
                            your widget in plain English. TITAN can build anything that runs inside a
                            sandboxed iframe with access to <span className="font-mono text-[#d4d4d8]">titan.fetch</span>,{' '}
                            <span className="font-mono text-[#d4d4d8]">titan.api.call</span>, and{' '}
                            <span className="font-mono text-[#d4d4d8]">titan.state</span>.
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
