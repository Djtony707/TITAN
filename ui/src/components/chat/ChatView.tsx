import { useState, useEffect, useRef, useCallback } from 'react';
import { MessageSquarePlus, PanelLeftClose, PanelLeft, Trash2, Pencil, Check, X } from 'lucide-react';
import { useSSE } from '@/hooks/useSSE';
import { getSessions, getSessionMessages, deleteSession, renameSession, getAgents, abortSession } from '@/api/client';
import type { ChatMessage, Session, AgentInfo } from '@/api/types';
import { useConfig } from '@/hooks/useConfig';
import { MessageBubble } from './MessageBubble';
import { StreamingMessage } from './StreamingMessage';
import { ChatInput } from './ChatInput';
import { QuickActions } from './QuickActions';

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
  const { isStreaming, streamingContent, activeTools, send, cancel } = useSSE();
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
    <div className="flex flex-col h-full bg-[#111113] border-r border-[#27272a]">
      <div className="flex items-center justify-between p-3 border-b border-[#27272a]">
        <button
          onClick={handleNewChat}
          className="flex items-center gap-2 px-3 py-2 text-sm text-[#fafafa] bg-[#27272a] hover:bg-[#3f3f46] rounded-lg transition-colors w-full"
        >
          <MessageSquarePlus className="w-4 h-4" />
          New chat
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
        {sessions.length > 0 && (
          <p className="px-3 pt-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-[#52525b]">Recent</p>
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
                ? 'bg-[#27272a] text-[#fafafa]'
                : 'text-[#a1a1aa] hover:bg-[#1c1c1e] hover:text-[#fafafa]'
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
                  className="flex-1 min-w-0 bg-[#18181b] text-[#fafafa] text-xs px-2 py-1 rounded border border-[#6366f1]/50 outline-none"
                />
                <button onClick={() => handleConfirmRename(session.id)} className="p-1 text-green-400 hover:text-green-300 shrink-0">
                  <Check className="w-3 h-3" />
                </button>
                <button onClick={handleCancelRename} className="p-1 text-[#71717a] hover:text-[#fafafa] shrink-0">
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
                    className="p-1 hover:text-[#6366f1] transition-colors"
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
          <p className="text-[#52525b] text-xs text-center mt-8 px-2">No conversations yet</p>
        )}
      </div>
    </div>
  );

  // Empty state — centered prompt with TITAN branding
  const emptyState = (
    <div className="flex-1 flex flex-col items-center justify-center px-4">
      <div className="mb-6 relative">
        <div className="absolute -inset-4 rounded-full bg-[#6366f1]/10 blur-xl" />
        <img
          src="/titan-logo.png"
          alt="TITAN"
          className="relative w-16 h-16 rounded-2xl ring-1 ring-white/10"
        />
      </div>
      <h2 className="text-2xl font-semibold text-[#fafafa] mb-2">What would you like to tackle?</h2>
      <p className="text-sm text-[#52525b] max-w-md text-center mb-8">
        I can search the web, write &amp; run code, automate browsers, manage files, execute shell commands, use ~149 tools across 34 providers, and operate autonomously toward goals.
      </p>
      <div className="flex flex-wrap justify-center gap-2 max-w-lg">
        {[
          'Research a topic',
          'Write some code',
          'Automate a task',
          'Browse the web',
        ].map((suggestion) => (
          <button
            key={suggestion}
            onClick={() => handleSend(suggestion)}
            className="px-4 py-2 text-sm text-[#a1a1aa] border border-[#27272a] rounded-full hover:border-[#6366f1]/50 hover:text-[#fafafa] hover:bg-[#6366f1]/10 transition-all"
          >
            {suggestion}
          </button>
        ))}
      </div>
      <QuickActions onSelectAction={handleSend} visible={true} />
    </div>
  );

  return (
    <div className="flex h-full overflow-hidden bg-[#09090b]">
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

      {/* Main chat area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar — minimal */}
        <div className="flex items-center gap-2 px-3 py-2 shrink-0">
          <button
            onClick={() => setSidebarOpen((prev) => !prev)}
            className="p-2 text-[#52525b] hover:text-[#a1a1aa] rounded-lg hover:bg-[#18181b] transition-colors"
            aria-label="Toggle sessions"
          >
            {sidebarOpen ? (
              <PanelLeftClose className="w-5 h-5" />
            ) : (
              <PanelLeft className="w-5 h-5" />
            )}
          </button>
        </div>

        {/* Agent selector */}
        {agents.length > 1 && (
          <div className="flex items-center gap-2 px-4 py-2 border-b border-[#27272a] shrink-0 overflow-x-auto">
            <span className="text-xs text-[#71717a] shrink-0">Agent:</span>
            <button
              onClick={() => setSelectedAgent(null)}
              className={`px-3 py-1 rounded-full text-xs transition-colors shrink-0 ${
                !selectedAgent ? 'bg-[#6366f1] text-white' : 'bg-[#27272a] text-[#a1a1aa] hover:bg-[#3f3f46]'
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
                      ? 'bg-[#6366f1] text-white'
                      : 'bg-[#27272a] text-[#a1a1aa] hover:bg-[#3f3f46]'
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
                        <div className="flex-1 h-px bg-[#27272a]" />
                        <span className="text-[10px] font-medium text-[#52525b] uppercase tracking-wider whitespace-nowrap">
                          {separatorLabel}
                        </span>
                        <div className="flex-1 h-px bg-[#27272a]" />
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
      </div>
    </div>
  );
}

export default ChatView;
