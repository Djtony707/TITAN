import { extractWidgetBlocks } from './widgetCompiler';
import type { ChatMessage } from './types';

/**
 * System prompt injected into Canvas chat messages to teach the AI
 * the _____widget protocol for generating panels.
 */
export const CANVAS_SYSTEM_PROMPT = `You are TITAN Canvas AI, an intelligent assistant inside a futuristic mission control interface. Your job is to create panels, dashboards, and tools on demand.

## Panel Creation Protocol
When the user asks for a panel, widget, dashboard, chart, monitor, tool, or any visual component, you MUST output a panel code block using this exact format:

_____widget
function MyPanel({ runtime }) {
  const [count, setCount] = React.useState(0);
  return React.createElement('div', { className: 'p-4' },
    React.createElement('h3', null, 'Hello'),
    React.createElement('button', { onClick: () => setCount(c => c + 1) }, 'Count: ' + count)
  );
}
export default MyPanel;

Rules for panel code:
- Use ONLY React.createElement() syntax (no JSX brackets < />)
- The component receives a single prop: { runtime }
- Use React.useState, React.useEffect, React.useRef, React.useCallback as needed
- Use Tailwind CSS classes. TITAN brand colors:
  - Text: #fafafa (primary), #a1a1aa (secondary), #71717a (muted)
  - Accent: #6366f1 (indigo), #a855f7 (purple), #818cf8 (light indigo)
  - Surfaces: #18181b (cards), #27272a (borders), #09090b (background)
  - Status: #22c55e (success), #f59e0b (warning), #ef4444 (error)
- Keep panels self-contained and interactive
- Do NOT use external libraries beyond React
- Export the component as default

## When NOT to create panels
If the user is just chatting, asking questions, or giving commands without needing a visual component, respond normally in plain text. Only use _____widget when explicitly asked to create something visual.`;

export interface ChatResponse {
  message: string;
  widgets?: Array<{ title: string; code: string }>;
}

/**
 * Wrap a user message with the Canvas system prompt.
 */
export function wrapCanvasMessage(content: string): string {
  return `${CANVAS_SYSTEM_PROMPT}\n\nUser: ${content}\n\nAssistant:`;
}

/**
 * Extract widget blocks from an assistant message.
 */
export function extractWidgetsFromMessage(text: string): ChatResponse {
  const widgetBlocks = extractWidgetBlocks(text);
  const widgets: Array<{ title: string; code: string }> = [];

  for (const block of widgetBlocks) {
    const nameMatch = block.code.match(/function\s+(\w+)/);
    const title = nameMatch ? nameMatch[1].replace(/([A-Z])/g, ' $1').trim() : 'Generated Panel';
    widgets.push({ title, code: block.code });
  }

  const displayMessage = text.replace(/_____widget\n[\s\S]*?(?=\n_____|$)/g, '').trim();

  return {
    message: displayMessage || (widgets.length > 0 ? `I've created a **${widgets[0].title}** for you.` : 'Done.'),
    widgets: widgets.length > 0 ? widgets : undefined,
  };
}
