import { useState, useEffect, useRef, useCallback } from 'react';
import { MessageSquarePlus, PanelLeftClose, PanelLeft, Trash2, Pencil, Check, X, Eye, EyeOff } from 'lucide-react';
import { useSSE } from '@/hooks/useSSE';
import { useWebSocket } from '@/hooks/useWebSocket';
import { getSessions, getSessionMessages, deleteSession, renameSession, getAgents, abortSession, createSession } from '@/api/client';
import type { ChatMessage, Session, AgentInfo, AgentEvent } from '@/api/types';
import { useConfig } from '@/hooks/useConfig';
import { MessageBubble } from './MessageBubble';
import { StreamingMessage } from './StreamingMessage';
import { ChatInput } from './ChatInput';
import { QuickActions } from './QuickActions';
import { AgentWatcher } from '../agent-watcher/AgentWatcher';

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
  const scrollRef = useRef<HTMLDivElement>(null);
  const [watcherOpen, setWatcherOpen] = useState(false);
  const { isStreaming, streamingContent, activeTools, agentEvents, send, cancel } = useSSE();
  const { voiceAvailable } = useConfig();

  // Initiative streaming state — shows live thinking/tool activity
  const [initiativeActive, setInitiativeActive] = useState(false);
  const [initiativeContent, setInitiativeContent] = useState('');
  const [initiativeTools, setInitiativeTools] = useState<string[]>([]);
  const [initiativeEvents, setInitiativeEvents] = useState<AgentEvent[]>([]);

  // Listen for daemon/initiative system messages via WebSocket
  useWebSocket({
    onMessage: useCallback((data: unknown) => {
      const msg = data as Record<string, unknown>;
      if (msg.type === 'system_message' && msg.source === 'initiative') {
        const content = msg.content as string;

        const now = Date.now();
        const makeEvent = (partial: Partial<AgentEvent>): AgentEvent => ({
          id: String(now), type: 'thinking', timestamp: now, ...partial,
        });

        // Initiative start — show streaming bubble
        if (content.includes('Initiative starting')) {
          setInitiativeActive(true);
          setInitiativeContent('');
          setInitiativeTools([]);
          setInitiativeEvents([makeEvent({ type: 'thinking' })]);
        }
        // Tool call — add to streaming events
        else if (content.startsWith('🔧')) {
          const toolName = content.match(/\*\*(\w+)\*\*/)?.[1] || 'tool';
          const argsText = content.replace(/🔧\s*\*\*\w+\*\*:\s*/, '');
          setInitiativeTools((prev) => [...prev, toolName]);
          setInitiativeEvents((prev) => [
            ...prev,
            makeEvent({ type: 'tool_start', toolName, args: { path: argsText } }),
          ]);
        }
        // Tool result — update events
        else if (content.startsWith('✅') || content.startsWith('❌')) {
          const toolName = content.match(/\*\*(\w+)\*\*/)?.[1] || 'tool';
          const success = content.startsWith('✅');
          const durationMs = parseInt(content.match(/\((\d+)ms\)/)?.[1] || '0');
          setInitiativeTools((prev) => prev.filter((t) => t !== toolName));
          setInitiativeEvents((prev) => [
            ...prev,
            makeEvent({ type: 'tool_end', toolName, status: success ? 'success' : 'error', durationMs }),
          ]);
        }
        // Round — update events
        else if (content.startsWith('🔄')) {
          const match = content.match(/Round (\d+)\/(\d+)/);
          if (match) {
            setInitiativeEvents((prev) => [
              ...prev,
              makeEvent({ type: 'round', round: parseInt(match[1]), maxRounds: parseInt(match[2]) }),
            ]);
          }
        }
        // Subtask completed — finalize and add to messages
        else if (content.includes('Subtask completed') || content.includes('No progress')) {
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
        }
      }
    }, []),
  });

  useEffect(() => {
    getSessions()
      .then((data) => {
        setSessions(data);
        if (data.length > 0) {
          const latest = data[0];
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
      } catch {
        /* non-critical */
      }
    };
    loadAgents();
    const interval = setInterval(loadAgents, 30000);
    return () => clearInterval(interval);
  }, []);

  // Refresh sessions periodically (catches voice chat sessions and external changes)
  useEffect(() => {
    const refreshSessions = async () => {
      try {
        const updated = await getSessions();
        setSessions(updated);
      } catch { /* non-critical */ }
    };
    const interval = setInterval(refreshSessions, 10000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
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
      // Create a new session on the backend so messages go to a fresh session
      const { id } = await createSession();
      setCurrentSessionId(id);
    } catch {
      // Fallback: clear session and let backend create one
      setCurrentSessionId(undefined);
    }
    setMessages([]);
    setMobileSidebarOpen(false);
    setSidebarOpen(false);
    // Refresh session list
    getSessions().then(setSessions).catch(() => {});
  }, []);

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
      const userMessage: ChatMessage = {
        role: 'user',
        content,
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, userMessage]);

      const assistantMessage = await send(content, currentSessionId, selectedAgent ? { agentId: selectedAgent } : undefined);

      if (assistantMessage) {
        setMessages((prev) => [...prev, assistantMessage]);

        try {
          const updated = await getSessions();
          setSessions(updated);
          if (!currentSessionId && updated.length > 0) {
            setCurrentSessionId(updated[0].id);
          }
        } catch {
          // non-critical
        }
      }
    },
    [currentSessionId, send, selectedAgent],
  );

  const handleVoiceClick = useCallback(() => {
    onVoiceOpen?.();
  }, [onVoiceOpen]);

  // Session sidebar
  const sidebarContent = (
    <div className="flex flex-col h-full bg-bg-secondary border-r border-bg-tertiary overflow-hidden">
      <div className="flex items-center justify-between p-3 border-b border-bg-tertiary">
        <button
          onClick={handleNewChat}
          className="flex items-center gap-2 px-3 py-2 text-sm text-text bg-bg-tertiary hover:bg-border rounded-lg transition-colors w-full"
        >
          <MessageSquarePlus className="w-4 h-4" />
          New chat
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
        {sessions.length > 0 && (
          <p className="px-3 pt-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-text-muted">Recent</p>
        )}
        {sessions.map((session) => (
          <div
            key={session.id}
            role="button"
            tabIndex={0}
            onClick={() => renamingId !== session.id && loadSession(session.id)}
            onKeyDown={(e) => { if (e.key === 'Enter' && renamingId !== session.id) loadSession(session.id); }}
            className={`w-full text-left px-3 py-2.5 rounded-lg text-sm transition-colors group flex items-center justify-between gap-2 cursor-pointer ${
              session.id === currentSessionId
                ? 'bg-bg-tertiary text-text'
                : 'text-text-secondary hover:bg-bg-secondary hover:text-text'
            }`}
          >
            {renamingId === session.id ? (
              <div className="flex items-center gap-1 flex-1 min-w-0" onClick={(e) => e.stopPropagation()}>
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
                <button onClick={() => handleConfirmRename(session.id)} className="p-1 text-green-400 hover:text-green-300 shrink-0">
                  <Check className="w-3 h-3" />
                </button>
                <button onClick={handleCancelRename} className="p-1 text-text-muted hover:text-text shrink-0">
                  <X className="w-3 h-3" />
                </button>
              </div>
            ) : (
              <>
                <span className="truncate flex-1">
                  {session.name || session.lastMessage?.slice(0, 40) || 'Untitled'}
                </span>
                <div className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 shrink-0 transition-all">
                  <button
                    onClick={(e) => handleStartRename(e, session)}
                    className="p-1 hover:text-accent transition-colors"
                    aria-label="Rename session"
                  >
                    <Pencil className="w-3 h-3" />
                  </button>
                  <button
                    onClick={(e) => handleDeleteSession(e, session.id)}
                    className="p-1 hover:text-red-400 transition-colors"
                    aria-label="Delete session"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </>
            )}
          </div>
        ))}

        {sessions.length === 0 && (
          <p className="text-text-muted text-xs text-center mt-8 px-2">No conversations yet</p>
        )}
      </div>
    </div>
  );

  // Empty state — centered prompt with TITAN branding
  const emptyState = (
    <div className="flex flex-col items-center justify-center w-full max-w-lg mx-auto">
      {/* Clean minimal greeting */}
      <div className="mb-4">
        <img src="/titan-logo.png" alt="TITAN" className="w-10 h-10 rounded-xl ring-1 ring-white/10 mx-auto mb-3" />
      </div>
      <h2 className="text-lg font-semibold text-text mb-1">How can I help?</h2>
      <p className="text-xs text-text-muted mb-6">209 tools · 36 providers · gemma4:31b</p>

      {/* Quick action grid */}
      <QuickActions onSelectAction={handleSend} onVoiceOpen={onVoiceOpen} visible={true} />


    </div>
  );

  return (
    <div className="flex h-full overflow-hidden bg-bg">
      {/* Session sidebar — slides in from left */}
      {sidebarOpen && (
        <div className="w-64 shrink-0 border-r border-border/50 overflow-hidden">
          {sidebarContent}
        </div>
      )}

      {/* Main content */}
      <div className="flex-1 flex min-w-0 flex-col md:flex-row">
        {/* Chat area */}
        <div className="flex-1 flex flex-col min-w-0" style={{ width: watcherOpen ? (typeof window !== 'undefined' && window.innerWidth < 768 ? '100%' : '60%') : '100%', transition: 'width 300ms ease' }}>
        {/* Top bar with session tabs */}
        <div className="flex items-center gap-1.5 px-3 py-1.5 shrink-0 border-b border-border/50 overflow-x-auto">
          {/* New chat button */}
          <button
            onClick={handleNewChat}
            className="flex items-center gap-1 px-2 py-1 text-xs text-text-muted hover:text-text rounded-md hover:bg-bg-secondary transition-colors shrink-0"
            title="New chat"
          >
            <MessageSquarePlus className="w-3.5 h-3.5" />
          </button>

          {/* Session pills */}
          {sessions.slice(0, 8).map((session) => (
            <button
              key={session.id}
              onClick={() => loadSession(session.id)}
              className={`flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md transition-colors shrink-0 max-w-[140px] ${
                session.id === currentSessionId
                  ? 'bg-accent/15 text-accent border border-accent/20'
                  : 'text-text-muted hover:text-text-secondary hover:bg-white/[0.04]'
              }`}
              title={session.name || session.lastMessage || session.id}
            >
              <span className="truncate">{session.name || session.lastMessage?.slice(0, 20) || 'Chat'}</span>
            </button>
          ))}

          <div className="flex-1" />

          {/* Toggle sidebar for full session list */}
          <button
            onClick={() => setSidebarOpen((prev) => !prev)}
            className="flex items-center gap-1 px-2 py-1 text-xs text-text-muted hover:text-text rounded-md hover:bg-bg-secondary transition-colors shrink-0"
            title={sidebarOpen ? 'Hide sessions' : 'All sessions'}
          >
            {sidebarOpen ? <PanelLeftClose className="w-3.5 h-3.5" /> : <PanelLeft className="w-3.5 h-3.5" />}
          </button>
        </div>

        {/* Agent selector */}
        {agents.length > 1 && (
          <div className="flex items-center gap-2 px-4 py-2 border-b border-bg-tertiary shrink-0 overflow-x-auto">
            <span className="text-xs text-text-muted shrink-0">Agent:</span>
            <button
              onClick={() => setSelectedAgent(null)}
              className={`px-3 py-1 rounded-full text-xs transition-colors shrink-0 ${
                !selectedAgent ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary hover:bg-border'
              }`}
            >
              Default
            </button>
            {agents
              .filter((a) => a.id !== 'default')
              .map((agent) => (
                <button
                  key={agent.id}
                  onClick={() => setSelectedAgent(agent.id)}
                  className={`px-3 py-1 rounded-full text-xs transition-colors shrink-0 ${
                    selectedAgent === agent.id
                      ? 'bg-accent text-white'
                      : 'bg-bg-tertiary text-text-secondary hover:bg-border'
                  }`}
                >
                  {agent.name}
                </button>
              ))}
          </div>
        )}

        {/* Messages area */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto">
          {messages.length === 0 && !isStreaming ? (
            <div className="px-4 py-4 md:py-6">{emptyState}</div>
          ) : (
            <div className="max-w-3xl mx-auto px-3 md:px-4 py-4 md:py-6">
              {messages.map((msg, i) => {
                const msgDate = msg.timestamp ? new Date(msg.timestamp).toDateString() : null;
                const prevDate = i > 0 && messages[i - 1].timestamp
                  ? new Date(messages[i - 1].timestamp!).toDateString()
                  : null;
                const showSeparator = msgDate && msgDate !== prevDate;
                const separatorLabel = msgDate
                  ? new Date(msg.timestamp!).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
                  : null;
                return (
                  <div key={`${msg.timestamp}-${i}`}>
                    {showSeparator && (
                      <div className="flex items-center gap-2 md:gap-3 my-3 md:my-4">
                        <div className="flex-1 h-px bg-bg-tertiary" />
                        <span className="text-[9px] md:text-[10px] font-medium text-text-muted uppercase tracking-wider whitespace-nowrap px-1">
                          {separatorLabel}
                        </span>
                        <div className="flex-1 h-px bg-bg-tertiary" />
                      </div>
                    )}
                    <MessageBubble message={msg} />
                  </div>
                );
              })}
              {isStreaming && (
                <StreamingMessage content={streamingContent} activeTools={activeTools} agentEvents={agentEvents} />
              )}

              {/* Initiative autonomous work — live streaming like Claude Code */}
              {initiativeActive && !isStreaming && (
                <StreamingMessage content={initiativeContent} activeTools={initiativeTools} agentEvents={initiativeEvents} />
              )}

              {/* Plan approval buttons — shown when the last message is a plan waiting for approve/deny */}
              {!isStreaming && messages.length > 0 && messages[messages.length - 1].pendingApproval && (
                <div className="flex items-center gap-3 mt-4 mb-2 ml-11">
                  <button
                    onClick={() => handleSend('yes')}
                    className="px-5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium transition-colors"
                  >
                    Approve Plan
                  </button>
                  <button
                    onClick={() => handleSend('no')}
                    className="px-5 py-2 rounded-lg bg-bg-tertiary hover:bg-border text-text-secondary text-sm font-medium transition-colors"
                  >
                    Cancel
                  </button>
                  <span className="text-xs text-text-muted">TITAN is waiting for your approval before executing.</span>
                </div>
              )}
            </div>
          )}
        </div>

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
      </div>{/* end chat column */}

      {/* Agent Watcher panel — hidden on mobile by default, full width when open */}
      {watcherOpen && (
        <div className="border-l border-border md:border-l md:w-[40%]" style={{ width: '100%', minWidth: '100%', transition: 'width 300ms ease' }}>
          <div className="flex justify-end p-2 md:hidden">
            <button
              onClick={() => setWatcherOpen(false)}
              className="p-1.5 text-text-muted hover:text-text rounded-lg hover:bg-bg-secondary"
            >
              <X size={18} />
            </button>
          </div>
          <AgentWatcher events={agentEvents} onClose={() => setWatcherOpen(false)} />
        </div>
      )}
      </div>{/* end split view */}
    </div>
  );
}

export default ChatView;
