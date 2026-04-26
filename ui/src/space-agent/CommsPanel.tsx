import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Send, X, Minimize2, Maximize2, Sparkles, Loader2, Bot, User, Terminal, Cpu, BarChart3, Clock, Table, Cloud, Bitcoin, CheckSquare, Square, Command, AlertCircle, Wrench, ChevronDown, Wifi, WifiOff } from 'lucide-react';
import type { ChatMessage as ApiChatMessage } from '@/api/types';
import { useCanvasSSE } from './useCanvasSSE';
import { useCanvas } from './CanvasContext';
import { wrapCanvasMessage, extractWidgetsFromMessage } from './ChatEngine';
import { compileWidgetCode, executeWidgetCode, generateWidgetCode } from './widgetCompiler';
import { createSession, getSessions, getSessionMessages, getAgents } from '@/api/client';
import { trackEvent } from '@/api/telemetry';

const QUICK_ACTIONS = [
  { label: 'System Monitor', icon: Cpu, prompt: 'Create a system monitor widget with CPU, memory, disk, and network stats showing live updating data with progress bars and a sparkline graph' },
  { label: 'Data Chart', icon: BarChart3, prompt: 'Make a bar chart widget showing weekly activity data with 7 days and animated bars' },
  { label: 'Terminal', icon: Terminal, prompt: 'Create a terminal console widget with command input and simulated responses' },
  { label: 'Clock', icon: Clock, prompt: 'Make a digital clock widget showing time and date' },
  { label: 'Node Table', icon: Table, prompt: 'Create a node status table widget with servers, their status, load, and region' },
  { label: 'Weather', icon: Cloud, prompt: 'Create a weather widget showing current conditions and a 5-day forecast' },
  { label: 'Crypto', icon: Bitcoin, prompt: 'Make a crypto ticker widget showing Bitcoin, Ethereum, Solana, and Cardano prices with live updates' },
  { label: 'Tasks', icon: CheckSquare, prompt: 'Create a todo list widget with add, complete, and remove functionality' },
];

async function createWidgetFromTemplate(prompt: string, runtime: any) {
  const { title, code } = await generateWidgetCode(prompt);
  const compiled = await compileWidgetCode(code);
  const component = executeWidgetCode(compiled, { React });
  await runtime.widgets.create({
    title,
    code,
    compiledCode: compiled,
    component,
    x: 0,
    y: 0,
    w: 4,
    h: 4,
  });
  return title;
}

interface AgentOption {
  id: string;
  name: string;
}

