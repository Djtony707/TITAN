import { useState } from 'react';
import {
  Wrench, CheckCircle, XCircle, Loader, ChevronDown, ChevronUp,
  Terminal, Globe, FileText, Search, Brain, Code, Mail, Database,
  Image, Music, Video, FolderOpen, Edit3, Plus, Trash2, Zap,
  Clock, AlertCircle,
} from 'lucide-react';
import type { ToolInvocation } from '@/api/types';

interface ToolInvocationTimelineProps {
  invocations: ToolInvocation[];
  maxPreview?: number;
}

const TOOL_ICONS: Record<string, React.ElementType> = {
  shell: Terminal,
  web_search: Search,
  web_fetch: Globe,
  web_browser: Globe,
  browser: Globe,
  read_file: FileText,
  write_file: FileText,
  edit_file: Edit3,
  append_file: Plus,
  list_dir: FolderOpen,
  memory: Database,
  weather: Zap,
  spawn_agent: Brain,
  agent_delegate: Brain,
  agent_team: Brain,
  agent_chain: Brain,
  code_exec: Code,
  execute_code: Code,
  email: Mail,
  image: Image,
  audio: Music,
  video: Video,
  delete_file: Trash2,
  tool_search: Search,
  tool_expand: Search,
  computer_use: Terminal,
};

const TOOL_LABELS: Record<string, string> = {
  shell: 'Shell command',
  web_search: 'Web search',
  web_fetch: 'Fetch page',
  web_browser: 'Browse web',
  browser: 'Browser',
  read_file: 'Read file',
  write_file: 'Write file',
  edit_file: 'Edit file',
  append_file: 'Append to file',
  list_dir: 'List directory',
  memory: 'Access memory',
  weather: 'Check weather',
  spawn_agent: 'Spawn agent',
  agent_delegate: 'Delegate task',
  agent_team: 'Team task',
  agent_chain: 'Chain task',
  code_exec: 'Execute code',
  execute_code: 'Run code',
  email: 'Send email',
  image: 'Process image',
  audio: 'Process audio',
  video: 'Process video',
  delete_file: 'Delete file',
  tool_search: 'Find tools',
  tool_expand: 'Expand tool',
  computer_use: 'Computer use',
  fb_post: 'Facebook post',
  x_post: 'X post',
  social_post: 'Social post',
  auto_generate_skill: 'Generate skill',
  graph_search: 'Search graph',
  graph_add: 'Add to graph',
  vector_search: 'Vector search',
  vector_add: 'Add vector',
  approval_request: 'Request approval',
  checkout_task: 'Checkout task',
  create_goal: 'Create goal',
  create_issue: 'Create issue',
};

function getToolIcon(name: string): React.ElementType {
  return TOOL_ICONS[name] || Wrench;
}

function getToolLabel(name: string): string {
  return TOOL_LABELS[name] || name.replace(/_/g, ' ');
}

