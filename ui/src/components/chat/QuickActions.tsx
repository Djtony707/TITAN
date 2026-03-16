import { Search, Code, Globe, Zap, Wrench, Bot } from 'lucide-react';

interface QuickAction {
  icon: typeof Search;
  label: string;
  description: string;
  prompt: string;
  color: string;
}

const QUICK_ACTIONS: QuickAction[] = [
  {
    icon: Search,
    label: 'Research something',
    description: 'Deep research pipeline on any topic',
    prompt: 'Use the research pipeline to investigate: ',
    color: 'text-blue-400',
  },
  {
    icon: Code,
    label: 'Write & run code',
    description: 'Write, execute, and test code',
    prompt: 'Write and run code to: ',
    color: 'text-green-400',
  },
  {
    icon: Zap,
    label: 'Automate a task',
    description: 'Set up goals, cron jobs, or workflows',
    prompt: 'Help me automate: ',
    color: 'text-yellow-400',
  },
  {
    icon: Globe,
    label: 'Browse the web',
    description: 'Navigate, scrape, or fill forms',
    prompt: 'Browse to and interact with: ',
    color: 'text-cyan-400',
  },
  {
    icon: Wrench,
    label: 'Debug an issue',
    description: 'Track down and fix a problem',
    prompt: '/debug ',
    color: 'text-red-400',
  },
  {
    icon: Bot,
    label: 'Autonomous mode',
    description: 'Set a goal and let TITAN run with it',
    prompt: 'Work autonomously toward this goal: ',
    color: 'text-purple-400',
  },
];

interface QuickActionsProps {
  onSelectAction: (prompt: string) => void;
  visible: boolean;
}

export function QuickActions({ onSelectAction, visible }: QuickActionsProps) {
  if (!visible) return null;

  return (
    <div className="w-full max-w-2xl mx-auto px-4 py-6">
      <h3 className="text-sm font-medium text-[var(--text-muted)] mb-3 text-center">
        What would you like to do?
      </h3>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {QUICK_ACTIONS.map((action) => (
          <button
            key={action.label}
            onClick={() => onSelectAction(action.prompt)}
            className="flex flex-col items-start gap-1.5 p-3 rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] hover:bg-[var(--bg-tertiary)] hover:border-[var(--accent)] transition-all text-left group"
          >
            <action.icon size={18} className={`${action.color} group-hover:scale-110 transition-transform`} />
            <div>
              <div className="text-sm font-medium text-[var(--text)]">{action.label}</div>
              <div className="text-xs text-[var(--text-muted)] leading-tight">{action.description}</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
