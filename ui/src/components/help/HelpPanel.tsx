import { useState, useMemo } from 'react';
import { X, Search, BookOpen, MessageCircle, Zap, Settings, HelpCircle } from 'lucide-react';

interface HelpEntry {
  question: string;
  answer: string;
  category: string;
  keywords: string[];
}

const GLOSSARY: Record<string, string> = {
  'Provider': 'Where TITAN gets its brain — like OpenAI, Anthropic, or Ollama running on your own computer.',
  'Model': 'The specific AI brain TITAN uses (e.g., GPT-4, Claude, Llama). Different models have different strengths.',
  'Channel': 'How TITAN talks to you — through the web chat, Discord, Telegram, Slack, and more.',
  'Skill': 'Something TITAN can do — like searching the web, reading files, sending emails, or doing research.',
  'Tool': 'A specific action within a skill (e.g., the "research" skill has a "web_search" tool).',
  'Persona': 'TITAN\'s personality and communication style. Switch personas to change how TITAN talks to you.',
  'Recipe': 'A saved workflow you can run with a slash command (e.g., /research, /brainstorm).',
  'Sub-Agent': 'A helper that TITAN spawns to handle specific tasks. Like delegating work to a specialist.',
  'Gateway': 'The server that runs TITAN and serves the web interface you\'re using right now.',
  'Session': 'A conversation thread. Each session remembers context from earlier in the chat.',
  'RAG': 'Retrieval-Augmented Generation — TITAN searches your documents to give better answers.',
  'Pipeline': 'Multiple research agents working in parallel on different aspects of the same question.',
};

const FAQ: HelpEntry[] = [
  {
    question: 'How do I ask TITAN to research something?',
    answer: 'Just type your question naturally, like "Research the best AI frameworks in 2026". For deeper research, say "Use the research pipeline to investigate..." TITAN will spawn multiple agents to research in parallel.',
    category: 'Getting Started',
    keywords: ['research', 'search', 'find', 'investigate'],
  },
  {
    question: 'How do I change TITAN\'s personality?',
    answer: 'Go to Settings > Personas and pick one that fits your style. Try "Business Strategist" for professional advice or "Creative Director" for brainstorming. You can switch anytime.',
    category: 'Customization',
    keywords: ['persona', 'personality', 'style', 'tone', 'change'],
  },
  {
    question: 'What can TITAN do?',
    answer: 'TITAN can: search the web, do deep research, read/write files, run code, browse websites, send emails, manage your calendar, analyze data, generate images, and much more. Check Settings > Skills for the full list.',
    category: 'Getting Started',
    keywords: ['skills', 'capabilities', 'features', 'what'],
  },
  {
    question: 'How do I use slash commands?',
    answer: 'Type / followed by the command name. Examples: /research quantum computing, /brainstorm startup ideas, /debug my error message, /standup for daily standup. Type / to see all available commands.',
    category: 'Getting Started',
    keywords: ['slash', 'command', 'recipe', 'shortcut'],
  },
  {
    question: 'How do I connect TITAN to Discord/Telegram/Slack?',
    answer: 'Go to Settings > Channels. Each channel has a setup guide with step-by-step instructions. You\'ll need to create a bot token for the platform you want to connect.',
    category: 'Channels',
    keywords: ['discord', 'telegram', 'slack', 'connect', 'channel', 'bot'],
  },
  {
    question: 'How do I switch to a different AI model?',
    answer: 'Go to Settings > Overview and change the model. Or just tell TITAN "switch to GPT-4" or "use Claude" in the chat. Different models have different strengths and costs.',
    category: 'Customization',
    keywords: ['model', 'switch', 'change', 'gpt', 'claude', 'llama'],
  },
  {
    question: 'What is the experiment loop?',
    answer: 'The experiment loop automatically tries different approaches to optimize something — like a prompt, config, or code. It proposes changes, tests them, and keeps what works. Say "Run experiments to optimize..." to start.',
    category: 'Advanced',
    keywords: ['experiment', 'optimize', 'autoresearch', 'loop', 'test'],
  },
  {
    question: 'Does TITAN remember things between conversations?',
    answer: 'Yes! TITAN has a memory system that remembers important facts about you and your preferences. It also has a knowledge graph for storing relationships between concepts. This improves over time.',
    category: 'Features',
    keywords: ['memory', 'remember', 'forget', 'knowledge'],
  },
  {
    question: 'How do I use voice chat?',
    answer: 'Click the fluid bubble icon next to the chat input. TITAN uses LiveKit for real-time voice conversations. Make sure voice is enabled in Settings > Voice.',
    category: 'Features',
    keywords: ['voice', 'speak', 'talk', 'audio', 'microphone'],
  },
  {
    question: 'Is my data safe?',
    answer: 'TITAN runs on your own server — your data never leaves your network unless you use a cloud AI provider. Conversations, memory, and files stay on your machine.',
    category: 'Security',
    keywords: ['security', 'privacy', 'data', 'safe'],
  },
];

const CATEGORIES = ['All', 'Getting Started', 'Features', 'Customization', 'Channels', 'Advanced', 'Security'];

interface HelpPanelProps {
  open: boolean;
  onClose: () => void;
}

