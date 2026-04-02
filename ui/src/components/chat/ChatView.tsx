import { useState, useEffect, useRef, useCallback } from 'react';
import { MessageSquarePlus, PanelLeftClose, PanelLeft, Trash2, Pencil, Check, X, Eye, EyeOff } from 'lucide-react';
import { useSSE } from '@/hooks/useSSE';
import { getSessions, getSessionMessages, deleteSession, renameSession, getAgents, abortSession } from '@/api/client';
import type { ChatMessage, Session, AgentInfo } from '@/api/types';
import { useConfig } from '@/hooks/useConfig';
import { MessageBubble } from './MessageBubble';
import { StreamingMessage } from './StreamingMessage';
import { ChatInput } from './ChatInput';
import { QuickActions } from './QuickActions';
import { AgentWatcher } from '../agent-watcher/AgentWatcher';

interface ChatViewProps {
  onVoiceOpen?: () => void;
}

function ChatView({ onVoiceOpen }: ChatViewProps) {
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

  const handleNewChat = useCallback(() => {
    setCurrentSessionId(undefined);
    setMessages([]);
    setMobileSidebarOpen(false);
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
    <div className="flex flex-col h-full bg-bg-secondary border-r border-bg-tertiary">
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
    <div className="flex-1 flex flex-col items-center justify-center px-4 pb-4">
      {/* Logo with ambient glow */}
      <div className="mb-8 relative">
        <div className="absolute -inset-8 rounded-full bg-gradient-to-br from-accent/15 via-purple/10 to-[#06b6d4]/15 blur-2xl animate-pulse" style={{ animationDuration: '4s' }} />
        <div className="absolute -inset-3 rounded-full bg-accent/5 blur-md" />
        <img
          src="/titan-logo.png"
          alt="TITAN"
          className="relative w-20 h-20 rounded-2xl ring-1 ring-white/10 shadow-2xl shadow-black/50"
        />
      </div>

      {/* Title */}
      <h2 className="text-3xl font-bold bg-gradient-to-r from-white via-white to-white/60 bg-clip-text text-transparent mb-3">
        TITAN
      </h2>

      {/* Stats bar */}
      <div className="flex items-center gap-4 mb-8">
        {[
          { value: '209', label: 'Tools' },
          { value: '36', label: 'Providers' },
          { value: '15', label: 'Channels' },
          { value: '117', label: 'Skills' },
        ].map(({ value, label }) => (
          <div key={label} className="flex items-baseline gap-1">
            <span className="text-sm font-semibold text-white/80">{value}</span>
            <span className="text-[11px] text-white/30">{label}</span>
          </div>
        ))}
      </div>

      {/* Quick action grid */}
      <QuickActions onSelectAction={handleSend} onVoiceOpen={onVoiceOpen} visible={true} />

      {/* Subtle tagline */}
      <p className="mt-6 text-[11px] text-white/20 max-w-sm text-center">
        Autonomous AI agent with Command Post governance, self-improvement, mesh networking, and voice cloning
      </p>
    </div>
  );

  return (
    <div className="flex h-full overflow-hidden bg-bg">
      {/* Session drawer overlay */}
      {(sidebarOpen || mobileSidebarOpen) && (
        <div className="fixed inset-0 z-40">
          <div
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            onClick={() => { setSidebarOpen(false); setMobileSidebarOpen(false); }}
          />
          <div className="relative w-72 h-full z-50 animate-slide-in">{sidebarContent}</div>
        </div>
      )}

      {/* Main content — split view when watcher is open */}
      <div className="flex-1 flex min-w-0">
        {/* Chat area */}
        <div className="flex-1 flex flex-col min-w-0" style={{ width: watcherOpen ? '60%' : '100%', transition: 'width 300ms ease' }}>
        {/* Top bar — minimal */}
        <div className="flex items-center gap-2 px-3 py-2 shrink-0">
          <button
            onClick={() => setSidebarOpen((prev) => !prev)}
            className="p-2 text-text-muted hover:text-text-secondary rounded-lg hover:bg-bg-secondary transition-colors"
            aria-label="Toggle sessions"
          >
            {sidebarOpen ? (
              <PanelLeftClose className="w-5 h-5" />
            ) : (
              <PanelLeft className="w-5 h-5" />
            )}
          </button>
          <div className="flex-1" />
          <button
            onClick={() => setWatcherOpen((prev) => !prev)}
            className="p-2 text-text-muted hover:text-text-secondary rounded-lg hover:bg-bg-secondary transition-colors"
            aria-label="Toggle agent watcher"
            title={watcherOpen ? 'Hide Agent Watcher' : 'Show Agent Watcher'}
          >
            {watcherOpen ? (
              <EyeOff className="w-5 h-5" />
            ) : (
              <Eye className="w-5 h-5" />
            )}
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
            emptyState
          ) : (
            <div className="max-w-3xl mx-auto px-4 py-6">
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
                      <div className="flex items-center gap-3 my-4">
                        <div className="flex-1 h-px bg-bg-tertiary" />
                        <span className="text-[10px] font-medium text-text-muted uppercase tracking-wider whitespace-nowrap">
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
                <StreamingMessage content={streamingContent} activeTools={activeTools} />
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

      {/* Agent Watcher panel */}
      {watcherOpen && (
        <div className="border-l border-border" style={{ width: '40%', minWidth: 280, transition: 'width 300ms ease' }}>
          <AgentWatcher events={agentEvents} onClose={() => setWatcherOpen(false)} />
        </div>
      )}
      </div>{/* end split view */}
    </div>
  );
}

export default ChatView;
