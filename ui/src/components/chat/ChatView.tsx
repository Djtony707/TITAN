import { useState, useEffect, useRef, useCallback } from 'react';
import {
  MessageSquarePlus, PanelLeftClose, PanelLeft, Trash2, Pencil, Check, X,
  Menu, PanelRightClose, ChevronDown, Sparkles, Zap, Mic, Command,
} from 'lucide-react';
import { useSSE } from '@/hooks/useSSE';
import { useWebSocket } from '@/hooks/useWebSocket';
import {
  getSessions, getSessionMessages, deleteSession, renameSession,
  getAgents, abortSession, createSession,
} from '@/api/client';
import { isInternalChannel } from '@/components/admin/SessionsTab';
import type { ChatMessage, Session, AgentInfo, AgentEvent } from '@/api/types';
import { useConfig } from '@/hooks/useConfig';
import { MessageBubble } from './MessageBubble';
import { StreamingMessage } from './StreamingMessage';
import { ToolInvocationTimeline } from './ToolInvocationTimeline';
import { ChatInput } from './ChatInput';
import { QuickActions } from './QuickActions';
import { ChatErrorBanner } from './ChatErrorBanner';
import { AgentWatcher } from '../agent-watcher/AgentWatcher';
import { HelpBadge } from '@/components/shared';

function filterUserSessions<T extends { channel?: string }>(sessions: readonly T[]): T[] {
  return sessions.filter((s): boolean => !s.channel || !isInternalChannel(s.channel));
}

