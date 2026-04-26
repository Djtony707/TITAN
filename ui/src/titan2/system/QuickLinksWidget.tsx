import React from 'react';
import {
  Compass, Bot, Activity, Gauge, Zap, MessageSquare, FileText,
  Sparkles, Hexagon, Brain, Server, Wrench, Settings,
  BookOpen, FlaskConical, GitPullRequest, Eye, Clock,
  Archive, Cpu, Users, Shield, Radio, Globe, Paperclip as PaperclipIcon, TestTube, Save,
} from 'lucide-react';

const LINKS = [
  { label: 'Nav', source: 'system:nav', w: 3, h: 4, icon: <Compass className="w-3.5 h-3.5" /> },
  { label: 'Agents', source: 'system:agents', w: 3, h: 4, icon: <Bot className="w-3.5 h-3.5" /> },
  { label: 'Health', source: 'system:health', w: 3, h: 3, icon: <Activity className="w-3.5 h-3.5" /> },
  { label: 'Stats', source: 'system:stats', w: 3, h: 4, icon: <Gauge className="w-3.5 h-3.5" /> },
  { label: 'Chat', source: 'system:chat', w: 4, h: 5, icon: <MessageSquare className="w-3.5 h-3.5" /> },
  { label: 'Files', source: 'system:files', w: 4, h: 6, icon: <FileText className="w-3.5 h-3.5" /> },
  { label: 'Skills', source: 'system:tools', w: 5, h: 4, icon: <Sparkles className="w-3.5 h-3.5" /> },
  { label: 'Soma', source: 'system:soma', w: 6, h: 6, icon: <Hexagon className="w-3.5 h-3.5" /> },
  { label: 'Intel', source: 'system:intelligence', w: 6, h: 5, icon: <Brain className="w-3.5 h-3.5" /> },
  { label: 'Infra', source: 'system:infra', w: 6, h: 4, icon: <Server className="w-3.5 h-3.5" /> },
  { label: 'Tools', source: 'system:tools', w: 5, h: 4, icon: <Wrench className="w-3.5 h-3.5" /> },
  { label: 'Settings', source: 'system:settings', w: 4, h: 6, icon: <Settings className="w-3.5 h-3.5" /> },
  { label: 'Daemon', source: 'system:daemon', w: 5, h: 5, icon: <Activity className="w-3.5 h-3.5" /> },
  { label: 'Wiki', source: 'system:memory-wiki', w: 5, h: 5, icon: <BookOpen className="w-3.5 h-3.5" /> },
  { label: 'Research', source: 'system:autoresearch', w: 5, h: 5, icon: <FlaskConical className="w-3.5 h-3.5" /> },
  { label: 'Proposals', source: 'system:self-proposals', w: 5, h: 5, icon: <GitPullRequest className="w-3.5 h-3.5" /> },
  { label: 'Overview', source: 'system:overview', w: 5, h: 4, icon: <Eye className="w-3.5 h-3.5" /> },
  { label: 'Sessions', source: 'system:sessions', w: 5, h: 4, icon: <Clock className="w-3.5 h-3.5" /> },
  { label: 'Watch', source: 'system:watch', w: 6, h: 5, icon: <Activity className="w-3.5 h-3.5" /> },
  { label: 'Backup', source: 'system:backup', w: 5, h: 5, icon: <Archive className="w-3.5 h-3.5" /> },
  { label: 'Training', source: 'system:training', w: 5, h: 5, icon: <Brain className="w-3.5 h-3.5" /> },
  { label: 'Recipes', source: 'system:recipes', w: 5, h: 5, icon: <BookOpen className="w-3.5 h-3.5" /> },
  { label: 'VRAM', source: 'system:vram', w: 5, h: 5, icon: <Cpu className="w-3.5 h-3.5" /> },
  { label: 'Teams', source: 'system:teams', w: 5, h: 5, icon: <Users className="w-3.5 h-3.5" /> },
  { label: 'Cron', source: 'system:cron', w: 5, h: 5, icon: <Clock className="w-3.5 h-3.5" /> },
  { label: 'Checkpoints', source: 'system:checkpoints', w: 5, h: 5, icon: <Save className="w-3.5 h-3.5" /> },
  { label: 'Organism', source: 'system:organism', w: 5, h: 5, icon: <Shield className="w-3.5 h-3.5" /> },
  { label: 'Fleet', source: 'system:fleet', w: 5, h: 5, icon: <Radio className="w-3.5 h-3.5" /> },
  { label: 'Browser', source: 'system:browser', w: 5, h: 5, icon: <Globe className="w-3.5 h-3.5" /> },
  { label: 'Paperclip', source: 'system:paperclip', w: 5, h: 5, icon: <PaperclipIcon className="w-3.5 h-3.5" /> },
  { label: 'Eval', source: 'system:eval', w: 5, h: 5, icon: <TestTube className="w-3.5 h-3.5" /> },
];

export function QuickLinksWidget() {
  const handleClick = (source: string, w: number, h: number) => {
    window.dispatchEvent(new CustomEvent('titan:widget:add', {
      detail: { source, w, h },
    }));
  };

  return (
    <div className="w-full h-full p-3 overflow-auto">
      <div className="grid grid-cols-2 gap-1.5">
        {LINKS.map(link => (
          <button
            key={link.source}
            onClick={() => handleClick(link.source, link.w, link.h)}
            className="flex items-center gap-2 px-2.5 py-2 rounded-lg bg-[#0a0a0f] border border-[#27272a] text-[#71717a] hover:text-[#a1a1aa] hover:border-[#3f3f46] hover:bg-[#27272a]/30 transition-all text-left"
          >
            <span className="text-[#6366f1]">{link.icon}</span>
            <span className="text-[10px] font-medium">{link.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
