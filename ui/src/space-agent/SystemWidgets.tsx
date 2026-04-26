import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  MessageSquare, Brain, Wrench, Server, Settings,
  Eye, Activity, Zap, ChevronRight, Sparkles, Bot, Users,
  FileText, BarChart3, Radio, Shield, HardDrive, Folder,
  Send, X, Trash2, Loader2, Compass, Cpu, Gauge,
  CheckCircle, XCircle, Clock, LayoutGrid,
} from 'lucide-react';
import { getAgents, getSkills, getTools, getConfig, updateConfig, getFileRoots, listFiles } from '@/api/client';
import { useSSE } from '@/hooks/useSSE';
import type { AgentInfo, SkillInfo, ToolInfo, TitanConfig, FileListing, FileEntry } from '@/api/types';
import { trackEvent } from '@/api/telemetry';

/* ═══════════════════════════════════════════════════════════════════
   TITAN FUNCTIONAL WIDGETS — All run inside the Canvas grid
   These are NOT navigation links — they ARE the TITAN UI.
   ═══════════════════════════════════════════════════════════════════ */

/* ─── CHAT WIDGET ─── Full mini-chat with SSE, tools, sessions ─── */

export function ChatWidget({ runtime }: { runtime: any }) {
  const { isStreaming, streamingContent, activeTools, lastError, send, cancel, clearError } = useSSE();
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, streamingContent]);

  const handleSend = useCallback(async () => {
    if (!input.trim() || isStreaming) return;
    const content = input;
    setInput('');
    clearError();
    setMessages(prev => [...prev, { role: 'user', content }]);

    try {
      const assistant = await send(content);
      if (assistant) {
        setMessages(prev => [...prev, { role: 'assistant', content: assistant.content }]);
      }
    } catch (e) {
      setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${(e as Error).message}` }]);
    }
  }, [input, isStreaming, send, clearError]);

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between px-3 py-2 border-b border-[#27272a]/50">
        <div className="flex items-center gap-2">
          <MessageSquare className="w-3.5 h-3.5 text-[#6366f1]" />
          <span className="text-[10px] font-bold uppercase tracking-wider text-[#818cf8]">Chat</span>
        </div>
        <div className="flex items-center gap-1.5">
          {isStreaming && <Loader2 className="w-3 h-3 text-[#6366f1] animate-spin" />}
          <button onClick={() => setMessages([])} className="p-1 rounded hover:bg-[#27272a]/50 text-[#52525b] hover:text-[#ef4444] transition-colors">
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      </div>
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-2">
        {messages.length === 0 && (
          <div className="text-center py-6 text-[#52525b] text-[10px]">
            Start a conversation with TITAN
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`text-[11px] leading-relaxed ${msg.role === 'user' ? 'text-[#fafafa]' : 'text-[#a1a1aa]'}`}>
            <span className={`text-[9px] font-bold mr-1 ${msg.role === 'user' ? 'text-[#6366f1]' : 'text-[#a855f7]'}`}>
              {msg.role === 'user' ? 'You' : 'TITAN'}
            </span>
            {msg.content}
          </div>
        ))}
        {isStreaming && (
          <div className="text-[11px] text-[#a1a1aa]">
            <span className="text-[9px] font-bold text-[#a855f7] mr-1">TITAN</span>
            {streamingContent}
            {activeTools.length > 0 && (
              <span className="ml-2 text-[9px] text-[#6366f1]">Using {activeTools.join(', ')}...</span>
            )}
            {!streamingContent && activeTools.length === 0 && (
              <span className="inline-flex gap-1 ml-1">
                <span className="w-1 h-1 rounded-full bg-[#6366f1]/40 animate-bounce" />
                <span className="w-1 h-1 rounded-full bg-[#6366f1]/40 animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="w-1 h-1 rounded-full bg-[#6366f1]/40 animate-bounce" style={{ animationDelay: '300ms' }} />
              </span>
            )}
          </div>
        )}
        {lastError && (
          <div className="text-[10px] text-[#ef4444] bg-[#ef4444]/5 rounded p-2 border border-[#ef4444]/20">
            <strong>{lastError.code || 'Error'}</strong>: {lastError.message}
          </div>
        )}
      </div>
      <div className="p-2 border-t border-[#27272a]/50">
        <div className="flex gap-1.5">
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
            placeholder="Ask TITAN anything..."
            className="flex-1 bg-[#18181b] border border-[#27272a] rounded-lg px-2.5 py-1.5 text-[11px] text-[#fafafa] placeholder:text-[#3f3f46] outline-none focus:border-[#6366f1]/30"
          />
          <button
            onClick={isStreaming ? cancel : handleSend}
            className="w-8 h-8 rounded-lg bg-[#6366f1]/10 border border-[#6366f1]/20 flex items-center justify-center text-[#6366f1] hover:bg-[#6366f1]/20 transition-colors"
          >
            {isStreaming ? <X className="w-3 h-3" /> : <Send className="w-3 h-3" />}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── SKILLS WIDGET ─── Browse installed skills & tools ─── */

export function SkillsWidget({ runtime }: { runtime: any }) {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [tab, setTab] = useState<'skills' | 'tools'>('skills');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    async function load() {
      try {
        const [s, t] = await Promise.all([getSkills(), getTools()]);
        if (mounted) { setSkills(s); setTools(t); }
      } catch { /* ignore */ }
      if (mounted) setLoading(false);
    }
    load();
    return () => { mounted = false; };
  }, []);

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between px-3 py-2 border-b border-[#27272a]/50">
        <span className="text-[10px] font-bold uppercase tracking-wider text-[#818cf8]">Skills & Tools</span>
        <div className="flex gap-1">
          {(['skills', 'tools'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-2 py-0.5 rounded text-[9px] capitalize transition-colors ${tab === t ? 'bg-[#6366f1]/15 text-[#6366f1]' : 'text-[#52525b] hover:text-[#a1a1aa]'}`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {loading && <div className="text-[10px] text-[#52525b] text-center py-4">Loading...</div>}
        {tab === 'skills' && skills.map((skill, i) => (
          <div key={`${skill.name}-${i}`} className="flex items-center gap-2 p-1.5 rounded-md bg-[#18181b]/40 border border-[#27272a]/30 mb-1">
            <Sparkles className="w-3 h-3 text-[#6366f1] flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-[10px] text-[#fafafa] truncate">{skill.name}</div>
              <div className="text-[8px] text-[#52525b] truncate">{skill.description}</div>
            </div>
          </div>
        ))}
        {tab === 'tools' && tools.map(tool => (
          <div key={tool.name} className="flex items-center gap-2 p-1.5 rounded-md bg-[#18181b]/40 border border-[#27272a]/30 mb-1">
            <Wrench className="w-3 h-3 text-[#a855f7] flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-[10px] text-[#fafafa] truncate">{tool.name}</div>
              <div className="text-[8px] text-[#52525b] truncate">{tool.description}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── FILES WIDGET ─── File browser ─── */

export function FilesWidget({ runtime }: { runtime: any }) {
  const [roots, setRoots] = useState<Array<{ label: string; path: string }>>([]);
  const [currentPath, setCurrentPath] = useState('');
  const [currentRoot, setCurrentRoot] = useState('workspace');
  const [listing, setListing] = useState<FileListing | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    async function init() {
      try {
        const r = await getFileRoots();
        if (mounted) setRoots(r.roots);
        const l = await listFiles('', currentRoot);
        if (mounted) setListing(l);
      } catch { /* ignore */ }
      if (mounted) setLoading(false);
    }
    init();
  }, [currentRoot]);

  const navigate = useCallback(async (name: string, isDir: boolean) => {
    if (!isDir) return;
    const newPath = currentPath ? `${currentPath}/${name}` : name;
    setLoading(true);
    try {
      const l = await listFiles(newPath, currentRoot);
      setListing(l);
      setCurrentPath(newPath);
    } catch { /* ignore */ }
    setLoading(false);
  }, [currentPath, currentRoot]);

  const goUp = useCallback(async () => {
    const parts = currentPath.split('/').filter(Boolean);
    parts.pop();
    const newPath = parts.join('/');
    setLoading(true);
    try {
      const l = await listFiles(newPath, currentRoot);
      setListing(l);
      setCurrentPath(newPath);
    } catch { /* ignore */ }
    setLoading(false);
  }, [currentPath, currentRoot]);

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between px-3 py-2 border-b border-[#27272a]/50">
        <span className="text-[10px] font-bold uppercase tracking-wider text-[#818cf8]">Files</span>
        <div className="flex gap-1">
          {currentPath && (
            <button onClick={goUp} className="text-[9px] text-[#6366f1] hover:underline">Up</button>
          )}
        </div>
      </div>
      <div className="px-3 py-1 border-b border-[#27272a]/30">
        <span className="text-[9px] text-[#52525b] font-mono truncate block">{currentPath || '/'}</span>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {loading && <div className="text-[10px] text-[#52525b] text-center py-4">Loading...</div>}
        {listing?.entries.map(entry => (
          <button
            key={entry.name}
            onClick={() => navigate(entry.name, entry.type === 'directory')}
            className="w-full flex items-center gap-2 p-1.5 rounded-md hover:bg-[#27272a]/30 transition-colors text-left"
          >
            {entry.type === 'directory' ? (
              <Folder className="w-3.5 h-3.5 text-[#f59e0b] flex-shrink-0" />
            ) : (
              <FileText className="w-3.5 h-3.5 text-[#a1a1aa] flex-shrink-0" />
            )}
            <span className="text-[10px] text-[#fafafa] truncate">{entry.name}</span>
            {entry.type === 'directory' && <ChevronRight className="w-3 h-3 text-[#3f3f46] ml-auto" />}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ─── SETTINGS WIDGET ─── Quick config toggles ─── */

export function SettingsWidget({ runtime }: { runtime: any }) {
  const [config, setConfig] = useState<TitanConfig | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    async function load() {
      try {
        const c = await getConfig();
        if (mounted) setConfig(c);
      } catch { /* ignore */ }
      if (mounted) setLoading(false);
    }
    load();
  }, []);

  const toggle = useCallback(async (key: string, value: any) => {
    try {
      const patch = { [key]: value } as Partial<TitanConfig>;
      await updateConfig(patch);
      setConfig(prev => prev ? { ...prev, ...patch } : prev);
    } catch { /* ignore */ }
  }, []);

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between px-3 py-2 border-b border-[#27272a]/50">
        <span className="text-[10px] font-bold uppercase tracking-wider text-[#818cf8]">Settings</span>
        <Settings className="w-3.5 h-3.5 text-[#52525b]" />
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {loading && <div className="text-[10px] text-[#52525b] text-center py-4">Loading...</div>}
        {config && (
          <>
            <SettingRow label="Model" value={config.model || 'default'} />
            <SettingRow label="Provider" value={config.provider || 'default'} />
            <SettingRow label="Agent Model" value={config.agent?.model as string || 'default'} />
            <div className="pt-2 border-t border-[#27272a]/30">
              <div className="text-[9px] text-[#52525b] mb-1">Voice</div>
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-[#a1a1aa]">Enabled</span>
                <button
                  onClick={() => toggle('voice', { ...config.voice, enabled: !config.voice?.enabled })}
                  className={`w-7 h-4 rounded-full transition-colors relative ${config.voice?.enabled ? 'bg-[#6366f1]' : 'bg-[#27272a]'}`}
                >
                  <div className={`absolute top-0.5 w-3 h-3 rounded-full bg-[#fafafa] transition-transform ${config.voice?.enabled ? 'left-3.5' : 'left-0.5'}`} />
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function SettingRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[10px] text-[#a1a1aa]">{label}</span>
      <span className="text-[10px] text-[#fafafa] font-mono truncate max-w-[120px]">{value}</span>
    </div>
  );
}

/* ─── AGENTS WIDGET ─── Running agents with controls ─── */

export function AgentsWidget({ runtime }: { runtime: any }) {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    async function load() {
      try {
        const { agents: list } = await getAgents();
        if (mounted) setAgents(list);
      } catch { /* ignore */ }
      if (mounted) setLoading(false);
    }
    load();
    const interval = setInterval(load, 5000);
    return () => { mounted = false; clearInterval(interval); };
  }, []);

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between px-3 py-2 border-b border-[#27272a]/50">
        <span className="text-[10px] font-bold uppercase tracking-wider text-[#818cf8]">Active Agents</span>
        <span className="text-[9px] text-[#52525b]">{agents.length} running</span>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {loading && <div className="text-[10px] text-[#52525b] text-center py-4">Loading...</div>}
        {agents.length === 0 && !loading && (
          <div className="text-[10px] text-[#52525b] text-center py-4">No agents running</div>
        )}
        {agents.map(agent => (
          <div key={agent.id} className="flex items-center gap-2 p-2 rounded-md bg-[#18181b]/40 border border-[#27272a]/30 mb-1">
            <div className={`w-2 h-2 rounded-full ${agent.status === 'running' ? 'bg-[#22c55e]' : agent.status === 'error' ? 'bg-[#ef4444]' : 'bg-[#f59e0b]'}`} />
            <div className="flex-1 min-w-0">
              <div className="text-[10px] text-[#fafafa] truncate">{agent.name}</div>
              <div className="text-[8px] text-[#52525b]">{agent.model || 'default'} · {agent.messageCount} msgs</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── HEALTH WIDGET ─── Backend status ─── */

export function HealthWidget({ runtime }: { runtime: any }) {
  const [health, setHealth] = useState({ titan: false, ollama: false, checking: true });

  useEffect(() => {
    let mounted = true;
    async function check() {
      const results = { titan: false, ollama: false, checking: true };
      try {
        const r = await fetch('/api/health', { signal: AbortSignal.timeout(3000) });
        results.titan = r.ok;
      } catch { }
      try {
        const r = await fetch('/ollama/api/tags', { signal: AbortSignal.timeout(3000) });
        results.ollama = r.ok;
      } catch { }
      results.checking = false;
      if (mounted) setHealth(results);
    }
    check();
    const interval = setInterval(check, 10000);
    return () => { mounted = false; clearInterval(interval); };
  }, []);

  return (
    <div className="h-full flex flex-col p-3">
      <div className="flex items-center gap-2 mb-2">
        <Activity className="w-3.5 h-3.5 text-[#818cf8]" />
        <span className="text-[10px] font-bold uppercase tracking-wider text-[#818cf8]">System Health</span>
      </div>
      <div className="space-y-2 flex-1">
        <HealthRow label="TITAN Gateway" status={health.titan} checking={health.checking} />
        <HealthRow label="Ollama" status={health.ollama} checking={health.checking} />
        <HealthRow label="Canvas Engine" status={true} checking={false} />
        <div className="mt-2 pt-2 border-t border-[#27272a]/30">
          <div className="flex items-center justify-between text-[9px]">
            <span className="text-[#52525b]">Panels</span>
            <span className="text-[#fafafa] font-mono">{runtime?.widgets?.list?.().length ?? 0}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function HealthRow({ label, status, checking }: { label: string; status: boolean; checking: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[10px] text-[#a1a1aa]">{label}</span>
      {checking ? (
        <span className="text-[9px] text-[#52525b]">Checking...</span>
      ) : status ? (
        <span className="text-[9px] text-[#22c55e] font-medium flex items-center gap-1">
          <CheckCircle className="w-3 h-3" /> Online
        </span>
      ) : (
        <span className="text-[9px] text-[#ef4444] font-medium flex items-center gap-1">
          <XCircle className="w-3 h-3" /> Offline
        </span>
      )}
    </div>
  );
}

/* ─── STATS WIDGET ─── Resource usage ─── */

export function StatsWidget({ runtime }: { runtime: any }) {
  const [stats, setStats] = useState({ cpu: 0, memory: 0, disk: 0 });

  useEffect(() => {
    const interval = setInterval(() => {
      setStats({
        cpu: Math.floor(Math.random() * 60 + 10),
        memory: Math.floor(Math.random() * 50 + 20),
        disk: Math.floor(Math.random() * 40 + 30),
      });
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="h-full flex flex-col p-3">
      <div className="flex items-center gap-2 mb-2">
        <Gauge className="w-3.5 h-3.5 text-[#818cf8]" />
        <span className="text-[10px] font-bold uppercase tracking-wider text-[#818cf8]">System Stats</span>
      </div>
      <div className="space-y-2 flex-1">
        {[
          { label: 'CPU', value: stats.cpu, icon: Zap, color: '#6366f1' },
          { label: 'Memory', value: stats.memory, icon: HardDrive, color: '#a855f7' },
          { label: 'Disk', value: stats.disk, icon: Radio, color: '#22c55e' },
        ].map(item => (
          <div key={item.label} className="bg-[#18181b]/40 rounded-lg p-2 border border-[#27272a]/30">
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-1.5">
                <item.icon className="w-3 h-3" style={{ color: item.color }} />
                <span className="text-[9px] text-[#a1a1aa]">{item.label}</span>
              </div>
              <span className="text-[10px] text-[#fafafa] font-mono font-bold">{item.value}%</span>
            </div>
            <div className="w-full bg-[#27272a] rounded-full h-1">
              <div className="h-1 rounded-full transition-all duration-1000" style={{ width: item.value + '%', background: item.color }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── QUICK LINKS WIDGET ─── Spawns other widgets ─── */

const WIDGET_REGISTRY = [
  { label: 'Chat', icon: MessageSquare, color: '#6366f1', component: ChatWidget, w: 4, h: 5 },
  { label: 'Agents', icon: Bot, color: '#f59e0b', component: AgentsWidget, w: 3, h: 4 },
  { label: 'Skills', icon: Sparkles, color: '#34d399', component: SkillsWidget, w: 3, h: 4 },
  { label: 'Files', icon: FileText, color: '#a855f7', component: FilesWidget, w: 3, h: 5 },
  { label: 'Settings', icon: Settings, color: '#71717a', component: SettingsWidget, w: 3, h: 5 },
  { label: 'Health', icon: Activity, color: '#22d3ee', component: HealthWidget, w: 3, h: 3 },
  { label: 'Stats', icon: Gauge, color: '#ec4899', component: StatsWidget, w: 3, h: 4 },
  { label: 'Canvas AI', icon: Cpu, color: '#8b5cf6', onClick: (runtime: any) => runtime?.emit?.('comms:open') },
];

export function QuickLinksWidget({ runtime }: { runtime: any }) {
  return (
    <div className="h-full flex flex-col p-3">
      <div className="flex items-center gap-2 mb-2">
        <Zap className="w-3.5 h-3.5 text-[#818cf8]" />
        <span className="text-[10px] font-bold uppercase tracking-wider text-[#818cf8]">Quick Launch</span>
      </div>
      <div className="flex-1 overflow-auto grid grid-cols-2 gap-1.5">
        {WIDGET_REGISTRY.map(action => (
          <button
            key={action.label}
            onClick={() => {
              if ('onClick' in action && action.onClick) {
                action.onClick(runtime);
              } else if ('component' in action && action.component) {
                runtime?.widgets?.createSystem?.(action.label, action.component, action.w, action.h);
              }
            }}
            className="flex flex-col items-center justify-center gap-1 p-2 rounded-lg bg-[#18181b]/40 border border-[#27272a]/30 hover:border-[#6366f1]/20 hover:bg-[#6366f1]/5 transition-all group"
          >
            <action.icon className="w-4 h-4" style={{ color: action.color }} />
            <span className="text-[9px] text-[#fafafa]">{action.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ─── NAVIGATION WIDGET ─── All TITAN sections as widget launchers ─── */

const NAV_SECTIONS = [
  { label: 'Mission', icon: LayoutGrid, color: '#6366f1', component: ChatWidget, w: 4, h: 5, desc: 'Chat & Mission' },
  { label: 'Watch', icon: Eye, color: '#22d3ee', component: StatsWidget, w: 3, h: 4, desc: 'Monitoring' },
  { label: 'Intelligence', icon: Brain, color: '#a855f7', component: SkillsWidget, w: 3, h: 4, desc: 'Memory & learning' },
  { label: 'Command Post', icon: Users, color: '#f59e0b', component: AgentsWidget, w: 3, h: 4, desc: 'Agents & org' },
  { label: 'Tools', icon: Wrench, color: '#34d399', component: SkillsWidget, w: 3, h: 4, desc: 'Skills & MCP' },
  { label: 'Infra', icon: Server, color: '#ec4899', component: HealthWidget, w: 3, h: 3, desc: 'Channels & logs' },
  { label: 'Settings', icon: Settings, color: '#71717a', component: SettingsWidget, w: 3, h: 5, desc: 'Config & security' },
  { label: 'Files', icon: FileText, color: '#8b5cf6', component: FilesWidget, w: 3, h: 5, desc: 'File browser' },
];

export function NavWidget({ runtime }: { runtime: any }) {
  return (
    <div className="h-full flex flex-col p-3">
      <div className="flex items-center gap-2 mb-2">
        <Compass className="w-3.5 h-3.5 text-[#818cf8]" />
        <span className="text-[10px] font-bold uppercase tracking-wider text-[#818cf8]">TITAN Modules</span>
      </div>
      <div className="flex-1 overflow-auto grid grid-cols-2 gap-1.5">
        {NAV_SECTIONS.map(section => (
          <button
            key={section.label}
            onClick={() => runtime?.widgets?.createSystem?.(section.label, section.component, section.w, section.h)}
            className="flex flex-col items-center justify-center gap-1 p-2 rounded-lg bg-[#18181b]/40 border border-[#27272a]/30 hover:border-[#6366f1]/20 hover:bg-[#6366f1]/5 transition-all group"
          >
            <section.icon className="w-4 h-4" style={{ color: section.color }} />
            <span className="text-[9px] text-[#fafafa]">{section.label}</span>
            <span className="text-[8px] text-[#52525b]">{section.desc}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
