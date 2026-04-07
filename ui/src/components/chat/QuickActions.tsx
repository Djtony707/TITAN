import { Search, Code, Globe, Zap, Wrench, Bot, Shield, Brain, Mic, BarChart3 } from 'lucide-react';

interface QuickAction {
  icon: typeof Search;
  label: string;
  description: string;
  prompt: string;
  gradient: string;
}

const QUICK_ACTIONS: QuickAction[] = [
  {
    icon: Brain,
    label: 'Deep Research',
    description: 'Multi-agent research pipeline with sources',
    prompt: 'Use the research pipeline to investigate: ',
    gradient: 'from-blue-500/20 to-cyan-500/20 hover:from-blue-500/30 hover:to-cyan-500/30',
  },
  {
    icon: Code,
    label: 'Write & Run Code',
    description: 'Sandbox execution with real output',
    prompt: 'Write and run code to: ',
    gradient: 'from-green-500/20 to-emerald-500/20 hover:from-green-500/30 hover:to-emerald-500/30',
  },
  {
    icon: Bot,
    label: 'Autonomous Goal',
    description: 'Set a goal — TITAN handles the rest',
    prompt: 'Work autonomously toward this goal: ',
    gradient: 'from-purple-500/20 to-violet-500/20 hover:from-purple-500/30 hover:to-violet-500/30',
  },
  {
    icon: Globe,
    label: 'Browse & Automate',
    description: 'Navigate, scrape, fill forms, solve CAPTCHAs',
    prompt: 'Browse to and interact with: ',
    gradient: 'from-cyan-500/20 to-sky-500/20 hover:from-cyan-500/30 hover:to-sky-500/30',
  },
  {
    icon: Shield,
    label: 'Command Post',
    description: 'Agent governance, budgets, task checkout',
    prompt: 'Show me the Command Post status and active agents',
    gradient: 'from-amber-500/20 to-orange-500/20 hover:from-amber-500/30 hover:to-orange-500/30',
  },
  {
    icon: Zap,
    label: 'Automate',
    description: 'Goals, cron jobs, recipes, workflows',
    prompt: 'Help me automate: ',
    gradient: 'from-yellow-500/20 to-amber-500/20 hover:from-yellow-500/30 hover:to-amber-500/30',
  },
  {
    icon: Mic,
    label: 'Voice Chat',
    description: 'Talk naturally with cloned voices',
    prompt: '__voice__',
    gradient: 'from-rose-500/20 to-pink-500/20 hover:from-rose-500/30 hover:to-pink-500/30',
  },
  {
    icon: Wrench,
    label: 'Debug',
    description: 'Root cause analysis and fixes',
    prompt: '/debug ',
    gradient: 'from-red-500/20 to-rose-500/20 hover:from-red-500/30 hover:to-rose-500/30',
  },
];

interface QuickActionsProps {
  onSelectAction: (prompt: string) => void;
  onVoiceOpen?: () => void;
  visible: boolean;
}

export function QuickActions({ onSelectAction, onVoiceOpen, visible }: QuickActionsProps) {
  if (!visible) return null;

  return (
    <div className="w-full max-w-3xl mx-auto px-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        {QUICK_ACTIONS.map((action) => (
          <button
            key={action.label}
            onClick={() => {
              if (action.prompt === '__voice__' && onVoiceOpen) {
                onVoiceOpen();
              } else {
                onSelectAction(action.prompt);
              }
            }}
            className={`group relative flex flex-col items-center text-center gap-2 p-4 rounded-2xl border border-white/[0.06] bg-gradient-to-br ${action.gradient} backdrop-blur-sm transition-all duration-200 hover:border-white/[0.12] hover:scale-[1.02] hover:shadow-lg hover:shadow-black/20 active:scale-[0.98]`}
          >
            <div className="flex items-center justify-center gap-2">
              <action.icon size={16} className="text-white/70 group-hover:text-white transition-colors" />
              <span className="text-[13px] font-medium text-white/90 group-hover:text-white">{action.label}</span>
            </div>
            <span className="text-[11px] text-white/40 leading-snug group-hover:text-white/55 transition-colors">{action.description}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
