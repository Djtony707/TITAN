/**
 * Titan 3.0 Agent Execution Protocol
 * Parses LLM output for execution gates: _____javascript, _____react, _____tool
 */

import type {
  AgentCanvasAction,
  AgentGate,
  ExecutionBlock,
  AgentMessage,
  ExecutionResult,
  WidgetDef,
} from '../types';

const GATES: AgentGate[] = ['_____javascript', '_____react', '_____tool', '_____widget', '_____framework', '_____transient'];

function findLineStart(content: string, index: number): number {
  let start = index;
  while (start > 0 && content[start - 1] !== '\n' && content[start - 1] !== '\r') start--;
  return start;
}

function findLineEnd(content: string, index: number): number {
  let end = index;
  while (end < content.length && content[end] !== '\n' && content[end] !== '\r') end++;
  return end;
}

function isGateOnOwnLine(content: string, gateIndex: number, gate: string): boolean {
  const lineStart = findLineStart(content, gateIndex);
  const lineEnd = findLineEnd(content, gateIndex + gate.length);
  return !content.slice(lineStart, gateIndex).trim() && !content.slice(gateIndex + gate.length, lineEnd).trim();
}

function stripTrailingUnderscores(code: string): string {
  // Some models emit stray _____ or _______ lines after code blocks
  return code.replace(/\n_+\s*$/g, '').trimEnd();
}

function parseWidgetPayload(code: string): Partial<WidgetDef> | null {
  const trimmed = code.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed) as Partial<WidgetDef>;
    } catch {
      return null;
    }
  }
  return {
    format: 'react',
    source: trimmed,
  };
}

export function blockToAction(block: ExecutionBlock): AgentCanvasAction | undefined {
  if (block.gate === '_____react') {
    return {
      type: 'render_widget',
      widget: {
        format: 'react',
        source: block.code.trim(),
      },
    };
  }

  if (block.gate === '_____javascript') {
    return {
      type: 'run_javascript',
      code: block.code,
    };
  }

  if (block.gate === '_____tool') {
    try {
      return {
        type: 'tool_request',
        payload: JSON.parse(block.code),
      };
    } catch {
      return undefined;
    }
  }

  if (block.gate === '_____widget') {
    const widget = parseWidgetPayload(block.code);
    if (typeof widget?.source !== 'string' || !widget.source.trim()) return undefined;
    if (typeof widget.id === 'string' && widget.id.trim()) {
      const { id, ...patch } = widget;
      return {
        type: 'update_widget',
        widgetId: id,
        patch,
      };
    }
    return {
      type: 'render_widget',
      widget: {
        ...widget,
        source: widget.source,
      },
    };
  }

  return undefined;
}

export function extractExecutionBlocks(content: string): ExecutionBlock[] {
  const blocks: ExecutionBlock[] = [];
  let searchIndex = 0;

  while (searchIndex < content.length) {
    let earliestGate: AgentGate | null = null;
    let earliestIndex = -1;

    for (const gate of GATES) {
      const idx = content.indexOf(gate, searchIndex);
      if (idx !== -1 && (earliestIndex === -1 || idx < earliestIndex)) {
        if (isGateOnOwnLine(content, idx, gate)) {
          earliestIndex = idx;
          earliestGate = gate;
        }
      }
    }

    if (!earliestGate || earliestIndex === -1) break;

    // Skip framework and transient gates — they are not executable
    if (earliestGate === '_____framework' || earliestGate === '_____transient') {
      searchIndex = earliestIndex + earliestGate.length;
      continue;
    }

    const lineStart = findLineStart(content, earliestIndex);
    const lineEnd = findLineEnd(content, earliestIndex + earliestGate.length);
    let codeStart = lineEnd;
    if (content.startsWith('\r\n', codeStart)) codeStart += 2;
    else if (content[codeStart] === '\n' || content[codeStart] === '\r') codeStart += 1;

    // Find the next gate or end of content
    let nextGateIndex = content.length;
    for (const gate of GATES) {
      const idx = content.indexOf(gate, codeStart);
      if (idx !== -1 && idx < nextGateIndex && isGateOnOwnLine(content, idx, gate)) {
        nextGateIndex = idx;
      }
    }

    let code = content.slice(codeStart, nextGateIndex).trimEnd();
    code = stripTrailingUnderscores(code);

    const block: ExecutionBlock = {
      gate: earliestGate,
      code,
      leadingText: content.slice(searchIndex, lineStart).trim(),
    };
    block.action = blockToAction(block);
    blocks.push(block);

    searchIndex = nextGateIndex;
  }

  // If no gates found, the whole content is leading text (terminal response)
  if (blocks.length === 0 && content.trim()) {
    blocks.push({ gate: '_____transient', code: '', leadingText: content.trim() });
  }

  return blocks;
}

export function hasExecutionGate(content: string): boolean {
  return extractExecutionBlocks(content).some(b => b.gate !== '_____transient');
}

export function formatExecutionResults(results: ExecutionResult[]): string {
  return results.map((r: ExecutionResult) => {
    const lines: string[] = [];
    lines.push(`execution ${r.status}`);
    r.logs.forEach(l => lines.push(`${l.level}: ${l.text}`));
    if (r.result !== undefined && r.result !== null) {
      lines.push(`result: ${r.resultText}`);
    }
    if (r.error) {
      lines.push(`error: ${r.error.text}`);
    }
    return lines.join('\n');
  }).join('\n\n');
}

export function buildFrameworkMessage(results: ExecutionResult[]): AgentMessage {
  return {
    role: 'framework',
    content: formatExecutionResults(results),
    timestamp: Date.now(),
    executions: results,
  };
}

export function countGates(content: string, gate: AgentGate): number {
  let count = 0;
  let idx = 0;
  while ((idx = content.indexOf(gate, idx)) !== -1) {
    if (isGateOnOwnLine(content, idx, gate)) count++;
    idx += gate.length;
  }
  return count;
}

export function validateExecutionContent(content: string): { valid: boolean; error?: string } {
  const gateCounts = GATES.filter(g => g !== '_____framework' && g !== '_____transient').map(g => ({
    gate: g,
    count: countGates(content, g),
  }));

  const multiGate = gateCounts.find(g => g.count > 1);
  if (multiGate) {
    return {
      valid: false,
      error: `Execution messages may contain ${multiGate.gate} at most once, and it must appear on its own line.`,
    };
  }

  // We intentionally do NOT scan the entire content for inline gate strings.
  // After extractExecutionBlocks runs, each block is a single gate + its code.
  // Widget code frequently mentions gate names inside strings/comments (e.g.
  // a tutorial widget showing "_____javascript"). Scanning the code body
  // causes false-positive rejections.

  return { valid: true };
}