function timeAgo(ts?: string): string {
  if (!ts) return '';
  const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

interface ChatViewProps {
  onVoiceOpen?: () => void;
  onToggleActivity?: () => void;
  activityCollapsed?: boolean;
}

function ChatView({ onVoiceOpen, onToggleActivity, activityCollapsed }: ChatViewProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | undefined>();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [agentDropdownOpen, setAgentDropdownOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [watcherOpen, setWatcherOpen] = useState(false);
  const { isStreaming, streamingContent, activeTools, agentEvents, toolInvocations, lastError, send, cancel, clearError } = useSSE();
  const { voiceAvailable, config } = useConfig();
  const [toolCount, setToolCount] = useState<number | null>(null);
  const [providerCount, setProviderCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { apiFetch } = await import('@/api/client');
        const [toolsRes, modelsRes] = await Promise.all([
          apiFetch('/api/tools').then(r => r.ok ? r.json() : null).catch(() => null),
          apiFetch('/api/models').then(r => r.ok ? r.json() : null).catch(() => null),
        ]);
        if (cancelled) return;
        if (toolsRes && Array.isArray(toolsRes.tools)) setToolCount(toolsRes.tools.length);
        else if (toolsRes && typeof toolsRes.count === 'number') setToolCount(toolsRes.count);
        if (modelsRes && typeof modelsRes === 'object') {
          setProviderCount(Object.keys(modelsRes).filter(k => Array.isArray((modelsRes as Record<string, unknown>)[k])).length);
        }
      } catch { /* fall through */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const activeModel = config?.agent?.model?.split('/').pop() ?? 'loading…';

  const [initiativeActive, setInitiativeActive] = useState(false);
  const [initiativeContent, setInitiativeContent] = useState('');
  const [initiativeTools, setInitiativeTools] = useState<string[]>([]);
  const [initiativeEvents, setInitiativeEvents] = useState<AgentEvent[]>([]);

  useWebSocket({
    onMessage: useCallback((data: unknown) => {
      const msg = data as Record<string, unknown>;
      if (msg.type === 'system_message' && msg.source === 'initiative') {
        const content = msg.content as string;
        const now = Date.now();
        const makeEvent = (partial: Partial<AgentEvent>): AgentEvent => ({
          id: String(now), type: 'thinking', timestamp: now, ...partial,
        });

        if (content.includes('Initiative starting')) {
          setInitiativeActive(true);
          setInitiativeContent('Starting autonomous work...');
          setInitiativeTools([]);
          setInitiativeEvents([makeEvent({ type: 'thinking' })]);
        } else if (content.startsWith('🔧')) {
          const toolName = content.match(/\*\*(\w+)\*\*/)?.[1] || 'tool';
          const argsText = content.replace(/🔧\s*\*\*\w+\*\*:\s*/, '');
          setInitiativeTools((prev) => [...prev, toolName]);
          setInitiativeEvents((prev) => [
            ...prev,
            makeEvent({ type: 'tool_start', toolName, args: { path: argsText } }),
          ]);
          setInitiativeContent(`Using ${toolName}...`);
        } else if (content.startsWith('✅') || content.startsWith('❌')) {
          const toolName = content.match(/\*\*(\w+)\*\*/)?.[1] || 'tool';
          const success = content.startsWith('✅');
          const durationMs = parseInt(content.match(/\((\d+)ms\)/)?.[1] || '0');
          setInitiativeTools((prev) => prev.filter((t) => t !== toolName));
          setInitiativeEvents((prev) => [
            ...prev,
            makeEvent({ type: 'tool_end', toolName, status: success ? 'success' : 'error', durationMs }),
          ]);
        } else if (content.startsWith('🔄')) {
          const match = content.match(/Round (\d+)\/(\d+)/);
          if (match) {
            setInitiativeEvents((prev) => [
              ...prev,
              makeEvent({ type: 'round', round: parseInt(match[1]), maxRounds: parseInt(match[2]) }),
            ]);
          }
        } else if (content.includes('Subtask completed') || content.includes('No progress')) {
          setInitiativeActive(false);
          setMessages((prev) => [
            ...prev,
            {
              id: `sys-${Date.now()}`,
              role: 'assistant' as const,
              content: `*[TITAN Autonomous]* ${content}`,
              timestamp: (msg.timestamp as string) || new Date().toISOString(),
            } as ChatMessage,
          ]);
          setInitiativeEvents([]);
          setInitiativeTools([]);
          setInitiativeContent('');
        } else {
          setInitiativeContent(content);
        }
      }
    }, []),
  });

  useEffect(() => {
    getSessions()
      .then((data) => {
        const filtered = filterUserSessions(data);
        setSessions(filtered);
        if (filtered.length > 0) {
          const latest = filtered[0];
          setCurrentSessionId(latest.id);
          return getSessionMessages(latest.id);
        }
        return null;
      })
      .then((msgs) => {
        if (msgs) setMessages(msgs);
      })
      .catch(console.error);
  }, []);

  useEffect(() => {
    const loadAgents = async () => {
      try {
        const data = await getAgents();
        setAgents(data.agents.filter((a) => a.status === 'running'));
      } catch { /* non-critical */ }
    };
    loadAgents();
    const interval = setInterval(loadAgents, 30000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const refreshSessions = async () => {
      try {
        const updated = filterUserSessions(await getSessions());
        setSessions(updated);
      } catch { /* non-critical */ }
    };
    const interval = setInterval(refreshSessions, 10000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streamingContent]);

  const loadSession = useCallback(async (sessionId: string) => {
    setCurrentSessionId(sessionId);
    setMobileSidebarOpen(false);
    try {
      const msgs = await getSessionMessages(sessionId);
      setMessages(msgs);
    } catch (e) {
      console.error('Failed to load session:', e);
    }
  }, []);

  const handleNewChat = useCallback(async () => {
    try {
      const { id } = await createSession();
      setCurrentSessionId(id);
    } catch {
      setCurrentSessionId(undefined);
    }
    setMessages([]);
    setMobileSidebarOpen(false);
    setSidebarOpen(false);
    getSessions().then(d => setSessions(filterUserSessions(d))).catch(() => {});
  }, []);

  useEffect(() => {
    const handler = () => handleNewChat();
    window.addEventListener('titan:new-chat', handler);
    return () => window.removeEventListener('titan:new-chat', handler);
  }, [handleNewChat]);

  const handleDeleteSession = useCallback(
    async (e: React.MouseEvent, sessionId: string) => {
      e.stopPropagation();
      try {
        await deleteSession(sessionId);
        setSessions((prev) => prev.filter((s) => s.id !== sessionId));
        if (currentSessionId === sessionId) {
          setCurrentSessionId(undefined);
          setMessages([]);
        }
      } catch (err) {
        console.error('Failed to delete session:', err);
      }
    },
    [currentSessionId],
  );

  const handleStartRename = useCallback((e: React.MouseEvent, session: Session) => {
    e.stopPropagation();
    setRenamingId(session.id);
    setRenameValue(session.name || session.lastMessage || '');
  }, []);

  const handleConfirmRename = useCallback(async (sessionId: string) => {
    const trimmed = renameValue.trim();
    if (trimmed) {
      try {
        await renameSession(sessionId, trimmed);
        setSessions((prev) => prev.map((s) => s.id === sessionId ? { ...s, name: trimmed } : s));
      } catch (err) {
        console.error('Failed to rename session:', err);
      }
    }
    setRenamingId(null);
  }, [renameValue]);

  const handleCancelRename = useCallback(() => {
    setRenamingId(null);
  }, []);

  const handleSend = useCallback(
    async (content: string) => {
      clearError();
      const userMessage: ChatMessage = {
        role: 'user',
        content,
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, userMessage]);

      try {
        const assistantMessage = await send(content, currentSessionId, selectedAgent ? { agentId: selectedAgent } : undefined);
        if (assistantMessage) {
          setMessages((prev) => [...prev, assistantMessage]);
          try {
            const updated = filterUserSessions(await getSessions());
            setSessions(updated);
            if (!currentSessionId && updated.length > 0) {
              setCurrentSessionId(updated[0].id);
            }
          } catch { /* non-critical */ }
        }
      } catch { /* Error surfaced via lastError */ }
    },
    [currentSessionId, send, selectedAgent, clearError],
  );

  const handleVoiceClick = useCallback(() => {
    onVoiceOpen?.();
  }, [onVoiceOpen]);

  const selectedAgentName = selectedAgent
    ? agents.find(a => a.id === selectedAgent)?.name ?? 'Agent'
    : 'Default';

  // Session sidebar
  const sidebarContent = (
    <div className="flex flex-col h-full bg-bg-secondary border-r border-border overflow-hidden">
      <div className="flex items-center justify-between p-3 border-b border-border">
        <h2 className="text-xs font-semibold text-text-muted uppercase tracking-wider">Conversations</h2>
        <button
          onClick={handleNewChat}
          className="p-1.5 text-text-muted hover:text-text hover:bg-bg-tertiary rounded-lg transition-colors"
          title="New chat"
        >
          <MessageSquarePlus className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
        {sessions.map((session) => (
          <div
            key={session.id}
            role="button"
            tabIndex={0}
            onClick={() => renamingId !== session.id && loadSession(session.id)}
            onKeyDown={(e) => { if (e.key === 'Enter' && renamingId !== session.id) loadSession(session.id); }}
            className={`w-full text-left px-3 py-2.5 rounded-xl text-sm transition-all group flex flex-col gap-0.5 cursor-pointer ${
              session.id === currentSessionId
                ? 'bg-bg-tertiary border border-accent/20 text-text shadow-sm'
                : 'text-text-secondary hover:bg-bg-tertiary/50 hover:text-text border border-transparent'
            }`}
          >
            {renamingId === session.id ? (
              <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                <input
                  autoFocus
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleConfirmRename(session.id);
                    if (e.key === 'Escape') handleCancelRename();
                  }}
                  className="flex-1 min-w-0 bg-bg-secondary text-text text-xs px-2 py-1 rounded border border-accent/50 outline-none"
                />
                <button onClick={() => handleConfirmRename(session.id)} className="p-1 text-success hover:text-success/80 shrink-0">
                  <Check className="w-3 h-3" />
                </button>
                <button onClick={handleCancelRename} className="p-1 text-text-muted hover:text-text shrink-0">
                  <X className="w-3 h-3" />
                </button>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium text-[13px]">
                    {session.name || session.lastMessage?.slice(0, 40) || 'New chat'}
                  </span>
                  <span className="text-[10px] text-text-muted shrink-0">{timeAgo(session.lastActive || session.createdAt)}</span>
                </div>
                {session.lastMessage && !session.name && (
                  <span className="truncate text-[11px] text-text-muted">{session.lastMessage}</span>
                )}
                <div className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 transition-opacity">
                  <button onClick={(e) => handleStartRename(e, session)} className="p-0.5 hover:text-accent transition-colors">
                    <Pencil className="w-3 h-3" />
                  </button>
                  <button onClick={(e) => handleDeleteSession(e, session.id)} className="p-0.5 hover:text-error transition-colors">
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              </>
            )}
          </div>
        ))}

        {sessions.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
            <MessageSquarePlus className="w-8 h-8 text-text-muted mb-2" />
            <p className="text-text-muted text-xs">No conversations yet</p>
            <button onClick={handleNewChat} className="mt-2 text-accent-light text-xs hover:underline">Start a new chat</button>
          </div>
        )}
      </div>
    </div>
  );

  // Empty state
  const emptyState = (
    <div className="flex flex-col items-center justify-center w-full max-w-md mx-auto py-8">
      <div className="relative mb-5">
        <div className="absolute inset-0 bg-accent/20 blur-xl rounded-full" />
        <img src="/titan-logo.png" alt="TITAN" className="relative w-12 h-12 rounded-2xl ring-1 ring-border shadow-lg" />
      </div>
      <h2 className="text-xl font-bold text-text mb-2">How can I help?</h2>
      <p className="text-xs text-text-muted mb-8">
        {toolCount !== null ? `${toolCount} tools` : '…'}
        {' · '}
        {providerCount !== null ? `${providerCount} providers` : '…'}
        {' · '}
        {activeModel}
      </p>
      <QuickActions onSelectAction={handleSend} onVoiceOpen={onVoiceOpen} visible={true} />
    </div>
  );

  return (
    <div className="flex h-full overflow-hidden bg-bg">
      {/* Desktop session sidebar */}
      {sidebarOpen && (
        <div className="hidden md:block w-72 shrink-0 border-r border-border overflow-hidden">
          {sidebarContent}
        </div>
      )}

      {/* Mobile session sidebar */}
      {mobileSidebarOpen && (
        <div className="md:hidden fixed inset-0 z-50 flex">
          <div className="w-72 shrink-0 bg-bg-secondary border-r border-border overflow-hidden">
            {sidebarContent}
          </div>
          <div className="flex-1 bg-black/50" onClick={() => setMobileSidebarOpen(false)} />
        </div>
      )}

      {/* Main content */}
      <div className="flex-1 flex min-w-0 flex-col md:flex-row">
        {/* Chat area */}
        <div className="flex-1 flex flex-col min-w-0" style={{ width: watcherOpen ? (typeof window !== 'undefined' && window.innerWidth < 768 ? '100%' : '60%') : '100%', transition: 'width 300ms ease' }}>

          {/* Top bar */}
          <div className="flex items-center gap-2 px-3 py-2 shrink-0 border-b border-border/50">
            {/* Mobile hamburger */}
            <button
              onClick={() => setMobileSidebarOpen(true)}
              className="md:hidden flex items-center justify-center w-8 h-8 text-text-muted hover:text-text rounded-lg hover:bg-bg-secondary transition-colors shrink-0"
              title="Sessions"
            >
              <Menu className="w-4 h-4" />
            </button>

            {/* Desktop sidebar toggle */}
            <button
              onClick={() => setSidebarOpen((prev) => !prev)}
              className="hidden md:flex items-center justify-center w-8 h-8 text-text-muted hover:text-text rounded-lg hover:bg-bg-secondary transition-colors shrink-0"
              title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
            >
              {sidebarOpen ? <PanelLeftClose className="w-4 h-4" /> : <PanelLeft className="w-4 h-4" />}
            </button>

            {/* Model badge */}
            <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-bg-secondary border border-border text-[11px] text-text-secondary shrink-0">
              <Zap className="w-3 h-3 text-accent-light" />
              {activeModel}
            </div>

            <div className="flex-1" />

            {/* Agent dropdown */}
            {agents.length > 1 && (
              <div className="relative">
                <button
                  onClick={() => setAgentDropdownOpen(!agentDropdownOpen)}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-bg-secondary border border-border text-[11px] text-text-secondary hover:text-text hover:border-border-light transition-colors shrink-0"
                >
                  <Sparkles className="w-3 h-3 text-accent-light" />
                  <span className="hidden sm:inline">{selectedAgentName}</span>
                  <ChevronDown className="w-3 h-3" />
                </button>
                {agentDropdownOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setAgentDropdownOpen(false)} />
                    <div className="absolute right-0 top-full mt-1 w-44 rounded-xl border border-border bg-bg-secondary shadow-xl z-50 py-1">
                      <button
                        onClick={() => { setSelectedAgent(null); setAgentDropdownOpen(false); }}
                        className={`w-full text-left px-3 py-2 text-xs transition-colors ${!selectedAgent ? 'bg-accent/10 text-accent-light' : 'text-text-secondary hover:bg-bg-tertiary'}`}
                      >
                        Default
                      </button>
                      {agents.filter(a => a.id !== 'default').map(agent => (
                        <button
                          key={agent.id}
                          onClick={() => { setSelectedAgent(agent.id); setAgentDropdownOpen(false); }}
                          className={`w-full text-left px-3 py-2 text-xs transition-colors ${selectedAgent === agent.id ? 'bg-accent/10 text-accent-light' : 'text-text-secondary hover:bg-bg-tertiary'}`}
                        >
                          {agent.name}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}

            {/* Watcher toggle */}
            <button
              onClick={() => setWatcherOpen(!watcherOpen)}
              className={`flex items-center justify-center w-8 h-8 rounded-lg transition-colors shrink-0 ${
                watcherOpen ? 'bg-accent/10 text-accent-light' : 'text-text-muted hover:text-text hover:bg-bg-secondary'
              }`}
              title={watcherOpen ? 'Hide agent watcher' : 'Show agent watcher'}
            >
              <Command className="w-4 h-4" />
            </button>

            {/* New chat */}
            <button
              onClick={handleNewChat}
              className="flex items-center justify-center w-8 h-8 text-text-muted hover:text-text rounded-lg hover:bg-bg-secondary transition-colors shrink-0"
              title="New chat"
            >
              <MessageSquarePlus className="w-4 h-4" />
            </button>
          </div>

          {/* Messages area */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto">
            {messages.length === 0 && !isStreaming ? (
              <div className="px-4 py-4 md:py-8">{emptyState}</div>
            ) : (
              <div className="max-w-3xl mx-auto px-3 md:px-4 py-4 md:py-6">
                {messages.map((msg, i) => {
                  const msgDate = msg.timestamp ? new Date(msg.timestamp).toDateString() : null;
                  const prevDate = i > 0 && messages[i - 1].timestamp
                    ? new Date(messages[i - 1].timestamp!).toDateString()
                    : null;
                  const showSeparator = msgDate && msgDate !== prevDate;
                  const separatorLabel = msgDate
                    ? new Date(msg.timestamp!).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })
                    : null;
                  return (
                    <div key={`${msg.timestamp}-${i}`}>
                      {showSeparator && (
                        <div className="flex items-center gap-3 my-5">
                          <div className="flex-1 h-px bg-border" />
                          <span className="text-[10px] font-medium text-text-muted uppercase tracking-wider whitespace-nowrap">
                            {separatorLabel}
                          </span>
                          <div className="flex-1 h-px bg-border" />
                        </div>
                      )}
                      <MessageBubble message={msg} />
                    </div>
                  );
                })}
                {isStreaming && (
                  <StreamingMessage content={streamingContent} activeTools={activeTools} agentEvents={agentEvents} toolInvocations={toolInvocations} />
                )}

                {/* Initiative streaming */}
                {initiativeActive && !isStreaming && (
                  <StreamingMessage content={initiativeContent} activeTools={initiativeTools} agentEvents={initiativeEvents} toolInvocations={[]} />
                )}

                {/* Plan approval */}
                {!isStreaming && messages.length > 0 && messages[messages.length - 1].pendingApproval && (
                  <div className="flex items-center gap-3 mt-4 mb-2 ml-11">
                    <button
                      onClick={() => handleSend('yes')}
                      className="px-5 py-2 rounded-xl bg-success hover:bg-success/90 text-text text-sm font-medium transition-colors"
                    >
                      Approve
                    </button>
                    <button
                      onClick={() => handleSend('no')}
                      className="px-5 py-2 rounded-xl bg-bg-tertiary hover:bg-border text-text-secondary text-sm font-medium transition-colors border border-border"
                    >
                      Cancel
                    </button>
                    <span className="text-xs text-text-muted flex items-center gap-1">
                      TITAN is waiting for approval.
                      <HelpBadge title="Plan Approval" description="When TITAN wants to run multiple tools autonomously, it shows you the plan first. Approve to let it proceed, or cancel to stop." />
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Error banner */}
          {lastError && (
            <ChatErrorBanner
              errorCode={lastError.code}
              errorMessage={lastError.message}
              onRetry={() => {
                const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
                if (lastUserMsg) handleSend(lastUserMsg.content);
              }}
              onDismiss={clearError}
            />
          )}

          {/* Input */}
          <ChatInput
            onSend={handleSend}
            onStop={() => {
              cancel();
              if (currentSessionId) abortSession(currentSessionId).catch(() => {});
            }}
            disabled={isStreaming}
            voiceAvailable={voiceAvailable}
            onVoiceClick={handleVoiceClick}
          />
        </div>

        {/* Agent Watcher panel */}
        {watcherOpen && (
          <div className="border-l border-border md:border-l md:w-[40%]" style={{ width: '100%', minWidth: '100%', transition: 'width 300ms ease' }}>
            <div className="flex justify-end p-2 md:hidden">
              <button onClick={() => setWatcherOpen(false)} className="p-1.5 text-text-muted hover:text-text rounded-lg hover:bg-bg-secondary">
                <X size={18} />
              </button>
            </div>
            <AgentWatcher events={agentEvents} onClose={() => setWatcherOpen(false)} />
          </div>
        )}
      </div>
    </div>
  );
}

export default ChatView;
