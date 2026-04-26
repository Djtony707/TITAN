import { useEffect, useState } from 'react';
import { Search, Code, Globe, Zap, Wrench, Bot, Shield, Brain, Mic, BarChart3, Sparkles, ChevronRight } from 'lucide-react';
import { apiFetch } from '@/api/client';

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

/** Example prompts for the "What can TITAN do?" prompt library */
const EXAMPLE_PROMPTS = [
  { label: 'Summarize a long article', prompt: 'Find and summarize the latest article about AI safety. Include key takeaways and source links.' },
  { label: 'Build a React component', prompt: 'Build a responsive navigation bar component in React with TypeScript and Tailwind CSS.' },
  { label: 'Analyze my codebase', prompt: 'Analyze the src/ directory for code smells, security issues, and performance bottlenecks.' },
  { label: 'Plan a trip', prompt: 'Plan a 5-day trip to Tokyo. Include flights, hotels, restaurants, and daily itineraries with estimated costs.' },
  { label: 'Write an email', prompt: 'Write a professional follow-up email to a client who has not responded in 2 weeks.' },
  { label: 'Compare technologies', prompt: 'Compare PostgreSQL vs MongoDB for a real-time chat application. Give me a pros/cons table and a recommendation.' },
  { label: 'Create a cron job', prompt: 'Set up a daily cron job that checks my website uptime and sends me an alert if it goes down.' },
  { label: 'Explain a concept', prompt: 'Explain how transformer neural networks work as if I am a 12-year-old. Use analogies.' },
];

interface QuickActionsProps {
  onSelectAction: (prompt: string) => void;
  onVoiceOpen?: () => void;
  visible: boolean;
}

export function QuickActions({ onSelectAction, onVoiceOpen, visible }: QuickActionsProps) {
  const [voiceReady, setVoiceReady] = useState(true); // optimistic default
  const [showExamples, setShowExamples] = useState(false);

  useEffect(() => {
    apiFetch('/api/voice/health')
      .then(r => r.json())
      .then(d => setVoiceReady(d.overall === true))
      .catch(() => setVoiceReady(false));
  }, []);

  if (!visible) return null;

  return (
    <div className="w-full max-w-3xl mx-auto px-4 space-y-6">
      {/* Main action grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        {QUICK_ACTIONS.map((action) => (
          <button
            key={action.label}
            onClick={() => {
              if (action.prompt === '__voice__') {
                if (voiceReady && onVoiceOpen) onVoiceOpen();
                return;
              }
              onSelectAction(action.prompt);
            }}
            disabled={action.prompt === '__voice__' && !voiceReady}
            title={action.prompt === '__voice__' && !voiceReady ? 'Voice not configured — set LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET in your environment or config' : undefined}
            className={`group relative flex flex-col items-center text-center gap-2 p-4 rounded-2xl border border-border bg-gradient-to-br ${action.gradient} backdrop-blur-sm transition-all duration-200 ${
              action.prompt === '__voice__' && !voiceReady
                ? 'opacity-40 cursor-not-allowed'
                : 'hover:border-border-light hover:scale-[1.02] hover:shadow-lg hover:shadow-black/20 active:scale-[0.98]'
            }`}
          >
            <div className="flex items-center justify-center gap-2">
              <action.icon size={16} className="text-text-secondary group-hover:text-white transition-colors" />
              <span className="text-[13px] font-medium text-text group-hover:text-white">{action.label}</span>
            </div>
            <span className="text-[11px] text-text-muted leading-snug group-hover:text-white/55 transition-colors">{action.description}</span>
          </button>
        ))}
      </div>

      {/* "What can TITAN do?" prompt library */}
      <div className="rounded-2xl border border-border bg-bg-secondary/30 overflow-hidden">
        <button
          onClick={() => setShowExamples(!showExamples)}
          className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-bg-tertiary/30 transition-colors"
        >
          <div className="flex items-center gap-2">
            <Sparkles size={14} className="text-accent" />
            <span className="text-sm font-medium text-text-secondary">What can TITAN do?</span>
            <span className="text-[11px] text-text-muted hidden sm:inline">— click any example to send it</span>
          </div>
          <ChevronRight
            size={14}
            className={`text-text-muted transition-transform duration-200 ${showExamples ? 'rotate-90' : ''}`}
          />
        </button>

        {showExamples && (
          <div className="px-4 pb-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {EXAMPLE_PROMPTS.map((ex) => (
                <button
                  key={ex.label}
                  onClick={() => onSelectAction(ex.prompt)}
                  className="flex items-center gap-2 px-3 py-2.5 rounded-lg border border-border bg-bg-secondary/30 text-left hover:border-accent/30 hover:bg-accent/5 transition-all group"
                >
                  <ChevronRight size={12} className="text-text-muted group-hover:text-accent transition-colors shrink-0" />
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-text-secondary group-hover:text-text transition-colors">{ex.label}</p>
                    <p className="text-[11px] text-text-muted truncate">{ex.prompt}</p>
                  </div>
                </button>
              ))}
            </div>
            <p className="text-[11px] text-text-muted mt-3 text-center">
              These are just examples — TITAN can handle almost any task you describe in plain English.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