export default function CommsPanel() {
  const [isOpen, setIsOpen] = useState(true);
  const [isMinimized, setIsMinimized] = useState(false);
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ApiChatMessage[]>([
    {
      role: 'assistant',
      content: 'Welcome to TITAN Canvas. I can create panels, dashboards, and tools for you. What would you like to build?\n\nTry asking me to create a system monitor, chart, terminal, clock, or any custom tool.',
      timestamp: new Date().toISOString(),
    },
  ]);
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<string | undefined>(undefined);
  const [showAgentDropdown, setShowAgentDropdown] = useState(false);
  const [position, setPosition] = useState({ x: typeof window !== 'undefined' ? window.innerWidth - 440 : 100, y: 80 });
  const [isDragging, setIsDragging] = useState(false);
  const dragOffset = useRef({ x: 0, y: 0 });
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const agentDropdownRef = useRef<HTMLDivElement>(null);
  const { runtime } = useCanvas();

  const {
    isStreaming,
    streamingContent,
    activeTools,
    titanHealthy,
    lastError,
    send,
    cancel,
    clearError,
    checkHealth,
  } = useCanvasSSE();

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, streamingContent, activeTools.length]);

  // Check TITAN health on mount
  useEffect(() => {
    checkHealth();
  }, [checkHealth]);

  // Load or create canvas session on mount
  useEffect(() => {
    let mounted = true;
    async function initSession() {
      try {
        const sessions = await getSessions();
        if (!mounted) return;
        const canvasSession = sessions.find(s => s.channel === 'canvas' || s.name?.toLowerCase().includes('canvas'));
        if (canvasSession) {
          setSessionId(canvasSession.id);
          const history = await getSessionMessages(canvasSession.id);
          if (mounted && history.length > 0) {
            setMessages(history);
          }
        }
      } catch (e) {
        // No existing session, will create on first message
      }
    }
    initSession();
    return () => { mounted = false; };
  }, []);

  // Load available agents
  useEffect(() => {
    let mounted = true;
    async function loadAgents() {
      try {
        const { agents: list } = await getAgents();
        if (!mounted) return;
        setAgents(list.filter(a => a.status === 'running').map(a => ({ id: a.id, name: a.name })));
      } catch (e) {
        // Ignore
      }
    }
    loadAgents();
    return () => { mounted = false; };
  }, []);

  // Close agent dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (agentDropdownRef.current && !agentDropdownRef.current.contains(e.target as Node)) {
        setShowAgentDropdown(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    const target = e.target as HTMLElement;
    if (!target.closest('[data-comms-header]')) return;
    setIsDragging(true);
    dragOffset.current = {
      x: e.clientX - position.x,
      y: e.clientY - position.y,
    };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [position]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!isDragging) return;
    setPosition({
      x: Math.max(0, Math.min(window.innerWidth - 400, e.clientX - dragOffset.current.x)),
      y: Math.max(0, Math.min(window.innerHeight - 100, e.clientY - dragOffset.current.y)),
    });
  }, [isDragging]);

  const handlePointerUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  const sendMessage = useCallback(async (content: string) => {
    if (!content.trim() || isStreaming) return;

    // Create session if needed
    let sid = sessionId;
    if (!sid) {
      try {
        const { id } = await createSession();
        sid = id;
        setSessionId(id);
        try {
          const { renameSession } = await import('@/api/client');
          await renameSession(id, 'Canvas');
        } catch { /* ignore rename errors */ }
      } catch (e) {
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: `Failed to create session: ${(e as Error).message}`,
          timestamp: new Date().toISOString(),
        }]);
        return;
      }
    }

    const userMsg: ApiChatMessage = {
      role: 'user',
      content,
      timestamp: new Date().toISOString(),
    };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    clearError();

    trackEvent('canvas_message_sent', {
      hasSession: !!sid,
      agentId: selectedAgent,
      panelCount: runtime.widgets.list().length,
      backend: titanHealthy ? 'titan' : 'ollama',
    });

    try {
      const wrappedContent = wrapCanvasMessage(content);
      const options = selectedAgent ? { agentId: selectedAgent } : undefined;

      const assistantMsg = await send(wrappedContent, sid, options);

      if (!assistantMsg) {
        return;
      }

      // Extract widgets from response
      const { message: displayText, widgets } = extractWidgetsFromMessage(assistantMsg.content);
      console.log('[Canvas] Widget extraction:', { hasWidgets: !!widgets, count: widgets?.length, rawContent: assistantMsg.content.slice(0, 200) });

      if (widgets && widgets.length > 0) {
        trackEvent('canvas_widgets_generated', {
          count: widgets.length,
          titles: widgets.map(w => w.title),
        });

        for (const widgetDef of widgets) {
          try {
            const compiled = await compileWidgetCode(widgetDef.code);
            const component = executeWidgetCode(compiled, { React });
            await runtime.widgets.create({
              title: widgetDef.title,
              code: widgetDef.code,
              compiledCode: compiled,
              component,
              x: 0,
              y: 0,
              w: 4,
              h: 4,
            });
            console.log('[Canvas] Widget created:', widgetDef.title);
          } catch (err: any) {
            console.error('[Canvas] Panel creation failed:', err);
            trackEvent('canvas_widget_error', { error: err.message, title: widgetDef.title });
          }
        }
      } else if (assistantMsg.content.toLowerCase().includes('created') && assistantMsg.content.toLowerCase().includes('widget')) {
        // Fallback: LLM said it created a widget but didn't output the code block
        // Try to match known widget types from the response
        const content = assistantMsg.content.toLowerCase();
        const matched = QUICK_ACTIONS.find(a => content.includes(a.label.toLowerCase()));
        if (matched) {
          try {
            const title = await createWidgetFromTemplate(matched.prompt, runtime);
            console.log('[Canvas] Fallback widget created:', title);
          } catch (err: any) {
            console.error('[Canvas] Fallback widget creation failed:', err);
          }
        }
      }

      setMessages(prev => [...prev, {
        role: 'assistant',
        content: displayText || assistantMsg.content,
        timestamp: new Date().toISOString(),
        toolsUsed: assistantMsg.toolsUsed,
        toolInvocations: assistantMsg.toolInvocations,
        model: assistantMsg.model,
        durationMs: assistantMsg.durationMs,
      }]);
    } catch (err: any) {
      if (err.name === 'AbortError') {
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: 'Request cancelled.',
          timestamp: new Date().toISOString(),
        }]);
      } else {
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: `Error: ${err.message}`,
          timestamp: new Date().toISOString(),
        }]);
      }
    }
  }, [isStreaming, sessionId, selectedAgent, runtime.widgets, send, clearError, titanHealthy]);

  const handleSend = useCallback(() => {
    sendMessage(input);
  }, [input, sendMessage]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 120) + 'px';
    }
  }, [input]);

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="fixed bottom-6 right-6 z-50 w-14 h-14 rounded-2xl bg-[#18181b]/90 backdrop-blur-xl border border-[#6366f1]/30 flex items-center justify-center text-[#6366f1] hover:bg-[#18181b] transition-all shadow-lg shadow-[#6366f1]/10 hover:shadow-[#6366f1]/20 hover:scale-105"
      >
        <Command className="w-6 h-6" />
      </button>
    );
  }

  return (
    <div
      className={`fixed z-50 flex flex-col bg-[#18181b]/95 backdrop-blur-xl border border-[#27272a] rounded-2xl shadow-2xl transition-all overflow-hidden ${isMinimized ? 'w-72 h-12' : 'w-[440px] h-[600px]'}`}
      style={{
        left: position.x,
        top: position.y,
        cursor: isDragging ? 'grabbing' : 'auto',
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    >
      {/* Header */}
      <div
        data-comms-header
        className="flex items-center justify-between px-4 py-2.5 border-b border-[#27272a] cursor-grab active:cursor-grabbing select-none bg-gradient-to-r from-[#18181b] to-[#09090b]"
      >
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-[#6366f1]/10 border border-[#6366f1]/20 flex items-center justify-center">
            <Bot className="w-4 h-4 text-[#6366f1]" />
          </div>
          <div className="flex flex-col">
            <span className="text-sm font-semibold text-[#fafafa]">TITAN Canvas</span>
            <div className="flex items-center gap-1.5">
              {titanHealthy === true && <Wifi className="w-2.5 h-2.5 text-[#22c55e]" />}
              {titanHealthy === false && <WifiOff className="w-2.5 h-2.5 text-[#f59e0b]" />}
              {titanHealthy === null && <Loader2 className="w-2.5 h-2.5 text-[#71717a] animate-spin" />}
              <span className="text-[10px] text-[#a855f7]">
                {isStreaming ? (activeTools.length > 0 ? `Using ${activeTools[0]}...` : 'Thinking...')
                  : titanHealthy === true ? 'TITAN Gateway'
                  : titanHealthy === false ? 'Ollama Fallback'
                  : 'Checking...'}
              </span>
            </div>
          </div>
          {isStreaming && <Loader2 className="w-3.5 h-3.5 text-[#6366f1] animate-spin" />}
        </div>
        <div className="flex items-center gap-1">
          {isStreaming && (
            <button
              onClick={cancel}
              className="p-1.5 rounded-lg hover:bg-[#ef4444]/10 text-[#ef4444] text-[10px] transition-colors"
            >
              Stop
            </button>
          )}
          <button
            onClick={() => setIsMinimized(!isMinimized)}
            className="p-1.5 rounded-lg hover:bg-[#27272a]/50 text-[#71717a] hover:text-[#fafafa] transition-colors"
          >
            {isMinimized ? <Maximize2 className="w-3.5 h-3.5" /> : <Minimize2 className="w-3.5 h-3.5" />}
          </button>
          <button
            onClick={() => setIsOpen(false)}
            className="p-1.5 rounded-lg hover:bg-[#27272a]/50 text-[#71717a] hover:text-[#fafafa] transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {!isMinimized && (
        <>
          {/* Agent selector + Quick Actions */}
          <div className="px-3 pt-3 pb-1 space-y-2">
            {agents.length > 0 && titanHealthy === true && (
              <div className="flex items-center gap-2">
                <div className="relative" ref={agentDropdownRef}>
                  <button
                    onClick={() => setShowAgentDropdown(!showAgentDropdown)}
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[#18181b] border border-[#27272a] text-[10px] text-[#a1a1aa] hover:border-[#6366f1]/30 transition-colors"
                  >
                    <Wrench className="w-3 h-3" />
                    {selectedAgent ? agents.find(a => a.id === selectedAgent)?.name || 'Agent' : 'Default Agent'}
                    <ChevronDown className="w-3 h-3" />
                  </button>
                  {showAgentDropdown && (
                    <div className="absolute top-full left-0 mt-1 w-48 bg-[#18181b] border border-[#27272a] rounded-lg shadow-xl z-50 py-1">
                      <button
                        onClick={() => { setSelectedAgent(undefined); setShowAgentDropdown(false); }}
                        className="w-full text-left px-3 py-1.5 text-[11px] text-[#a1a1aa] hover:bg-[#27272a]/50 transition-colors"
                      >
                        Default Agent
                      </button>
                      {agents.map(agent => (
                        <button
                          key={agent.id}
                          onClick={() => { setSelectedAgent(agent.id); setShowAgentDropdown(false); }}
                          className="w-full text-left px-3 py-1.5 text-[11px] text-[#a1a1aa] hover:bg-[#27272a]/50 transition-colors"
                        >
                          {agent.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {selectedAgent && (
                  <span className="text-[10px] text-[#6366f1]">Routing to specialist</span>
                )}
              </div>
            )}
            <div className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-hide">
              {QUICK_ACTIONS.map(action => (
                <button
                  key={action.label}
                  onClick={async () => {
                    try {
                      const title = await createWidgetFromTemplate(action.prompt, runtime);
                      setMessages(prev => [...prev, {
                        role: 'assistant',
                        content: `Created **${title}** widget on your Canvas.`,
                        timestamp: new Date().toISOString(),
                      }]);
                    } catch (err: any) {
                      setMessages(prev => [...prev, {
                        role: 'assistant',
                        content: `Failed to create widget: ${err.message}`,
                        timestamp: new Date().toISOString(),
                      }]);
                    }
                  }}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-[#18181b] border border-[#27272a] text-[10px] text-[#a1a1aa] hover:bg-[#6366f1]/5 hover:border-[#6366f1]/20 hover:text-[#818cf8] transition-all whitespace-nowrap flex-shrink-0"
                >
                  <action.icon className="w-3 h-3" />
                  {action.label}
                </button>
              ))}
            </div>
          </div>

          {/* Messages */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
            {messages.map((msg, i) => (
              <div key={i} className={`flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
                <div className={`w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5 ${
                  msg.role === 'user'
                    ? 'bg-[#6366f1]/15 border border-[#6366f1]/25 text-[#6366f1]'
                    : 'bg-[#a855f7]/10 border border-[#a855f7]/20 text-[#a855f7]'
                }`}>
                  {msg.role === 'user' ? <User className="w-3.5 h-3.5" /> : <Bot className="w-3.5 h-3.5" />}
                </div>
                <div className={`max-w-[82%] px-3.5 py-2.5 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap ${
                  msg.role === 'user'
                    ? 'bg-[#6366f1]/8 text-[#fafafa] border border-[#6366f1]/15 rounded-tr-sm'
                    : 'bg-[#18181b]/80 text-[#a1a1aa] border border-[#27272a]/60 rounded-tl-sm'
                }`}>
                  {renderMessageContent(msg.content)}
                  {msg.toolInvocations && msg.toolInvocations.length > 0 && (
                    <div className="mt-2 pt-2 border-t border-[#27272a]/40">
                      <div className="flex flex-wrap gap-1">
                        {msg.toolInvocations.slice(0, 3).map((tool, ti) => (
                          <span key={ti} className={`px-1.5 py-0.5 rounded text-[9px] font-medium ${
                            tool.status === 'success' ? 'bg-[#22c55e]/10 text-[#22c55e]' :
                            tool.status === 'error' ? 'bg-[#ef4444]/10 text-[#ef4444]' :
                            'bg-[#6366f1]/10 text-[#6366f1]'
                          }`}>
                            {tool.toolName}
                          </span>
                        ))}
                        {msg.toolInvocations.length > 3 && (
                          <span className="text-[9px] text-[#52525b]">+{msg.toolInvocations.length - 3}</span>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ))}

            {/* Streaming message */}
            {isStreaming && (
              <div className="flex gap-3">
                <div className="w-7 h-7 rounded-lg bg-[#a855f7]/10 border border-[#a855f7]/20 flex items-center justify-center">
                  <Bot className="w-3.5 h-3.5 text-[#a855f7]" />
                </div>
                <div className="max-w-[82%] px-3.5 py-2.5 rounded-2xl rounded-tl-sm bg-[#18181b]/80 border border-[#27272a]/60 text-sm text-[#a1a1aa] whitespace-pre-wrap">
                  {streamingContent && renderMessageContent(streamingContent)}
                  {activeTools.length > 0 && (
                    <div className="mt-2 flex items-center gap-2">
                      <Loader2 className="w-3 h-3 text-[#6366f1] animate-spin" />
                      <span className="text-[10px] text-[#6366f1]">{activeTools.join(', ')}</span>
                    </div>
                  )}
                  {!streamingContent && activeTools.length === 0 && (
                    <div className="flex gap-1">
                      <div className="w-2 h-2 rounded-full bg-[#6366f1]/40 animate-bounce" style={{ animationDelay: '0ms' }} />
                      <div className="w-2 h-2 rounded-full bg-[#6366f1]/40 animate-bounce" style={{ animationDelay: '150ms' }} />
                      <div className="w-2 h-2 rounded-full bg-[#6366f1]/40 animate-bounce" style={{ animationDelay: '300ms' }} />
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Error display */}
            {lastError && (
              <div className="flex gap-3">
                <div className="w-7 h-7 rounded-lg bg-[#ef4444]/10 border border-[#ef4444]/20 flex items-center justify-center">
                  <AlertCircle className="w-3.5 h-3.5 text-[#ef4444]" />
                </div>
                <div className="max-w-[82%] px-3.5 py-2.5 rounded-2xl rounded-tl-sm bg-[#ef4444]/5 border border-[#ef4444]/20 text-sm text-[#ef4444]">
                  <div className="font-semibold text-[11px] uppercase tracking-wider mb-1">{lastError.code || 'Error'}</div>
                  {lastError.message}
                  {lastError.action && (
                    <button
                      onClick={() => {
                        if (lastError.action?.type === 'navigate') {
                          window.location.href = lastError.action.target;
                        }
                      }}
                      className="mt-2 px-3 py-1 rounded-lg bg-[#ef4444]/10 border border-[#ef4444]/20 text-[10px] text-[#ef4444] hover:bg-[#ef4444]/20 transition-colors"
                    >
                      {lastError.action.label}
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Input */}
          <div className="p-3 border-t border-[#27272a] bg-[#18181b]/50">
            <div className="flex gap-2 items-end">
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask me to create a panel, dashboard, or tool..."
                className="flex-1 bg-[#18181b]/80 border border-[#27272a] rounded-xl px-3.5 py-2.5 text-sm text-[#fafafa] placeholder:text-[#52525b] resize-none outline-none focus:border-[#6366f1]/40 transition-colors leading-relaxed"
                rows={1}
                style={{ minHeight: 40, maxHeight: 120 }}
              />
              <button
                onClick={isStreaming ? cancel : handleSend}
                className="w-10 h-10 rounded-xl bg-[#6366f1]/10 border border-[#6366f1]/25 flex items-center justify-center text-[#6366f1] hover:bg-[#6366f1]/20 disabled:opacity-30 disabled:cursor-not-allowed transition-all hover:scale-105 flex-shrink-0"
              >
                {isStreaming ? <Square className="w-3.5 h-3.5 fill-current" /> : <Send className="w-4 h-4" />}
              </button>
            </div>
            <div className="flex items-center justify-between mt-1.5 px-1">
              <div className="flex items-center gap-1 text-[10px] text-[#52525b]">
                <Terminal className="w-3 h-3" />
                <span>Shift+Enter for new line</span>
              </div>
              <div className="text-[10px] text-[#52525b]">
                {messages.length} messages
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function renderMessageContent(content: string) {
  const parts = content.split(/(\*\*.*?\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i} className="text-[#818cf8]">{part.slice(2, -2)}</strong>;
    }
    return <span key={i}>{part}</span>;
  });
}
