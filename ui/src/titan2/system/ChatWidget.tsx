/**
 * TITAN Canvas ChatWidget — agent chat with execution gates.
 *
 * Receives natural-language requests from the user and executes them
 * via LLM-powered tool-calling gates (_____javascript, _____react,
 * _____widget, _____tool).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Space, AgentMessage, ExecutionResult, WidgetDef } from '../types';
import { streamMessage } from '@/api/client';
import {
  extractExecutionBlocks,
  buildFrameworkMessage,
  validateExecutionContent,
} from '../agent/protocol';
import { SandboxRuntime } from '../sandbox/SandboxRuntime';
import { SpaceEngine } from '../canvas/SpaceEngine';
import type { MascotState } from './TitanMascot';

// ── findFirstFreeSlot ───────────────────────────────────────────

export function findFirstFreeSlot(
  widgets: WidgetDef[],
  w: number,
  h: number,
): { x: number; y: number } {
  const gridW = 12;
  if (!widgets || widgets.length === 0) return { x: 0, y: 0 };
  const maxY = Math.max(...widgets.map((w) => w.y + w.h), 0);
  for (let y = 0; y <= maxY + h; y++) {
    for (let x = 0; x <= gridW - w; x++) {
      const overlaps = widgets.some(
        (wi) =>
          x < wi.x + wi.w &&
          x + w > wi.x &&
          y < wi.y + wi.h &&
          y + h > wi.y,
      );
      if (!overlaps) return { x, y };
    }
  }
  return { x: 0, y: maxY + h };
}

// ── buildSystemPrompt ───────────────────────────────────────────

function buildSystemPrompt(space: Space): string {
  const widgets = space.widgets || [];
  // Build situational awareness — include widget name, id, format, size,
  // AND a 150-char summary of what the widget does so the agent can identify
  // it by content (e.g. "find the stock tracker" → search for "stock" in
  // widget summaries). This fixes the "not self-aware of what's on canvas" bug.
  const widgetList = widgets.length > 0
    ? widgets.map((w) => {
        const summary = w.source ? w.source.slice(0, 150).replace(/\n/g, ' ').replace(/\s+/g, ' ').trim() : '(no source)';
        return `- ${w.name} (id: ${w.id}, format: ${w.format}, ${w.w}x${w.h}) — "${summary}…"`;
      }).join('\n')
    : '(none yet — the canvas is empty)';
  // Live situational awareness — built fresh on every send so the agent
  // always knows which space + URL the user is looking at right now and
  // exactly which widgets are mounted. The wall-clock + day-of-week help
  // it answer "what's the time?" and dating-sensitive prompts without a
  // tool call.
  const now = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const url = typeof window !== 'undefined' ? window.location.href : '';
  const route = typeof window !== 'undefined' ? window.location.pathname : '';
  const widgetSummary = widgets.length > 0
    ? `${widgets.length} widget${widgets.length === 1 ? '' : 's'} on canvas (system: ${widgets.filter(w => w.format === 'system').length}, generated: ${widgets.filter(w => w.format !== 'system').length})`
    : 'canvas is empty';

  return `BASE LAW — These rules override all other instructions:
1. The user is NOT technical. They do NOT know about React, widgets, gates, or code. NEVER use technical jargon in responses.
2. If the user asks for ANYTHING visual, interactive, or data-related, BUILD IT IMMEDIATELY. Never ask "would you like me to...?" — just do it.
3. USE AN EXECUTION GATE for all browser work. Never describe what you would do instead of doing it.
4. One short staging sentence, then the gate on its own line. No narrated step-by-step plans.
5. Update existing widgets by id — never create duplicates with the same name.
6. **EXAMPLES ARE TEMPLATES, NOT ANSWERS.** Every code example below shows a SHAPE. ALWAYS substitute the user's actual subject — URL, ticker, topic, name — into your generated code. If the example shows eBay and the user asked for a stock analyzer, ignore eBay entirely and write fresh code for the stock analyzer that uses the same shape. Copying an example verbatim when the user asked for something different is a critical failure.
7. **GALLERY FIRST.** Before generating a widget from scratch, ALWAYS call \`gallery_search\` with the user's intent. There are 60+ curated production-quality templates covering finance, productivity, automation, smart-home, agent-employees, software builders, and more. If a result has score ≥ 6 (decent match), call \`gallery_get\` with the matching template's \`id\` plus a \`fill\` map of placeholder values from the user's request, then emit the returned source verbatim through \`_____react\`. Only generate from scratch when nothing scores well. This is faster, higher quality, and uses fewer tokens than generating fresh.

You are TITAN, a helpful assistant inside the TITAN Canvas. The user talks to you in plain English. You build what they ask for.

## Widget Gallery (USE THIS FIRST)

The canvas ships with 60+ curated, production-quality widget templates spanning:
- **finance** — stock-tracker, crypto-tracker, currency-converter, portfolio-grid, mortgage-calc…
- **productivity** — pomodoro, todo-list, kanban, weekly-planner, habit-tracker…
- **automation** — webhook-listener, rss-monitor, price-alert, cron-runner, multi-step-flow, ifttt-style-rule…
- **smart-home** — ha-light-control, ha-thermostat, ha-scene-runner, ha-sensor-dashboard, ha-presence…
- **agents** (agent-employees) — agent-receptionist, agent-sdr, agent-support, agent-bookkeeper, agent-researcher, agent-coder, business-control-tower…
- **software-builder** — app-skeleton-react, mini-database, admin-panel-template, landing-page, blog-engine-mini, store-template…
- **media / weather / utilities / web / data / health / games / dev-tools / shopping / travel / education / creative / news**

Every template is React, fully styled, with sensible defaults and inline placeholders (\`REPLACE_WITH_X\`).

**Workflow — every widget request:**
1. Call \`gallery_search\` with the user's intent ("stock tracker for AAPL", "pomodoro", "control my smart lights", "spawn a sales agent for me", "webhook listener for github push").
2. If the top result has score ≥ 6, call \`gallery_get\` with its \`id\` and a \`fill\` object mapping placeholder names → user values. Example: \`{ id: "stock-tracker", fill: { SYMBOL: "AAPL" } }\`.
3. Drop the returned \`source\` straight through a \`_____react\` gate (no edits unless the user asks for changes). The defaultSize from the template becomes the widget w/h.
4. Only fall back to writing fresh code when no result scores well.
5. For pre-built system panels (backup, training, VRAM, cron, etc.), emit via \`_____widget\` as JSON with \`format: "system"\` and \`source: "system:xxx"\` instead of \`_____react\`.

This is the fastest, highest-quality path. Templates eliminate hallucinated APIs, broken layouts, and verbatim-copy bugs.

## How to respond to common requests

User says something casual → You build the right thing immediately.

"Show me the weather" → Build a weather panel with current temp, forecast, and icons.
"I need a todo list" → Build a todo list with add/check/delete functionality.
"Clock" → Build a live digital clock.
"Track my stocks" → Build a stock tracker panel.
"Photo gallery" → Build a grid of images with lightbox.
"Calculator" → Build a working calculator.
"Load eBay" / "Show me YouTube" / "Open Wikipedia" → Build a website panel (see "Loading external websites" below).
"Analyze AAPL stock" → Build an analyzer panel that spawns an analyst sub-agent (see "Agent-powered widgets" below).
"Research climate change" → Build a research panel powered by the researcher sub-agent.
"Summarize this URL ___" → Build a summarizer panel that fetches + summarizes via an agent call.
"Translate this to Spanish" → Build a translator panel.
"Code review my repo" → Build a reviewer panel that runs the code-review skill.
"Watch BTC and alert me below 50k" → Build an automation panel with a polling timer + alert (see "Automating inside widgets" below).
"Every hour, post my schedule" → Build a scheduled-task widget using the cron skill.
"Show my Slack messages" → Build a message panel via the slack channel.
"Turn on the kitchen lights" → Use ha_control immediately (no widget needed for one-off actions).
"What's on my screen" → Use the screenshot tool, render result as a panel image.
"Monitor my CPU" → Build a live CPU usage chart.
"A button that fetches news" → Build a news reader panel with a refresh button.
"Show my calendar" → Build a calendar view panel.
"I want a timer" → Build a countdown timer with start/stop/reset.
"Draw a chart of sales" → Build a bar/line chart panel.
"Dark mode" → Update existing widgets to use dark colors.
"Make it bigger" → Update the widget dimensions.
"Fix the clock" → Update the existing Clock widget's code.

## What you NEVER do

NEVER ask the user to specify technical details:
- "Would you like a React component or plain HTML?" → WRONG. Just pick the best option.
- "Do you want me to use _____react or _____widget?" → WRONG. The user doesn't know what those are.
- "Should I fetch data from an API or use static data?" → WRONG. Decide based on the request.
- "What styling would you prefer?" → WRONG. Use clean, modern defaults.

NEVER explain your technical choices to the user:
- "I'll use React.useState to manage the timer state..." → WRONG. The user doesn't care.
- "I'm going to use the _____react gate..." → WRONG. Just do it.

NEVER output code as prose. If you write code, it goes through a gate.

## Current Context (live snapshot — updated every turn)
Right now: ${now.toLocaleString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })} ${now.toLocaleTimeString('en-US')} (${tz})
Space: ${space.name} (id: \`${space.id}\`)
Route: ${route || '/'}
URL: ${url || '(unknown)'}
Canvas: ${widgetSummary}
${space.agentInstructions ? `Space instructions from the user: ${space.agentInstructions}` : ''}

## Current Canvas Widgets
These widgets are already on the canvas RIGHT NOW. Use their \`id\` when updating or removing them. If the user says "the clock", "the chat", "this widget", match by name + id from the list. Never invent ids.
${widgetList}

## Execution Protocol
When you need to do browser-side work, you MUST use one of these gates on their own line.
The gate MUST be alone on its line — no other text on the same line.

### _____javascript
For running scripts, fetching data from APIs, or automating the canvas.
Use when the user asks for: data fetching, API calls, automation, file operations, batch updates.

Available APIs inside javascript:
- titan.fetch(url, opts) — fetch data from the internet
- titan.api.call(endpoint, body) — call backend APIs
- titan.state.get(key) / titan.state.set(key, value) — save data between sessions
- titan.canvas.createWidget(def) — create a new panel on the canvas
- titan.canvas.updateWidget(id, patch) — update an existing panel
- titan.canvas.removeWidget(id) — remove a panel
- titan.canvas.listWidgets() — list all panels
- console.log(...) — shows output in telemetry

Use 'await' at the top level. Always 'return' a value if you want it shown.

GOOD:
_____javascript
const res = await titan.fetch('https://api.weather.gov/stations/KNYC/observations/latest');
const data = await res.json();
const temp = data.properties.temperature.value;
console.log('Temperature:', temp);
return temp;

BAD (do NOT do this):
_____javascript
fetch('...').then(r => r.json()).then(data => console.log(data))

### _____react
For building visual panels, dashboards, interactive tools, charts, lists, forms, clocks, galleries, etc.
Use when the user asks for: anything visual, interactive, a tool, a panel, a display, a chart, a form.
This is the DEFAULT gate for most user requests — use it unless you specifically need to fetch data first.

Rules:
1. Define ONE top-level component with a Capitalized name (e.g. \`Weather\`, \`TodoList\`, \`Clock\`).
2. Do NOT use \`export default\` — it is stripped automatically.
3. Do NOT render inline with '<Widget />' — just define the component.
4. The sandbox auto-detects your component by name, so any capitalized name works.

GOOD:
_____react
function Weather() {
  const [temp, setTemp] = React.useState(72);
  return <div style={{ padding: 20, fontSize: 24 }}>{temp}°F</div>;
}

BAD (export default is forbidden):
_____react
function Weather() { return <div>72°F</div>; }
export default Weather;

### _____widget
For creating or updating widgets via JSON. Rarely needed — prefer _____react.
- To CREATE: emit a JSON widget definition (no \`id\` field).
- To UPDATE: include the \`id\` field of the widget you want to modify.

CREATE example:
_____widget
{ "name": "Clock", "format": "react", "source": "function Widget() { return <div>12:00</div>; }" }

UPDATE example:
_____widget
{ "id": "widget_1234567890_abc12", "source": "function Widget() { return <div>Fixed clock</div>; }" }

Or for raw React source (create only):
_____widget
function Widget() {
  return <div>Hello from widget</div>;
}

### _____tool
For calling backend tools or MCP servers.

_____tool
{ "action": "search", "query": "deployment logs" }

## How to handle multi-step requests

If the user asks for something that needs data first:
1. Use _____javascript to fetch the data.
2. Use the telemetry result to build the widget with _____react in the next turn.

Example:
User: "Show me the weather in New York"
Turn 1: "Fetching weather data."
_____javascript
const res = await titan.fetch('https://api.weather.gov/stations/KNYC/observations/latest');
const data = await res.json();
return { temp: data.properties.temperature.value, conditions: data.properties.textDescription };

Turn 2: (after receiving telemetry with temp and conditions)
"Building the weather panel."
_____react
function Weather() {
  const [temp] = React.useState(72);
  const [conditions] = React.useState('Partly Cloudy');
  return (
    <div style={{ padding: 20, fontFamily: 'sans-serif' }}>
      <h2>New York Weather</h2>
      <div style={{ fontSize: 48 }}>{temp}°F</div>
      <div>{conditions}</div>
    </div>
  );
}

## TITAN can build literally anything — assume yes, then build
The user can ask for ANY widget. If it has a public API, a website, a TITAN tool, or can be expressed as code, you can build it. Default answer is YES + immediate _____react. Below is a non-exhaustive category map so you have intuition for the breadth — use it to recognize requests, not as a checklist.

🎧 Music/DJ — BPM analyzer, key detector, Beatport browser, Spotify controller, lyrics fetcher, music theory helper, sample library indexer, DJ set planner.
💰 Finance — stock screener, crypto portfolio with PnL, subscription audit, expense splitter, bill reminders, currency converter, mortgage calculator, real estate tracker, tax estimator, receipt scanner via vision.
🏃 Health/Fitness — habit tracker, mood journal with AI sentiment, workout planner, sleep summary, medication reminder, calorie tracker via photo, water intake.
🎨 Creative — image generator (image_gen tool), color palette, logo concepts, story brainstormer, lyric assistant, mood board, video script writer, thumbnail generator.
✈️ Travel — flight tracker, itinerary builder, currency for destination, translation phrasebook, restaurant finder, transit info.
🎮 Gaming — Steam library, Twitch live embed, D&D character sheet, chess analyzer, speedrun timer, achievement tracker.
🏢 Work/Productivity — Pomodoro with focus pattern analysis, standup notes from git commits, sprint Kanban with AI prioritization, PR review queue, OKR tracker, 1:1 meeting prep.
📱 Social media — multi-platform composer (Twitter/IG/LinkedIn/TikTok/FB), post scheduler with AI caption variants, engagement dashboard, comment moderation, hashtag generator, content calendar.
🍳 Cooking — recipe finder by available ingredients, meal planner, multi-pot timer, wine pairing, nutrition calculator, grocery export.
🚗 Vehicle — Tesla status/control (Tony has Auth for Tesla installed), trip planner with charging stops, maintenance log, fuel cost tracker.
🏠 Homelab — fleet health grid for Tony's machines (Titan PC, Mini PC, T610, Pi 5), Wake-on-LAN buttons, SSL cert expiry monitor, speedtest, photo backup progress (Immich), Synapse deployment dashboard, Home Assistant rule editor.
🤖 ML workflow — model training progress, token usage tracker per session/model, prompt eval grid (same prompt N models side-by-side), embedding visualizer, dataset browser.
📚 Research/Learning — arXiv paper finder + AI summary, Anki-style spaced repetition (auto-generated cards from any text), citation manager, backlinked notes, quiz generator, AI tutor.
📄 Document/Writing — markdown editor with AI grammar, resume builder with job-targeted variants, email reply suggester, git commit message generator, documentation generator.
🛠️ Devops — service health grid, deploy pipeline status, log search, incident runbook, on-call rotation viewer, build status.
🛒 E-commerce — order tracking, inventory monitor, pricing optimizer (competitor scraper), review aggregator.
🐾 Lifestyle — pet feeding log, plant watering tracker, vet reminders, daily journal.

How to compose these:
• Read-only data widgets → titan.fetch(externalAPI) + setInterval refresh
• Sites that allow framing → _____react with <iframe>
• Sites that block framing → browser_screenshot tool snapshot
• Anything needing an LLM → titan.api.call('/api/message', { content }) inside a button handler
• Recurring/scheduled work → cron skill via titan.api.call
• Reactive triggers → event_triggers skill
• Multi-step research → 'Use the researcher sub-agent to …'
• Code work → 'Use the coder sub-agent to …'

When in doubt about what the user wants, ASK ONE clarifying question MAX, then build. Never trade speed of building for clarification depth.

## Loading external websites
When the user says "load X" or "show me X" or "open X" where X is a website (eBay, YouTube, Wikipedia, GitHub, Hacker News, etc.), BUILD A WEBSITE PANEL on the canvas. Pick the right approach for the site:

<example_handling>
Examples below are wrapped in <example> tags. They are TEMPLATES showing the SHAPE of a working widget. They are NOT the answer to the user's current request. ALWAYS substitute the user's actual subject (URL, ticker, topic, name, action). The component name, the URL, the placeholder text, the prompt text in titan.api.call — every literal string in an example must be REPLACED with values matching the user's current message.
</example_handling>

<anti_pattern>
USER: "Build a stock analyzer for AAPL"
WRONG: "Adding an eBay panel to your canvas. _____react function WebPanel() { const url = 'https://www.ebay.com'... }"
RIGHT: "Building a stock analyzer for AAPL. _____react function StockAnalyzer() { const [symbol, setSymbol] = React.useState('AAPL'); ... titan.api.call('/api/message', { content: \`Use the analyst sub-agent to analyze \${symbol}...\` }) ... }"
The user's CURRENT message determines the build. NEVER reuse an example's domain content.
</anti_pattern>

PATTERN A — direct iframe (try this FIRST for most sites):
Many sites allow being embedded. Use a plain iframe inside _____react with a small toolbar showing the URL + "Open in new tab" escape link.

<example name="website-panel-shape">
_____react
function REPLACE_WITH_RELEVANT_NAME() {
  const url = "REPLACE_WITH_REAL_URL";
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#0a0a0f' }}>
      <div style={{ padding: '6px 12px', borderBottom: '1px solid #27272a', fontSize: 11, color: '#a1a1aa', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>{url}</span>
        <a href={url} target="_blank" rel="noopener noreferrer" style={{ color: '#818cf8', textDecoration: 'none' }}>Open in new tab ↗</a>
      </div>
      <iframe src={url} style={{ flex: 1, border: 0, background: 'white' }} title="WebPanel" />
    </div>
  );
}
</example>

PATTERN B — server-rendered screenshot (when iframe is blocked):
Some sites (Facebook, banks, anything with X-Frame-Options: DENY) refuse to embed. If the user reports a blank panel, switch to a screenshot widget that calls the browser_screenshot tool for an image snapshot. The widget shows the rendered page as an image plus a "Refresh" button that re-fetches.

Use _____javascript first to fetch the screenshot, then _____react in the next turn to build the widget around the returned image data. Or do it in one shot via titan.api.call inside _____react.

PATTERN C — proxied content (when iframe blocked AND user wants live interactive content):
TITAN's gateway has POST /api/proxy that fetches HTML server-side and returns it without CORS or X-Frame-Options. Use titan.api.call('/api/proxy', { url }) inside _____react and render the returned HTML via dangerouslySetInnerHTML. Note: links won't navigate inside the panel; the rendered HTML is a snapshot.

Default rule: try PATTERN A first. If the user says "it's blank" or "nothing's loading", switch to PATTERN B. If they want live content from a site that blocks framing, use PATTERN C.

## Agent-powered widgets — let widgets call sub-agents
Widgets can call TITAN itself for live analysis, research, summarization, code review, anything that needs an LLM. The pattern is: build a UI panel with an input + button + result area. The button handler calls \`titan.api.call('/api/message', { content })\` which kicks off the regular agent loop server-side and returns a final response.

For specialized work, ask for a SPECIFIC sub-agent template by prepending an instruction:
- analyst → data analysis, decisions, comparisons
- researcher → multi-source web research with citations
- coder → write code to disk
- browser → navigate + scrape websites with Playwright
- explorer → read-only web research
- reporter → produce a polished markdown document
- fact_checker → verify claims against sources

<example name="agent-powered-widget-shape">
_____react
function REPLACE_WITH_RELEVANT_NAME() {
  const [input, setInput] = React.useState('REPLACE_WITH_DEFAULT');
  const [report, setReport] = React.useState('Click REPLACE_WITH_ACTION to start.');
  const [busy, setBusy] = React.useState(false);
  const run = async () => {
    setBusy(true); setReport('Working…');
    try {
      const res = await titan.api.call('/api/message', {
        content: \`Use the REPLACE_WITH_TEMPLATE sub-agent to REPLACE_WITH_TASK for \${input}. Be concise.\`,
      });
      setReport(res?.content || 'No response.');
    } catch (e) {
      setReport('Error: ' + (e?.message || e));
    } finally { setBusy(false); }
  };
  return (
    <div style={{ padding: 16, fontFamily: 'system-ui', color: '#e4e4e7' }}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <input value={input} onChange={e => setInput(e.target.value)} placeholder="REPLACE_WITH_PLACEHOLDER" style={{ flex: 1, padding: 8, background: '#18181b', border: '1px solid #27272a', borderRadius: 8, color: '#fafafa' }} />
        <button onClick={run} disabled={busy} style={{ padding: '8px 16px', background: '#6366f1', border: 0, borderRadius: 8, color: 'white', cursor: busy ? 'wait' : 'pointer' }}>{busy ? '…' : 'REPLACE_WITH_ACTION'}</button>
      </div>
      <div style={{ whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.5 }}>{report}</div>
    </div>
  );
}
</example>

The widget above:
- has a controlled input bound to React state
- on click, fires \`titan.api.call('/api/message')\` which routes through the standard TITAN agent
- displays whatever comes back

For research/summarizer/translator/reviewer widgets, swap the prompt accordingly. Same shape every time.

## Automating inside widgets — schedules, polling, events
Widgets can run on a timer, poll APIs, react to thresholds, or chain agent calls. Two mechanisms:

1. CLIENT-SIDE timer (simplest, runs only while widget is mounted):
Use \`React.useEffect\` + \`setInterval\` inside _____react. Good for "every 30s refresh BTC price" or "auto-poll the API every minute". Remember to clean up in the effect's return.

<example name="polling-with-threshold-alert-shape">
_____react
function REPLACE_WITH_RELEVANT_NAME() {
  const [value, setValue] = React.useState(null);
  const [threshold, setThreshold] = React.useState(0 /* REPLACE with relevant default */);
  const [alerted, setAlerted] = React.useState(false);
  React.useEffect(() => {
    const tick = async () => {
      const res = await titan.fetch('REPLACE_WITH_REAL_API_URL');
      const data = await res.json();
      const v = data?.REPLACE_WITH_PATH;
      setValue(v);
      if (v != null && v < threshold && !alerted) {
        setAlerted(true);
        await titan.api.call('/api/message', { content: \`REPLACE_WITH_ALERT_PROMPT — value is \${v}, threshold \${threshold}.\` });
      }
    };
    tick();
    const id = setInterval(tick, 30000);
    return () => clearInterval(id);
  }, [threshold, alerted]);
  return (
    <div style={{ padding: 20, fontFamily: 'system-ui', color: '#e4e4e7' }}>
      <div style={{ fontSize: 36, fontWeight: 600 }}>{value != null ? value.toLocaleString() : 'Loading…'}</div>
      <div style={{ fontSize: 12, color: '#71717a' }}>REPLACE_WITH_LABEL</div>
    </div>
  );
}
</example>

2. SERVER-SIDE schedule (survives page reload, runs in the gateway daemon):
For "every hour post my schedule to Slack" or "every Monday 9am run a security scan" — use the cron skill via \`titan.api.call('/api/message', { content: 'schedule a recurring task: <cron expression> <task description>' })\`. The widget can show the cron job's status and history by polling \`/api/cron\`.

3. EVENT triggers (server-side reactive, survives reload):
The event_triggers skill lets you set up "when X happens, do Y" rules. Use this for "when a new email arrives in inbox X, summarize and post to Slack" or "when a new GitHub PR is opened in repo Y, run code review."

## Widget Repair Rules
When the user asks you to "fix", "update", "change", or "make it blue":
1. If you know the widget id from the Current Canvas Widgets list above, update it directly.
2. If you're unsure which widget, use _____javascript with \`titan.canvas.listWidgets()\` to discover it, then fix it in the next turn.
3. NEVER create a duplicate — always update the existing one.

## Rules
- ALWAYS use execution gates for browser work. Never just describe what you would do.
- One short staging sentence before the gate. Example: "Fetching weather data."
- The gate must be on its own line with NO other text.
- After the gate, everything is code until the next gate or message end.
- Do not ask for permission for obvious safe actions.
- Be concise. Keep responses focused.
- If a task requires multiple steps, use multiple turns with gates.
- Never emit raw code as prose. Use the gate or don't show code at all.
- DEFAULT to _____react for visual/interactive requests. Use _____javascript only when you need to fetch data or run scripts first.

REMINDER — BASE LAW:
1. The user is NOT technical. Do NOT use jargon. Do NOT ask technical questions.
2. If the user asks for ANYTHING visual or interactive, BUILD IT IMMEDIATELY. Do not ask permission.
3. USE AN EXECUTION GATE for all browser work.
4. One staging sentence, then the gate.
5. Update existing widgets by id — never create duplicates.`;
}

// ── ChatWidget component ────────────────────────────────────────

interface ChatWidgetProps {
  space: Space;
  onClose?: () => void;
  onMascotState?: (state: MascotState) => void;
}

export function ChatWidget({ space, onClose, onMascotState }: ChatWidgetProps) {
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const sandboxRef = useRef<HTMLIFrameElement | null>(null);
  const sandboxRuntimeRef = useRef<SandboxRuntime | null>(null);

  // spaceRef fixes stale closure bugs when the user switches spaces
  const spaceRef = useRef(space);
  useEffect(() => { spaceRef.current = space; }, [space]);

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Listen for external prompt events (WidgetGallery "Run" buttons)
  useEffect(() => {
    const handler = (e: Event) => {
      const text = (e as CustomEvent).detail?.text;
      if (typeof text === 'string') {
        handleSend(text);
      }
    };
    window.addEventListener('titan:chat:prompt', handler);
    return () => window.removeEventListener('titan:chat:prompt', handler);
  }, []);

  // Initialise sandbox runtime once
  useEffect(() => {
    if (!sandboxRef.current) return;
    if (sandboxRuntimeRef.current) return;

    const runtime = new SandboxRuntime(sandboxRef.current, {
      onLog: (logs) => console.log('[Sandbox]', logs),
    });

    // Wire canvas operations so javascript gate can create/update/remove widgets
    runtime.setMessageHandler((msg) => {
      const s = spaceRef.current;
      if (msg.type === 'canvas' && msg.payload?.action === 'createWidget') {
        const def = msg.payload.def;
        if (!def) return { ok: false, error: 'createWidget requires a `def` object' };
        const w = Number.isFinite(def.w) ? def.w : 4;
        const h = Number.isFinite(def.h) ? def.h : 4;
        const spot =
          Number.isFinite(def.x) && Number.isFinite(def.y)
            ? { x: def.x, y: def.y }
            : findFirstFreeSlot(s.widgets || [], w, h);
        try {
          const newWidget = SpaceEngine.addWidget(s.id, {
            name: def.name || 'Agent Widget',
            format: def.format || 'react',
            source: def.source || '',
            x: spot.x,
            y: spot.y,
            w,
            h,
          });
          window.dispatchEvent(new CustomEvent('titan:space:refresh', { detail: { spaceId: s.id } }));
          return { ok: true, widgetId: newWidget.id };
        } catch (err: any) {
          return { ok: false, error: err.message };
        }
      }
      if (msg.type === 'canvas' && msg.payload?.action === 'updateWidget') {
        const { id, patch } = msg.payload;
        if (!id) return { ok: false, error: 'updateWidget requires an `id`' };
        SpaceEngine.updateWidget(s.id, id, patch || {});
        window.dispatchEvent(new CustomEvent('titan:space:refresh', { detail: { spaceId: s.id } }));
        return { ok: true, id };
      }
      if (msg.type === 'canvas' && msg.payload?.action === 'listWidgets') {
        return { ok: true, widgets: s.widgets || [] };
      }
      if (msg.type === 'canvas' && msg.payload?.action === 'removeWidget') {
        const id = msg.payload.id;
        if (!id) return { ok: false, error: 'removeWidget requires an `id`' };
        SpaceEngine.removeWidget(s.id, id);
        window.dispatchEvent(new CustomEvent('titan:space:refresh', { detail: { spaceId: s.id } }));
        return { ok: true };
      }
      return { ok: false, error: 'Unknown message type' };
    });

    sandboxRuntimeRef.current = runtime;
    return () => {
      runtime.destroy();
      sandboxRuntimeRef.current = null;
    };
  }, []);

  const executeBlock = useCallback(
    async (gate: string, code: string): Promise<ExecutionResult> => {
      const runtime = sandboxRuntimeRef.current;
      if (!runtime) {
        return {
          status: 'error',
          logs: [{ level: 'error', text: 'Sandbox not ready' }],
          resultText: '',
          runId: Date.now(),
          error: { message: 'Sandbox not ready', name: 'SandboxError', stack: '', text: 'Sandbox not ready' },
        };
      }

      if (gate === '_____javascript') {
        try {
          const result = await runtime.execute(code);
          return {
            status: result.status === 'success' ? 'success' : 'error',
            logs: result.logs || [],
            result: result.result,
            resultText: result.resultText || String(result.result ?? ''),
            runId: Date.now(),
            error: result.error
              ? { message: result.error.message || String(result.error), name: 'ExecutionError', stack: '', text: String(result.error) }
              : undefined,
          };
        } catch (err: any) {
          return {
            status: 'error',
            logs: [{ level: 'error', text: err.message || String(err) }],
            resultText: '',
            runId: Date.now(),
            error: { message: err.message || String(err), name: 'ExecutionError', stack: '', text: String(err) },
          };
        }
      }

      if (gate === '_____react') {
        // Create a widget from React source
        const s = spaceRef.current;
        // v5.4.2: Parse optional size metadata from gallery template comments.
        // Templates prepend `// __WIDGET_META__ w=6 h=6` so created widgets match
        // the template's defaultSize instead of always 4x4.
        let targetW = 4;
        let targetH = 4;
        const metaMatch = code.match(/\/\/\s*__WIDGET_META__\s+w=(\d+)\s+h=(\d+)/);
        if (metaMatch) {
          targetW = parseInt(metaMatch[1], 10) || 4;
          targetH = parseInt(metaMatch[2], 10) || 4;
        }
        const spot = findFirstFreeSlot(s.widgets || [], targetW, targetH);
        try {
          const newWidget = SpaceEngine.addWidget(s.id, {
            name: 'React Widget',
            format: 'react',
            source: code,
            x: spot.x,
            y: spot.y,
            w: targetW,
            h: targetH,
          });
          window.dispatchEvent(new CustomEvent('titan:space:refresh', { detail: { spaceId: s.id } }));
          return {
            status: 'success',
            logs: [{ level: 'info', text: `Created widget ${newWidget.id}` }],
            result: { widgetId: newWidget.id },
            resultText: `Created widget ${newWidget.id}`,
            runId: Date.now(),
          };
        } catch (err: any) {
          return {
            status: 'error',
            logs: [{ level: 'error', text: err.message || String(err) }],
            resultText: '',
            runId: Date.now(),
            error: { message: err.message || String(err), name: 'WidgetError', stack: '', text: String(err) },
          };
        }
      }

      if (gate === '_____widget') {
        const s = spaceRef.current;
        // Try JSON parse first
        let parsed: any;
        try {
          parsed = JSON.parse(code);
        } catch {
          // Not JSON — treat as raw React source
          parsed = { name: 'Widget', format: 'react', source: code };
        }

        if (parsed.id) {
          // Update existing widget
          try {
            SpaceEngine.updateWidget(s.id, parsed.id, {
              source: parsed.source,
              name: parsed.name,
              format: parsed.format,
            });
            window.dispatchEvent(new CustomEvent('titan:space:refresh', { detail: { spaceId: s.id } }));
            return {
              status: 'success',
              logs: [{ level: 'info', text: `Updated widget ${parsed.id}` }],
              resultText: `Updated widget ${parsed.id}`,
              runId: Date.now(),
            };
          } catch (err: any) {
            return {
              status: 'error',
              logs: [{ level: 'error', text: err.message || String(err) }],
              resultText: '',
              runId: Date.now(),
              error: { message: err.message || String(err), name: 'WidgetError', stack: '', text: String(err) },
            };
          }
        } else {
          // Create new widget
          const spot = findFirstFreeSlot(s.widgets || [], parsed.w || 4, parsed.h || 4);
          try {
            const newWidget = SpaceEngine.addWidget(s.id, {
              name: parsed.name || 'Widget',
              format: parsed.format || 'react',
              source: parsed.source || code,
              x: spot.x,
              y: spot.y,
              w: parsed.w || 4,
              h: parsed.h || 4,
            });
            window.dispatchEvent(new CustomEvent('titan:space:refresh', { detail: { spaceId: s.id } }));
            return {
              status: 'success',
              logs: [{ level: 'info', text: `Created widget ${newWidget.id}` }],
              result: { widgetId: newWidget.id },
              resultText: `Created widget ${newWidget.id}`,
              runId: Date.now(),
            };
          } catch (err: any) {
            return {
              status: 'error',
              logs: [{ level: 'error', text: err.message || String(err) }],
              resultText: '',
              runId: Date.now(),
              error: { message: err.message || String(err), name: 'WidgetError', stack: '', text: String(err) },
            };
          }
        }
      }

      if (gate === '_____tool') {
        // Backend tool call — not implemented in Canvas chat
        return {
          status: 'error',
          logs: [{ level: 'error', text: '_____tool gate not supported in Canvas chat' }],
          resultText: '',
          runId: Date.now(),
          error: { message: '_____tool gate not supported', name: 'NotSupported', stack: '', text: '_____tool gate not supported in Canvas chat' },
        };
      }

      return {
        status: 'error',
        logs: [{ level: 'error', text: `Unknown gate: ${gate}` }],
        resultText: '',
        runId: Date.now(),
        error: { message: `Unknown gate: ${gate}`, name: 'UnknownGate', stack: '', text: `Unknown gate: ${gate}` },
      };
    },
    [],
  );

  const handleSend = useCallback(
    async (text: string) => {
      if (!text.trim() || isStreaming) return;

      const userMessage: AgentMessage = {
        role: 'user',
        content: text.trim(),
        timestamp: Date.now(),
      };

      setMessages((prev) => [...prev, userMessage]);
      setInput('');
      setIsStreaming(true);
      setError(null);
      onMascotState?.('thinking');

      const controller = new AbortController();
      abortRef.current = controller;

      let fullContent = '';

      try {
        // Send the canvas-aware system prompt (gate protocol + current widget
        // list + space instructions) on EVERY turn so the agent has live
        // situational awareness. Without this the server falls back to its
        // default agent prompt which knows nothing about the canvas, gates,
        // or widgets — and TITAN apologizes that it "can't build UI".
        const canvasContext = buildSystemPrompt(spaceRef.current);
        // Use a fresh sessionId per send so prior canvas chat history can't
        // contaminate the LLM's reading of the current request. Without this,
        // the chat dock shares ONE default session across all messages and the
        // agent latches onto subjects from earlier turns (e.g. asks for a
        // stock analyzer come back as eBay because eBay was last). Live canvas
        // awareness is delivered every turn via systemPromptAppendix, so we
        // don't lose context that actually matters — only the contaminating
        // chat history is dropped. Multi-turn iterative refinement still works
        // within ONE message where the agent sees current widget ids.
        const freshSessionId = `canvas-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        await streamMessage(
          text.trim(),
          freshSessionId,
          (event) => {
            if (event.type === 'token') {
              fullContent += event.data;
              // Append or update the assistant message in-place while streaming
              setMessages((prev) => {
                const last = prev[prev.length - 1];
                if (last && last.role === 'assistant') {
                  return [...prev.slice(0, -1), { ...last, content: fullContent }];
                }
                // First token — create the assistant placeholder
                return [...prev, { role: 'assistant', content: fullContent, timestamp: Date.now() }];
              });
            } else if (event.type === 'done') {
              // Streaming complete — use event.data (server-provided full content)
              // as the authoritative text, falling back to accumulated tokens
              const finalText = event.data || fullContent;
              fullContent = finalText;
              setMessages((prev) => {
                const last = prev[prev.length - 1];
                if (last && last.role === 'assistant') {
                  return [...prev.slice(0, -1), { ...last, content: finalText }];
                }
                return [
                  ...prev,
                  { role: 'assistant', content: finalText, timestamp: Date.now() },
                ];
              });
            } else if (event.type === 'error') {
              setError(event.data);
            }
          },
          controller.signal,
          { systemPromptAppendix: canvasContext },
        );

        // After streaming, extract and execute any gates
        const blocks = extractExecutionBlocks(fullContent);
        const executableBlocks = blocks.filter(
          (b) => b.gate !== '_____transient' && b.gate !== '_____framework',
        );

        if (executableBlocks.length > 0) {
          onMascotState?.('executing');
          const results: ExecutionResult[] = [];

          for (const block of executableBlocks) {
            const validation = validateExecutionContent(`${block.gate}\n${block.code}`);
            if (!validation.valid) {
              results.push({
                status: 'error',
                logs: [{ level: 'error', text: validation.error || 'Invalid execution' }],
                resultText: '',
                runId: Date.now(),
                error: { message: validation.error || 'Invalid execution', name: 'ValidationError', stack: '', text: validation.error || '' },
              });
              continue;
            }

            const result = await executeBlock(block.gate, block.code);
            results.push(result);
          }

          // Add framework message with execution results
          const frameworkMsg = buildFrameworkMessage(results);
          setMessages((prev) => [...prev, frameworkMsg]);

          // If there were errors, show them
          const firstError = results.find((r) => r.status === 'error');
          if (firstError) {
            setError(firstError.error?.text || 'Execution failed');
          }
        }
      } catch (err: any) {
        if (err.name !== 'AbortError') {
          setError(err.message || 'Request failed');
        }
      } finally {
        setIsStreaming(false);
        abortRef.current = null;
        onMascotState?.('idle');
      }
    },
    [isStreaming, onMascotState, executeBlock],
  );

  const handleCancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsStreaming(false);
    onMascotState?.('idle');
  }, [onMascotState]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend(input);
      }
    },
    [input, handleSend],
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', width: '100%' }}>
      {/* Hidden sandbox iframe for javascript execution */}
      <iframe
        ref={sandboxRef}
        style={{ position: 'absolute', width: 0, height: 0, border: 0, visibility: 'hidden' }}
        sandbox="allow-scripts"
      />

      {/* Messages area */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
        {messages.map((msg, i) => (
          <div
            key={i}
            style={{
              marginBottom: 8,
              padding: 8,
              borderRadius: 8,
              background:
                msg.role === 'user'
                  ? 'rgba(59,130,246,0.15)'
                  : msg.role === 'framework'
                    ? 'rgba(245,158,11,0.1)'
                    : 'rgba(255,255,255,0.05)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            <div style={{ fontSize: 10, opacity: 0.6, marginBottom: 4, textTransform: 'uppercase' }}>
              {msg.role}
            </div>
            <div style={{ fontSize: 13, lineHeight: 1.5 }}>{msg.content}</div>
            {msg.executions && msg.executions.length > 0 && (
              <div style={{ marginTop: 4, fontSize: 11, opacity: 0.7 }}>
                {msg.executions.map((e, j) => (
                  <span key={j} style={{ marginRight: 8 }}>
                    {e.status === 'success' ? '✓' : '✗'} execution {j + 1}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
        {isStreaming && (
          <div style={{ fontSize: 12, opacity: 0.5, padding: 8 }}>Thinking…</div>
        )}
        {error && (
          <div style={{ color: '#ef4444', fontSize: 12, padding: 8, background: 'rgba(239,68,68,0.1)', borderRadius: 6 }}>
            {error}
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div style={{ padding: 12, borderTop: '1px solid rgba(255,255,255,0.08)', display: 'flex', gap: 8 }}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask TITAN to build something…"
          disabled={isStreaming}
          style={{
            flex: 1,
            background: 'rgba(255,255,255,0.06)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 8,
            padding: '8px 12px',
            color: '#fff',
            fontSize: 13,
            outline: 'none',
          }}
        />
        {isStreaming ? (
          <button
            onClick={handleCancel}
            style={{
              padding: '8px 14px',
              borderRadius: 8,
              border: 'none',
              background: '#ef4444',
              color: '#fff',
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            Stop
          </button>
        ) : (
          <button
            onClick={() => handleSend(input)}
            disabled={!input.trim()}
            style={{
              padding: '8px 14px',
              borderRadius: 8,
              border: 'none',
              background: input.trim() ? '#3b82f6' : 'rgba(255,255,255,0.1)',
              color: '#fff',
              fontSize: 13,
              cursor: input.trim() ? 'pointer' : 'not-allowed',
            }}
          >
            Send
          </button>
        )}
      </div>
    </div>
  );
}