function formatDuration(ms?: number): string {
  if (!ms) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatArgs(args?: Record<string, unknown>): string | null {
  if (!args || Object.keys(args).length === 0) return null;
  const priority = args.path || args.file_path || args.directory || args.url || args.query || args.command || args.content || args.message;
  if (typeof priority === 'string') {
    const trimmed = priority.length > 80 ? priority.slice(0, 77) + '…' : priority;
    return trimmed;
  }
  return null;
}

function ToolCard({ invocation }: { invocation: ToolInvocation }) {
  const [expanded, setExpanded] = useState(false);
  const Icon = getToolIcon(invocation.toolName);
  const isRunning = invocation.status === 'running';
  const isSuccess = invocation.status === 'success';
  const isError = invocation.status === 'error';

  const argSummary = formatArgs(invocation.args);

  return (
    <div
      className={`rounded-lg border overflow-hidden transition-all ${
        isRunning
          ? 'border-cyan/30 bg-cyan/5'
          : isError
          ? 'border-error/30 bg-error/5'
          : 'border-border bg-bg-secondary/50'
      }`}
    >
      {/* Header row */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-bg-tertiary/30 transition-colors"
      >
        {isRunning ? (
          <Loader size={13} className="text-cyan animate-spin shrink-0" />
        ) : isError ? (
          <XCircle size={13} className="text-error shrink-0" />
        ) : (
          <CheckCircle size={13} className="text-success shrink-0" />
        )}

        <Icon size={13} className={`shrink-0 ${isRunning ? 'text-cyan' : 'text-text-muted'}`} />

        <span className={`text-xs font-medium truncate ${isRunning ? 'text-cyan' : 'text-text-secondary'}`}>
          {getToolLabel(invocation.toolName)}
        </span>

        {argSummary && !expanded && (
          <span className="text-[10px] text-text-muted font-mono truncate max-w-[200px] hidden sm:inline">
            {argSummary}
          </span>
        )}

        <div className="flex-1" />

        {invocation.durationMs != null && (
          <span className="text-[10px] text-text-muted flex items-center gap-0.5 shrink-0">
            <Clock size={10} />
            {formatDuration(invocation.durationMs)}
          </span>
        )}

        {expanded ? (
          <ChevronUp size={12} className="text-text-muted shrink-0" />
        ) : (
          <ChevronDown size={12} className="text-text-muted shrink-0" />
        )}
      </button>

      {/* Expanded details */}
      {expanded && (
        <div className="px-3 pb-2.5 space-y-2 border-t border-border/50">
          {/* Arguments */}
          {invocation.args && Object.keys(invocation.args).length > 0 && (
            <div className="pt-2">
              <p className="text-[10px] font-medium uppercase tracking-wider text-text-muted mb-1">Arguments</p>
              <pre className="text-[11px] font-mono text-text-secondary bg-bg/60 rounded-md p-2 overflow-x-auto border border-border/50">
                {JSON.stringify(invocation.args, null, 2)}
              </pre>
            </div>
          )}

          {/* Result */}
          {invocation.result && (
            <div>
              <p className="text-[10px] font-medium uppercase tracking-wider text-text-muted mb-1">
                {isError ? 'Error' : 'Result'}
              </p>
              <pre className={`text-[11px] font-mono rounded-md p-2 overflow-x-auto border border-border/50 max-h-48 overflow-y-auto ${
                isError ? 'text-error bg-error/5' : 'text-text-secondary bg-bg/60'
              }`}>
                {invocation.result.length > 2000
                  ? invocation.result.slice(0, 2000) + '\n\n… [truncated]'
                  : invocation.result}
              </pre>
            </div>
          )}

          {/* Inline diff preview */}
          {invocation.diff && (
            <div>
              <p className="text-[10px] font-medium uppercase tracking-wider text-text-muted mb-1">Diff</p>
              <pre className="text-[11px] font-mono text-text-secondary bg-bg/60 rounded-md p-2 overflow-x-auto border border-border/50 max-h-64 overflow-y-auto">
                {invocation.diff}
              </pre>
            </div>
          )}

          {/* Running state */}
          {isRunning && (
            <div className="flex items-center gap-1.5 text-cyan text-[11px]">
              <Loader size={11} className="animate-spin" />
              Executing…
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ToolInvocationTimeline({ invocations, maxPreview = 6 }: ToolInvocationTimelineProps) {
  const [showAll, setShowAll] = useState(false);
  if (!invocations || invocations.length === 0) return null;

  const hasMore = invocations.length > maxPreview;
  const visible = showAll ? invocations : invocations.slice(0, maxPreview);
  const runningCount = invocations.filter((t) => t.status === 'running').length;

  return (
    <div className="space-y-1.5 mb-2">
      {/* Header */}
      <div className="flex items-center gap-2 px-1">
        {runningCount > 0 ? (
          <Loader size={11} className="text-cyan animate-spin" />
        ) : (
          <Zap size={11} className="text-accent-light" />
        )}
        <span className="text-[10px] font-medium text-text-muted uppercase tracking-wider">
          {runningCount > 0
            ? `${runningCount} running · ${invocations.length} total`
            : `${invocations.length} tool call${invocations.length > 1 ? 's' : ''}`}
        </span>
      </div>

      {/* Cards */}
      <div className="space-y-1">
        {visible.map((inv, i) => (
          <ToolCard key={`${inv.toolName}-${inv.startedAt}-${i}`} invocation={inv} />
        ))}
      </div>

      {/* Show more */}
      {hasMore && (
        <button
          onClick={() => setShowAll(!showAll)}
          className="w-full text-center text-[10px] text-text-muted hover:text-text-secondary py-1 transition-colors"
        >
          {showAll ? 'Show less' : `+ ${invocations.length - maxPreview} more`}
        </button>
      )}
    </div>
  );
}