export function HelpPanel({ open, onClose }: HelpPanelProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<'faq' | 'glossary'>('faq');
  const [activeCategory, setActiveCategory] = useState('All');
  const [expandedFaq, setExpandedFaq] = useState<number | null>(null);

  const filteredFaq = useMemo(() => {
    let items = FAQ;
    if (activeCategory !== 'All') {
      items = items.filter((f) => f.category === activeCategory);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      items = items.filter(
        (f) =>
          f.question.toLowerCase().includes(q) ||
          f.answer.toLowerCase().includes(q) ||
          f.keywords.some((k) => k.includes(q))
      );
    }
    return items;
  }, [searchQuery, activeCategory]);

  const filteredGlossary = useMemo(() => {
    if (!searchQuery.trim()) return Object.entries(GLOSSARY);
    const q = searchQuery.toLowerCase();
    return Object.entries(GLOSSARY).filter(
      ([term, def]) => term.toLowerCase().includes(q) || def.toLowerCase().includes(q)
    );
  }, [searchQuery]);

  if (!open) return null;

  return (
    <div className="fixed inset-y-0 right-0 w-96 max-w-full bg-bg border-l border-bg-tertiary shadow-2xl z-50 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-bg-tertiary">
        <div className="flex items-center gap-2">
          <HelpCircle size={20} className="text-accent" />
          <h2 className="text-lg font-semibold text-text">Help</h2>
        </div>
        <button
          onClick={onClose}
          className="p-1 rounded-md text-text-secondary hover:text-text hover:bg-bg-tertiary transition-colors"
        >
          <X size={18} />
        </button>
      </div>

      {/* Search */}
      <div className="p-3 border-b border-bg-tertiary">
        <div className="relative">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search help..."
            className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-bg-tertiary bg-bg-secondary text-text placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-bg-tertiary">
        <button
          onClick={() => setActiveTab('faq')}
          className={`flex-1 py-2.5 text-sm font-medium transition-colors ${
            activeTab === 'faq'
              ? 'text-accent border-b-2 border-accent'
              : 'text-text-secondary hover:text-text'
          }`}
        >
          <MessageCircle size={14} className="inline mr-1.5" />
          FAQ
        </button>
        <button
          onClick={() => setActiveTab('glossary')}
          className={`flex-1 py-2.5 text-sm font-medium transition-colors ${
            activeTab === 'glossary'
              ? 'text-accent border-b-2 border-accent'
              : 'text-text-secondary hover:text-text'
          }`}
        >
          <BookOpen size={14} className="inline mr-1.5" />
          Glossary
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-3">
        {activeTab === 'faq' ? (
          <>
            {/* Category filters */}
            <div className="flex flex-wrap gap-1.5 mb-3">
              {CATEGORIES.map((cat) => (
                <button
                  key={cat}
                  onClick={() => setActiveCategory(cat)}
                  className={`px-2.5 py-1 text-xs rounded-full transition-colors ${
                    activeCategory === cat
                      ? 'bg-accent text-white'
                      : 'bg-bg-secondary text-text-secondary hover:bg-bg-tertiary'
                  }`}
                >
                  {cat}
                </button>
              ))}
            </div>

            {/* FAQ List */}
            <div className="space-y-2">
              {filteredFaq.map((faq, i) => (
                <div
                  key={i}
                  className="rounded-lg border border-bg-tertiary bg-bg-secondary overflow-hidden"
                >
                  <button
                    onClick={() => setExpandedFaq(expandedFaq === i ? null : i)}
                    className="w-full px-3 py-2.5 text-left text-sm font-medium text-text hover:bg-bg-tertiary transition-colors flex items-start gap-2"
                  >
                    <Zap size={14} className="text-accent mt-0.5 flex-shrink-0" />
                    <span>{faq.question}</span>
                  </button>
                  {expandedFaq === i && (
                    <div className="px-3 pb-3 text-sm text-text-secondary leading-relaxed border-t border-bg-tertiary pt-2 ml-6">
                      {faq.answer}
                    </div>
                  )}
                </div>
              ))}
              {filteredFaq.length === 0 && (
                <p className="text-sm text-text-muted text-center py-4">
                  No results found. Try a different search term.
                </p>
              )}
            </div>
          </>
        ) : (
          /* Glossary */
          <div className="space-y-2">
            {filteredGlossary.map(([term, definition]) => (
              <div key={term} className="rounded-lg border border-bg-tertiary bg-bg-secondary p-3">
                <div className="text-sm font-semibold text-accent mb-1">{term}</div>
                <div className="text-sm text-text-secondary leading-relaxed">{definition}</div>
              </div>
            ))}
            {filteredGlossary.length === 0 && (
              <p className="text-sm text-text-muted text-center py-4">
                No matching terms found.
              </p>
            )}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="p-3 border-t border-bg-tertiary bg-bg-secondary">
        <div className="flex items-center gap-2 text-xs text-text-muted">
          <Settings size={12} />
          <span>
            More settings at{' '}
            <a href="/settings" className="text-accent hover:underline">
              Settings
            </a>
          </span>
        </div>
      </div>
    </div>
  );
}
