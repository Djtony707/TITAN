import { useEffect, useState, useCallback, useRef } from 'react';
import {
  Brain,
  Play,
  RefreshCw,
  CheckCircle,
  AlertCircle,
  Clock,
  TrendingUp,
  Zap,
  Settings,
  ChevronDown,
  ChevronRight,
  Cpu,
  Trophy,
  Activity,
  Wrench,
  Bot,
  Terminal,
  Radio,
  Trash2,
  XCircle,
} from 'lucide-react';
import { getConfig, updateConfig, apiFetch } from '@/api/client';

interface ImprovementSession {
  id: string;
  area: string;
  status: string;
  startedAt: string;
  completedAt?: string;
  baselineScore: number;
  bestScore: number;
  experiments: number;
  keeps: number;
  discards: number;
  crashes: number;
  applied: boolean;
}

interface SelfImproveConfig {
  enabled: boolean;
  runsPerDay: number;
  schedule: string[];
  budgetMinutes: number;
  areas: string[];
  autoApply: boolean;
  maxDailyBudgetMinutes: number;
  pauseOnWeekends: boolean;
  notifyOnSuccess: boolean;
}

interface TrainingRun {
  id: string;
  status: string;
  baseModel: string;
  method: string;
  dataPoints: number;
  finalLoss?: number;
}

interface AutoresearchResult {
  timestamp: string;
  val_score: number;
  hyperparams: Record<string, number>;
  training_time_s: number;
  num_examples: number;
  adapter_path: string;
}

interface AutoresearchPerformance {
  totalRuns: number;
  bestScore: number;
  avgImprovement: number;
  baseline: number;
}

interface TrainingProgressEvent {
  type: 'info' | 'progress' | 'success' | 'error' | 'complete' | 'connected';
  phase?: 'generate' | 'train' | 'deploy' | 'prepare';
  message: string;
  timestamp?: string;
  detail?: {
    category?: string;
    current?: number;
    total?: number;
    pct?: number;
    model?: string;
    loss?: number;
    examples?: number;
  };
}

type TrainingType = 'tool_router' | 'main_agent';

interface TrainingConfig {
  baseModel: string;
  loraRank: number;
  learningRate: number;
  epochs: number;
  timeBudgetMin: number;
  maxSeqLength: number;
}

const AREA_LABELS: Record<string, string> = {
  prompts: 'System Prompts',
  'tool-selection': 'Tool Selection',
  'response-quality': 'Response Quality',
  'error-recovery': 'Error Recovery',
};

const SCHEDULE_PRESETS = [
  { label: 'Once daily (2am)', value: ['0 2 * * *'] },
  { label: 'Twice daily (2am + 2pm)', value: ['0 2 * * *', '0 14 * * *'] },
  { label: 'Three times (2am + 10am + 6pm)', value: ['0 2 * * *', '0 10 * * *', '0 18 * * *'] },
];

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    running: 'bg-info/10 text-info',
    completed: 'bg-success/10 text-success',
    failed: 'bg-error/10 text-error',
    training: 'bg-warning/10 text-warning',
    deployed: 'bg-purple/10 text-purple',
  };
  const dotColors: Record<string, string> = {
    running: 'bg-info',
    completed: 'bg-success',
    failed: 'bg-error',
    training: 'bg-warning',
    deployed: 'bg-purple',
  };

  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${colors[status] || 'bg-border-light/20 text-text-muted'}`}>
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${dotColors[status] || 'bg-border-light'}`} />
      {status}
    </span>
  );
}

function SelfImprovePanel() {
  const [config, setConfig] = useState<SelfImproveConfig | null>(null);
  const [history, setHistory] = useState<ImprovementSession[]>([]);
  const [trainingRuns, setTrainingRuns] = useState<TrainingRun[]>([]);
  const [arResults, setArResults] = useState<AutoresearchResult[]>([]);
  const [arPerf, setArPerf] = useState<AutoresearchPerformance | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState<string | null>(null);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [trainingType, setTrainingType] = useState<TrainingType>('tool_router');
  const [trainConfigOpen, setTrainConfigOpen] = useState(false);
  const [trainConfig, setTrainConfig] = useState<TrainingConfig>({
    baseModel: 'unsloth/Qwen2.5-32B-bnb-4bit',
    loraRank: 32,
    learningRate: 0.0001,
    epochs: 2,
    timeBudgetMin: 60,
    maxSeqLength: 2048,
  });
  const [agentResults, setAgentResults] = useState<AutoresearchResult[]>([]);
  const [agentPerf, setAgentPerf] = useState<AutoresearchPerformance | null>(null);
  const [generatingData, setGeneratingData] = useState(false);
  const [trainingModel, setTrainingModel] = useState(false);
  const [deployingModel, setDeployingModel] = useState(false);
  const [liveFeed, setLiveFeed] = useState<TrainingProgressEvent[]>([]);
  const [liveFeedOpen, setLiveFeedOpen] = useState(true);
  const [sseConnected, setSseConnected] = useState(false);
  const refreshInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const feedEndRef = useRef<HTMLDivElement | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  // Local settings state
  const [runsPerDay, setRunsPerDay] = useState(1);
  const [budgetMinutes, setBudgetMinutes] = useState(30);
  const [maxDailyBudget, setMaxDailyBudget] = useState(120);
  const [autoApply, setAutoApply] = useState(false);
  const [pauseOnWeekends, setPauseOnWeekends] = useState(false);
  const [selectedAreas, setSelectedAreas] = useState<string[]>([]);
  const [schedulePreset, setSchedulePreset] = useState(0);

  const showToast = useCallback((type: 'success' | 'error', message: string) => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 3000);
  }, []);

  const loadData = useCallback(async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cfg = await getConfig() as any;
      const si = cfg.selfImprove || {};
      setConfig(si);
      setRunsPerDay(si.runsPerDay || 1);
      setBudgetMinutes(si.budgetMinutes || 30);
      setMaxDailyBudget(si.maxDailyBudgetMinutes || 120);
      setAutoApply(si.autoApply || false);
      setPauseOnWeekends(si.pauseOnWeekends || false);
      setSelectedAreas(si.areas || ['prompts', 'tool-selection', 'response-quality', 'error-recovery']);

      // Match schedule to preset
      const schedule = si.schedule || ['0 2 * * *'];
      const presetIdx = SCHEDULE_PRESETS.findIndex(p => JSON.stringify(p.value) === JSON.stringify(schedule));
      setSchedulePreset(presetIdx >= 0 ? presetIdx : 0);

      // Fetch self-improvement history via API
      try {
        const histRes = await apiFetch('/api/self-improve/history');
        if (histRes.ok) {
          const histData = await histRes.json();
          setHistory(histData.sessions || []);
        }
      } catch { /* API may not exist yet */ }

      // Fetch training runs
      try {
        const trainRes = await apiFetch('/api/training/runs');
        if (trainRes.ok) {
          const trainData = await trainRes.json();
          setTrainingRuns(trainData.runs || []);
        }
      } catch { /* API may not exist yet */ }

      // Fetch autoresearch results & performance
      try {
        const [arRes, arPerfRes] = await Promise.all([
          apiFetch('/api/autoresearch/results'),
          apiFetch('/api/autoresearch/performance'),
        ]);
        if (arRes.ok) {
          const arData = await arRes.json();
          setArResults(arData.runs || []);
        }
        if (arPerfRes.ok) {
          const perfData = await arPerfRes.json();
          setArPerf(perfData);
        }
      } catch { /* API may not exist yet */ }

      // Fetch agent autoresearch results & performance
      try {
        const [agentRes, agentPerfRes] = await Promise.all([
          apiFetch('/api/autoresearch/results?type=agent'),
          apiFetch('/api/autoresearch/performance?type=agent'),
        ]);
        if (agentRes.ok) {
          const data = await agentRes.json();
          setAgentResults(data.runs || []);
        }
        if (agentPerfRes.ok) {
          const data = await agentPerfRes.json();
          setAgentPerf(data);
        }
      } catch { /* API may not exist yet */ }

    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // Auto-refresh every 10s when enabled
  useEffect(() => {
    if (autoRefresh) {
      refreshInterval.current = setInterval(loadData, 10000);
    }
    return () => {
      if (refreshInterval.current) clearInterval(refreshInterval.current);
    };
  }, [autoRefresh, loadData]);

  // SSE connection for live training progress
  useEffect(() => {
    const es = new EventSource('/api/training/stream');
    eventSourceRef.current = es;

    es.onopen = () => setSseConnected(true);
    es.onerror = () => setSseConnected(false);

    es.onmessage = (e) => {
      try {
        const event: TrainingProgressEvent = JSON.parse(e.data);
        if (event.type === 'connected') {
          setSseConnected(true);
          return;
        }
        setLiveFeed(prev => {
          const next = [...prev, event];
          // Keep last 200 events
          return next.length > 200 ? next.slice(-200) : next;
        });
      } catch { /* ignore parse errors */ }
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
      setSseConnected(false);
    };
  }, []);

  // Auto-scroll live feed
  useEffect(() => {
    if (feedEndRef.current && liveFeedOpen) {
      feedEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [liveFeed, liveFeedOpen]);

  const clearLiveFeed = useCallback(async () => {
    try {
      await apiFetch('/api/training/progress', { method: 'DELETE' });
      setLiveFeed([]);
    } catch { /* ignore */ }
  }, []);

  const handleSaveSettings = async () => {
    try {
      await updateConfig({
        selfImprove: {
          runsPerDay,
          budgetMinutes,
          maxDailyBudgetMinutes: maxDailyBudget,
          autoApply,
          pauseOnWeekends,
          areas: selectedAreas,
          schedule: SCHEDULE_PRESETS[schedulePreset]?.value || ['0 2 * * *'],
        },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
      showToast('success', 'Self-improvement settings saved');
      await loadData();
    } catch (e) {
      showToast('error', e instanceof Error ? e.message : 'Failed to save');
    }
  };

  const handleStartRun = async (area: string) => {
    setRunning(area);
    try {
      const res = await apiFetch('/api/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: `Run a self-improvement experiment on ${area} using self_improve_start with area="${area}" and budgetMinutes=${budgetMinutes}`,
          sessionId: 'self-improve',
        }),
      });
      if (res.ok) {
        showToast('success', `Self-improvement started for ${AREA_LABELS[area] || area}`);
        setTimeout(loadData, 2000);
      } else {
        showToast('error', 'Failed to start self-improvement');
      }
    } catch (e) {
      showToast('error', e instanceof Error ? e.message : 'Failed to start');
    } finally {
      setRunning(null);
    }
  };

  const toggleArea = (area: string) => {
    setSelectedAreas(prev =>
      prev.includes(area) ? prev.filter(a => a !== area) : [...prev, area]
    );
  };

  const handleGenerateData = async () => {
    setGeneratingData(true);
    try {
      const res = await apiFetch('/api/autoresearch/generate-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: trainingType }),
      });
      if (res.ok) showToast('success', `Training data generation started for ${trainingType === 'main_agent' ? 'Main Agent' : 'Tool Router'}`);
      else showToast('error', 'Failed to start data generation');
    } catch (e) {
      showToast('error', e instanceof Error ? e.message : 'Failed');
    } finally {
      setGeneratingData(false);
    }
  };

  const handleStartTraining = async () => {
    setTrainingModel(true);
    try {
      const res = await apiFetch('/api/autoresearch/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: trainingType, config: trainConfig }),
      });
      if (res.ok) showToast('success', `Training started for ${trainingType === 'main_agent' ? 'Main Agent' : 'Tool Router'}`);
      else showToast('error', 'Failed to start training');
    } catch (e) {
      showToast('error', e instanceof Error ? e.message : 'Failed');
    } finally {
      setTrainingModel(false);
    }
  };

  const handleDeployModel = async () => {
    setDeployingModel(true);
    try {
      const res = await apiFetch('/api/autoresearch/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: trainingType }),
      });
      if (res.ok) showToast('success', `Model deployed as ${trainingType === 'main_agent' ? 'titan-agent' : 'titan-qwen'}`);
      else showToast('error', 'Failed to deploy model');
    } catch (e) {
      showToast('error', e instanceof Error ? e.message : 'Failed');
    } finally {
      setDeployingModel(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-20 animate-pulse rounded-xl border border-border bg-bg-secondary" />
        ))}
      </div>
    );
  }

  // Compute aggregate stats
  const totalSessions = history.length;
  const avgImprovement = totalSessions > 0
    ? (history.reduce((sum, s) => sum + (s.bestScore - s.baselineScore), 0) / totalSessions).toFixed(1)
    : '0';
  const successRate = totalSessions > 0
    ? ((history.filter(s => s.bestScore > s.baselineScore).length / totalSessions) * 100).toFixed(0)
    : '0';

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-purple/10">
            <Brain className="h-4 w-4 text-purple-light" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-text">Self-Improvement</h1>
            <p className="text-xs text-text-muted">Autonomous optimization of prompts, tool selection, and response quality</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setAutoRefresh(!autoRefresh)}
            className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs transition-colors ${
              autoRefresh
                ? 'border-success/30 text-success bg-success/5'
                : 'border-border text-text-muted hover:bg-bg-tertiary'
            }`}
          >
            <Activity className={`h-3.5 w-3.5 ${autoRefresh ? 'animate-pulse' : ''}`} />
            {autoRefresh ? 'Live' : 'Paused'}
          </button>
          <button
            onClick={loadData}
            className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-text-secondary transition-colors hover:bg-bg-tertiary"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div className={`flex items-center gap-2 rounded-lg border px-4 py-2 text-sm ${
          toast.type === 'success'
            ? 'border-success/50 text-success'
            : 'border-error/50 text-error'
        }`}>
          {toast.type === 'success' ? <CheckCircle className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
          {toast.message}
        </div>
      )}

      {/* Stats Cards */}
      <div className="grid grid-cols-4 gap-3">
        <div className="rounded-xl border border-bg-tertiary bg-bg-secondary p-4">
          <div className="flex items-center gap-2 mb-1">
            <Clock className="h-3.5 w-3.5 text-text-muted" />
            <p className="text-xs text-text-muted">Total Sessions</p>
          </div>
          <p className="text-2xl font-bold text-text">{totalSessions + (arPerf?.totalRuns || 0)}</p>
          {arPerf && arPerf.totalRuns > 0 && (
            <p className="text-[10px] text-text-muted mt-0.5">{totalSessions} self-improve + {arPerf.totalRuns} autoresearch</p>
          )}
        </div>
        <div className="rounded-xl border border-bg-tertiary bg-bg-secondary p-4">
          <div className="flex items-center gap-2 mb-1">
            <Trophy className="h-3.5 w-3.5 text-warning" />
            <p className="text-xs text-text-muted">Best Val Score</p>
          </div>
          <p className="text-2xl font-bold text-warning">{arPerf?.bestScore || '—'}</p>
          {arPerf && arPerf.baseline > 0 && (() => {
            const delta = arPerf.bestScore - arPerf.baseline;
            const sign = delta >= 0 ? '+' : ''; // negatives already carry '-'
            const tone = delta >= 0 ? 'text-success' : 'text-error';
            return (
              <p className={`text-[10px] mt-0.5 ${tone}`}>{sign}{delta.toFixed(1)} from {arPerf.baseline} baseline</p>
            );
          })()}
        </div>
        <div className="rounded-xl border border-bg-tertiary bg-bg-secondary p-4">
          <div className="flex items-center gap-2 mb-1">
            <TrendingUp className="h-3.5 w-3.5 text-success" />
            <p className="text-xs text-text-muted">Success Rate</p>
          </div>
          <p className="text-2xl font-bold text-info">{successRate}%</p>
          <p className="text-[10px] text-text-muted mt-0.5">avg improvement: {Number(avgImprovement) >= 0 ? '+' : ''}{avgImprovement}</p>
        </div>
        <div className="rounded-xl border border-bg-tertiary bg-bg-secondary p-4">
          <div className="flex items-center gap-2 mb-1">
            <Cpu className="h-3.5 w-3.5 text-purple" />
            <p className="text-xs text-text-muted">Deployed Model</p>
          </div>
          <p className="text-lg font-bold text-purple">titan-qwen</p>
          <p className="text-[10px] text-text-muted mt-0.5">Q4_K_M • 19GB • {config?.enabled !== false ? '🟢 Active' : '⚫ Off'}</p>
        </div>
      </div>

      {/* Model Training */}
      <div>
        <p className="text-xs font-medium uppercase tracking-wider text-text-muted mb-3">Model Training</p>

        {/* Training Type Selector — two cards side by side */}
        <div className="grid grid-cols-2 gap-3 mb-4">
          <button
            onClick={() => setTrainingType('tool_router')}
            className={`rounded-xl border p-4 text-left transition-all ${
              trainingType === 'tool_router'
                ? 'border-purple bg-purple/5 ring-1 ring-purple/20'
                : 'border-bg-tertiary bg-bg-secondary hover:border-border'
            }`}
          >
            <div className="flex items-center gap-2 mb-2">
              <div className={`flex h-7 w-7 items-center justify-center rounded-lg ${trainingType === 'tool_router' ? 'bg-purple/20' : 'bg-bg-tertiary'}`}>
                <Wrench className={`h-3.5 w-3.5 ${trainingType === 'tool_router' ? 'text-purple-light' : 'text-text-muted'}`} />
              </div>
              <span className={`text-sm font-medium ${trainingType === 'tool_router' ? 'text-text' : 'text-text-secondary'}`}>Tool Router</span>
            </div>
            <p className="text-xs text-text-muted mb-1">titan-qwen</p>
            <div className="flex items-center gap-2">
              <span className="text-xs text-success font-medium">Score: {arPerf?.bestScore || '—'}</span>
              <span className="text-[10px] text-text-muted">•</span>
              <span className="text-[10px] text-text-muted">{arResults.length > 0 ? `${arResults[arResults.length - 1]?.num_examples || 0} examples` : 'No data'}</span>
            </div>
            <p className="text-[10px] text-text-muted mt-1">Brain / Tool Selection</p>
          </button>

          <button
            onClick={() => setTrainingType('main_agent')}
            className={`rounded-xl border p-4 text-left transition-all ${
              trainingType === 'main_agent'
                ? 'border-purple bg-purple/5 ring-1 ring-purple/20'
                : 'border-bg-tertiary bg-bg-secondary hover:border-border'
            }`}
          >
            <div className="flex items-center gap-2 mb-2">
              <div className={`flex h-7 w-7 items-center justify-center rounded-lg ${trainingType === 'main_agent' ? 'bg-purple/20' : 'bg-bg-tertiary'}`}>
                <Bot className={`h-3.5 w-3.5 ${trainingType === 'main_agent' ? 'text-purple-light' : 'text-text-muted'}`} />
              </div>
              <span className={`text-sm font-medium ${trainingType === 'main_agent' ? 'text-text' : 'text-text-secondary'}`}>Main Agent</span>
            </div>
            <p className="text-xs text-text-muted mb-1">titan-agent</p>
            <div className="flex items-center gap-2">
              <span className="text-xs text-warning font-medium">Score: {agentPerf?.bestScore || '—'}</span>
              <span className="text-[10px] text-text-muted">•</span>
              <span className="text-[10px] text-text-muted">{agentResults.length > 0 ? `${agentResults[agentResults.length - 1]?.num_examples || 0} examples` : 'No data'}</span>
            </div>
            <p className="text-[10px] text-text-muted mt-1">Primary LLM / Full Agent</p>
          </button>
        </div>

        {/* Training Configuration — collapsible */}
        <button
          onClick={() => setTrainConfigOpen(!trainConfigOpen)}
          className="flex w-full items-center gap-2 text-xs font-medium uppercase tracking-wider text-text-muted mb-3"
        >
          {trainConfigOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          <Settings className="h-3.5 w-3.5" />
          Training Configuration
        </button>

        {trainConfigOpen && (
          <div className="rounded-xl border border-bg-tertiary bg-bg-secondary p-5 space-y-4 mb-4">
            {/* Base Model */}
            <div>
              <label className="mb-1 block text-xs text-text-muted">Base Model</label>
              <select
                id="train-base-model"
                name="train-base-model"
                value={trainConfig.baseModel}
                onChange={(e) => setTrainConfig(prev => ({ ...prev, baseModel: e.target.value }))}
                className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text outline-none"
              >
                <option value="unsloth/Qwen2.5-32B-bnb-4bit">Qwen 2.5 32B (4-bit)</option>
                <option value="unsloth/Qwen2.5-14B-bnb-4bit">Qwen 2.5 14B (4-bit)</option>
                <option value="unsloth/Qwen2.5-7B-bnb-4bit">Qwen 2.5 7B (4-bit)</option>
              </select>
            </div>

            {/* LoRA Rank */}
            <div>
              <label className="flex items-center justify-between mb-2">
                <span className="text-xs text-text-muted">LoRA Rank</span>
                <span className="text-sm font-medium text-text">{trainConfig.loraRank}</span>
              </label>
              <input
                id="train-lora-rank"
                name="train-lora-rank"
                type="range"
                min={4}
                max={64}
                step={4}
                value={trainConfig.loraRank}
                onChange={(e) => setTrainConfig(prev => ({ ...prev, loraRank: Number(e.target.value) }))}
                className="w-full accent-purple"
              />
              <div className="flex justify-between text-[10px] text-text-muted mt-1">
                <span>4</span><span>32</span><span>64</span>
              </div>
            </div>

            {/* Learning Rate */}
            <div>
              <label className="flex items-center justify-between mb-2">
                <span className="text-xs text-text-muted">Learning Rate</span>
                <span className="text-sm font-medium text-text font-mono">{trainConfig.learningRate.toExponential(0)}</span>
              </label>
              <input
                id="train-learning-rate"
                name="train-learning-rate"
                type="range"
                min={-5}
                max={-3}
                step={0.5}
                value={Math.log10(trainConfig.learningRate)}
                onChange={(e) => setTrainConfig(prev => ({ ...prev, learningRate: Math.pow(10, Number(e.target.value)) }))}
                className="w-full accent-purple"
              />
              <div className="flex justify-between text-[10px] text-text-muted mt-1">
                <span>1e-5</span><span>1e-4</span><span>1e-3</span>
              </div>
            </div>

            {/* Epochs */}
            <div>
              <label className="flex items-center justify-between mb-2">
                <span className="text-xs text-text-muted">Epochs</span>
                <span className="text-sm font-medium text-text">{trainConfig.epochs}</span>
              </label>
              <input
                id="train-epochs"
                name="train-epochs"
                type="range"
                min={1}
                max={10}
                value={trainConfig.epochs}
                onChange={(e) => setTrainConfig(prev => ({ ...prev, epochs: Number(e.target.value) }))}
                className="w-full accent-purple"
              />
              <div className="flex justify-between text-[10px] text-text-muted mt-1">
                <span>1</span><span>5</span><span>10</span>
              </div>
            </div>

            {/* Time Budget */}
            <div>
              <label className="flex items-center justify-between mb-2">
                <span className="text-xs text-text-muted">Time Budget</span>
                <span className="text-sm font-medium text-text">{trainConfig.timeBudgetMin} min</span>
              </label>
              <input
                id="train-time-budget"
                name="train-time-budget"
                type="range"
                min={5}
                max={120}
                step={5}
                value={trainConfig.timeBudgetMin}
                onChange={(e) => setTrainConfig(prev => ({ ...prev, timeBudgetMin: Number(e.target.value) }))}
                className="w-full accent-purple"
              />
              <div className="flex justify-between text-[10px] text-text-muted mt-1">
                <span>5 min</span><span>60 min</span><span>120 min</span>
              </div>
            </div>

            {/* Max Seq Length */}
            <div>
              <label className="flex items-center justify-between mb-2">
                <span className="text-xs text-text-muted">Max Sequence Length</span>
                <span className="text-sm font-medium text-text">{trainConfig.maxSeqLength}</span>
              </label>
              <input
                id="train-max-seq-length"
                name="train-max-seq-length"
                type="range"
                min={512}
                max={4096}
                step={256}
                value={trainConfig.maxSeqLength}
                onChange={(e) => setTrainConfig(prev => ({ ...prev, maxSeqLength: Number(e.target.value) }))}
                className="w-full accent-purple"
              />
              <div className="flex justify-between text-[10px] text-text-muted mt-1">
                <span>512</span><span>2048</span><span>4096</span>
              </div>
            </div>
          </div>
        )}

        {/* Action Buttons */}
        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={handleGenerateData}
            disabled={generatingData}
            className="flex items-center justify-center gap-2 rounded-xl border border-bg-tertiary bg-bg-secondary px-4 py-3 text-xs font-medium text-text transition-colors hover:border-purple/50 hover:bg-bg-secondary disabled:opacity-50"
          >
            {generatingData ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5 text-warning" />}
            Generate Training Data
          </button>
          <button
            onClick={handleStartTraining}
            disabled={trainingModel}
            className="flex items-center justify-center gap-2 rounded-xl bg-purple px-4 py-3 text-xs font-medium text-white transition-colors hover:bg-purple/80 disabled:opacity-50"
          >
            {trainingModel ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
            Start Training
          </button>
          <button
            onClick={handleDeployModel}
            disabled={deployingModel}
            className="flex items-center justify-center gap-2 rounded-xl border border-bg-tertiary bg-bg-secondary px-4 py-3 text-xs font-medium text-text transition-colors hover:border-success/50 hover:bg-bg-secondary disabled:opacity-50"
          >
            {deployingModel ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle className="h-3.5 w-3.5 text-success" />}
            Deploy Best Model
          </button>
          <button
            onClick={() => handleStartRun(trainingType === 'main_agent' ? 'agent-benchmark' : 'tool-benchmark')}
            disabled={running !== null}
            className="flex items-center justify-center gap-2 rounded-xl border border-bg-tertiary bg-bg-secondary px-4 py-3 text-xs font-medium text-text transition-colors hover:border-[#3b82f6]/50 hover:bg-bg-secondary disabled:opacity-50"
          >
            <TrendingUp className="h-3.5 w-3.5 text-info" />
            Run Benchmark
          </button>
        </div>
      </div>

      {/* Live Training Feed */}
      <div>
        <button
          onClick={() => setLiveFeedOpen(!liveFeedOpen)}
          className="flex w-full items-center gap-2 text-xs font-medium uppercase tracking-wider text-text-muted mb-3"
        >
          {liveFeedOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          <Terminal className="h-3.5 w-3.5" />
          Live Training Activity
          <span className="ml-auto flex items-center gap-1.5">
            {sseConnected ? (
              <span className="flex items-center gap-1 text-[10px] text-success">
                <Radio className="h-3 w-3 animate-pulse" /> Connected
              </span>
            ) : (
              <span className="flex items-center gap-1 text-[10px] text-error">
                <XCircle className="h-3 w-3" /> Disconnected
              </span>
            )}
            {liveFeed.length > 0 && (
              <span className="rounded-full bg-purple/20 px-1.5 py-0.5 text-[10px] text-purple-light">
                {liveFeed.length}
              </span>
            )}
          </span>
        </button>

        {liveFeedOpen && (
          <div className="rounded-xl border border-bg-tertiary bg-bg overflow-hidden">
            {/* Progress bar (if generating) */}
            {liveFeed.length > 0 && (() => {
              const last = [...liveFeed].reverse().find(e => e.detail?.pct !== undefined);
              if (!last || last.type === 'complete') return null;
              const pct = last.detail?.pct || 0;
              return (
                <div className="border-b border-bg-tertiary px-4 py-3">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-xs text-text-secondary">{last.message}</span>
                    <span className="text-xs font-medium text-purple">{pct}%</span>
                  </div>
                  <div className="h-1.5 w-full rounded-full bg-bg-tertiary overflow-hidden">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-purple to-accent transition-all duration-500"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  {last.detail?.current !== undefined && last.detail?.total !== undefined && (
                    <div className="flex items-center justify-between mt-1">
                      <span className="text-[10px] text-text-muted">{last.detail.current} / {last.detail.total} examples</span>
                      {last.detail.category && (
                        <span className="text-[10px] text-text-muted">Category: {last.detail.category}</span>
                      )}
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Feed log */}
            <div className="max-h-64 overflow-y-auto p-3 font-mono text-[11px] leading-5 scrollbar-thin">
              {liveFeed.length === 0 ? (
                <div className="flex items-center justify-center py-8 text-text-muted">
                  <Activity className="h-4 w-4 mr-2" />
                  <span>No training activity yet. Start training to see live progress.</span>
                </div>
              ) : (
                liveFeed.map((event, i) => {
                  const colorMap: Record<string, string> = {
                    info: 'text-info',
                    progress: 'text-purple',
                    success: 'text-success',
                    error: 'text-error',
                    complete: 'text-warning',
                    connected: 'text-success',
                  };
                  const iconMap: Record<string, string> = {
                    info: '●',
                    progress: '◆',
                    success: '✓',
                    error: '✗',
                    complete: '★',
                    connected: '◉',
                  };
                  const iconColor = colorMap[event.type] || 'text-text-muted';
                  const icon = iconMap[event.type] || '·';
                  const time = event.timestamp
                    ? new Date(event.timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
                    : '';

                  return (
                    <div key={i} className="flex items-start gap-2 hover:bg-bg-secondary/50 rounded px-1">
                      <span className="text-border shrink-0 select-none">{time}</span>
                      <span className={`shrink-0 ${iconColor}`}>{icon}</span>
                      <span className={`${event.type === 'error' ? 'text-error' : 'text-text-secondary'}`}>
                        {event.message}
                        {event.detail?.category && event.type === 'progress' && (
                          <span className="text-text-muted"> [{event.detail.category}]</span>
                        )}
                      </span>
                    </div>
                  );
                })
              )}
              <div ref={feedEndRef} />
            </div>

            {/* Feed footer */}
            {liveFeed.length > 0 && (
              <div className="border-t border-bg-tertiary px-3 py-2 flex items-center justify-between">
                <span className="text-[10px] text-text-muted">
                  {liveFeed.filter(e => e.type === 'success' || e.type === 'progress').length} successes
                  {' · '}
                  {liveFeed.filter(e => e.type === 'error').length} errors
                </span>
                <button
                  onClick={clearLiveFeed}
                  className="flex items-center gap-1 text-[10px] text-text-muted hover:text-text-secondary transition-colors"
                >
                  <Trash2 className="h-3 w-3" />
                  Clear
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Quick Actions — Run Now */}
      <div>
        <p className="text-xs font-medium uppercase tracking-wider text-text-muted mb-3">Run Now</p>
        <div className="grid grid-cols-2 gap-3">
          {Object.entries(AREA_LABELS).map(([id, label]) => (
            <button
              key={id}
              onClick={() => handleStartRun(id)}
              disabled={running !== null}
              className="flex items-center gap-3 rounded-xl border border-bg-tertiary bg-bg-secondary p-4 text-left transition-colors hover:border-purple/50 hover:bg-bg-secondary disabled:opacity-50"
            >
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-purple/10">
                {running === id ? (
                  <RefreshCw className="h-4 w-4 text-purple-light animate-spin" />
                ) : (
                  <Play className="h-4 w-4 text-purple-light" />
                )}
              </div>
              <div>
                <p className="text-sm font-medium text-text">{label}</p>
                <p className="text-xs text-text-muted">{running === id ? 'Running...' : 'Start experiment'}</p>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Schedule Settings */}
      <div>
        <button
          onClick={() => setSettingsOpen(!settingsOpen)}
          className="flex w-full items-center gap-2 text-xs font-medium uppercase tracking-wider text-text-muted mb-3"
        >
          {settingsOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          <Settings className="h-3.5 w-3.5" />
          Schedule Settings
        </button>

        {settingsOpen && (
          <div className="rounded-xl border border-bg-tertiary bg-bg-secondary p-6 space-y-5">
            {/* Runs per day */}
            <div>
              <label className="flex items-center justify-between mb-2">
                <span className="text-xs text-text-muted">Runs per day</span>
                <span className="text-sm font-medium text-text">{runsPerDay}</span>
              </label>
              <input
                id="schedule-runs-per-day"
                name="schedule-runs-per-day"
                type="range"
                min={1}
                max={12}
                value={runsPerDay}
                onChange={(e) => setRunsPerDay(Number(e.target.value))}
                className="w-full accent-purple"
              />
              <div className="flex justify-between text-[10px] text-text-muted mt-1">
                <span>1</span><span>6</span><span>12</span>
              </div>
            </div>

            {/* Schedule preset */}
            <div>
              <label className="mb-1 block text-xs text-text-muted">Schedule</label>
              <select
                id="schedule-preset"
                name="schedule-preset"
                value={schedulePreset}
                onChange={(e) => setSchedulePreset(Number(e.target.value))}
                className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text outline-none"
              >
                {SCHEDULE_PRESETS.map((preset, i) => (
                  <option key={i} value={i}>{preset.label}</option>
                ))}
              </select>
            </div>

            {/* Budget per run */}
            <div>
              <label className="flex items-center justify-between mb-2">
                <span className="text-xs text-text-muted">Budget per run (minutes)</span>
                <span className="text-sm font-medium text-text">{budgetMinutes} min</span>
              </label>
              <input
                id="schedule-budget-minutes"
                name="schedule-budget-minutes"
                type="range"
                min={5}
                max={120}
                step={5}
                value={budgetMinutes}
                onChange={(e) => setBudgetMinutes(Number(e.target.value))}
                className="w-full accent-purple"
              />
              <div className="flex justify-between text-[10px] text-text-muted mt-1">
                <span>5 min</span><span>60 min</span><span>120 min</span>
              </div>
            </div>

            {/* Max daily budget */}
            <div>
              <label className="flex items-center justify-between mb-2">
                <span className="text-xs text-text-muted">Max daily budget (minutes)</span>
                <span className="text-sm font-medium text-text">{maxDailyBudget} min</span>
              </label>
              <input
                id="schedule-max-daily-budget"
                name="schedule-max-daily-budget"
                type="range"
                min={30}
                max={480}
                step={30}
                value={maxDailyBudget}
                onChange={(e) => setMaxDailyBudget(Number(e.target.value))}
                className="w-full accent-purple"
              />
            </div>

            {/* Areas toggle */}
            <div>
              <label className="mb-2 block text-xs text-text-muted">Improvement areas</label>
              <div className="flex flex-wrap gap-2">
                {Object.entries(AREA_LABELS).map(([id, label]) => (
                  <button
                    key={id}
                    onClick={() => toggleArea(id)}
                    className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                      selectedAreas.includes(id)
                        ? 'bg-purple text-white'
                        : 'bg-bg-tertiary text-text-muted hover:text-text-secondary'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* Toggles */}
            <div className="space-y-3">
              <label className="flex items-center justify-between">
                <span className="text-xs text-text-muted">Auto-apply improvements</span>
                <button
                  onClick={() => setAutoApply(!autoApply)}
                  className={`relative h-5 w-9 rounded-full transition-colors ${autoApply ? 'bg-purple' : 'bg-border'}`}
                >
                  <span className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white transition-transform ${autoApply ? 'translate-x-4' : ''}`} />
                </button>
              </label>
              <label className="flex items-center justify-between">
                <span className="text-xs text-text-muted">Pause on weekends</span>
                <button
                  onClick={() => setPauseOnWeekends(!pauseOnWeekends)}
                  className={`relative h-5 w-9 rounded-full transition-colors ${pauseOnWeekends ? 'bg-purple' : 'bg-border'}`}
                >
                  <span className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white transition-transform ${pauseOnWeekends ? 'translate-x-4' : ''}`} />
                </button>
              </label>
            </div>

            {/* Save */}
            <div className="flex justify-end">
              <button
                onClick={handleSaveSettings}
                className="flex items-center gap-2 rounded-lg bg-purple px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-purple/80"
              >
                Save Settings
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Session History */}
      {history.length > 0 && (
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-text-muted mb-3">Session History</p>
          <div className="rounded-xl border border-bg-tertiary bg-bg-secondary overflow-hidden">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-bg-tertiary">
                  <th className="px-4 py-2.5 text-xs font-medium text-text-muted">Date</th>
                  <th className="px-4 py-2.5 text-xs font-medium text-text-muted">Area</th>
                  <th className="px-4 py-2.5 text-xs font-medium text-text-muted">Baseline</th>
                  <th className="px-4 py-2.5 text-xs font-medium text-text-muted">Best</th>
                  <th className="px-4 py-2.5 text-xs font-medium text-text-muted">+Δ</th>
                  <th className="px-4 py-2.5 text-xs font-medium text-text-muted">K/D/C</th>
                  <th className="px-4 py-2.5 text-xs font-medium text-text-muted">Status</th>
                </tr>
              </thead>
              <tbody>
                {history.slice().reverse().slice(0, 10).map((session) => {
                  const imp = session.bestScore - session.baselineScore;
                  return (
                    <tr key={session.id} className="border-b border-bg-tertiary last:border-0">
                      <td className="px-4 py-2.5 text-xs text-text-secondary">
                        {session.startedAt.slice(0, 10)}
                      </td>
                      <td className="px-4 py-2.5 text-xs text-text">
                        {AREA_LABELS[session.area] || session.area}
                      </td>
                      <td className="px-4 py-2.5 text-xs text-text-muted">{session.baselineScore}</td>
                      <td className="px-4 py-2.5 text-xs text-text font-medium">{session.bestScore}</td>
                      <td className={`px-4 py-2.5 text-xs font-medium ${imp > 0 ? 'text-success' : 'text-text-muted'}`}>
                        {imp > 0 ? '+' : ''}{imp}
                      </td>
                      <td className="px-4 py-2.5 text-xs text-text-muted">
                        {session.keeps}/{session.discards}/{session.crashes}
                      </td>
                      <td className="px-4 py-2.5">
                        <StatusBadge status={session.applied ? 'deployed' : session.status} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Training Runs */}
      {trainingRuns.length > 0 && (
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-text-muted mb-3">Model Training</p>
          <div className="space-y-2">
            {trainingRuns.slice().reverse().slice(0, 5).map((run) => (
              <div key={run.id} className="flex items-center justify-between rounded-xl border border-bg-tertiary bg-bg-secondary px-4 py-3">
                <div className="flex items-center gap-3">
                  <Zap className="h-4 w-4 text-warning" />
                  <div>
                    <p className="text-sm font-medium text-text">{run.id}</p>
                    <p className="text-xs text-text-muted">{run.baseModel} • {run.dataPoints} samples • {run.method}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  {run.finalLoss !== undefined && (
                    <span className="text-xs text-text-muted">loss: {run.finalLoss.toFixed(4)}</span>
                  )}
                  <StatusBadge status={run.status} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Autoresearch Experiments (Tool Router) */}
      {arResults.length > 0 && trainingType === 'tool_router' && (
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-text-muted mb-3">Autoresearch Experiments — Tool Router</p>
          <div className="rounded-xl border border-bg-tertiary bg-bg-secondary overflow-hidden">
            {/* Mini performance chart */}
            <div className="p-4 border-b border-bg-tertiary">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-text-muted">Val Score Over Time</span>
                <span className="text-xs text-success font-medium">
                  Best: {arPerf?.bestScore || Math.max(...arResults.map(r => r.val_score))}
                </span>
              </div>
              <div className="h-16 flex items-end gap-1">
                {arResults.map((r, i) => {
                  const maxScore = Math.max(...arResults.map(r => r.val_score), 100);
                  const minScore = Math.min(...arResults.map(r => r.val_score), 0);
                  const range = maxScore - minScore || 1;
                  const height = ((r.val_score - minScore) / range) * 100;
                  return (
                    <div
                      key={i}
                      className="flex-1 rounded-t transition-all hover:opacity-80"
                      style={{
                        height: `${Math.max(height, 4)}%`,
                        backgroundColor: arPerf?.baseline != null ? (r.val_score >= arPerf.baseline ? 'var(--color-success)' : 'var(--color-error)') : 'var(--color-purple)',
                      }}
                      title={`Run ${i + 1}: ${r.val_score} (${new Date(r.timestamp).toLocaleDateString()})`}
                    />
                  );
                })}
              </div>
              {/* Baseline line */}
              <div className="relative mt-1">
                <div className="border-t border-dashed border-border-light/50 absolute w-full" />
                <span className="text-[9px] text-text-muted relative -top-2">{arPerf?.baseline != null ? `baseline: ${arPerf.baseline}` : 'baseline: —'}</span>
              </div>
            </div>

            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-bg-tertiary">
                  <th className="px-4 py-2.5 text-xs font-medium text-text-muted">#</th>
                  <th className="px-4 py-2.5 text-xs font-medium text-text-muted">Date</th>
                  <th className="px-4 py-2.5 text-xs font-medium text-text-muted">Score</th>
                  <th className="px-4 py-2.5 text-xs font-medium text-text-muted">LR</th>
                  <th className="px-4 py-2.5 text-xs font-medium text-text-muted">Rank</th>
                  <th className="px-4 py-2.5 text-xs font-medium text-text-muted">Epochs</th>
                  <th className="px-4 py-2.5 text-xs font-medium text-text-muted">Examples</th>
                  <th className="px-4 py-2.5 text-xs font-medium text-text-muted">Duration</th>
                </tr>
              </thead>
              <tbody>
                {arResults.slice().reverse().slice(0, 20).map((r, i) => (
                  <tr key={i} className="border-b border-bg-tertiary last:border-0">
                    <td className="px-4 py-2.5 text-xs text-text-muted">{arResults.length - i}</td>
                    <td className="px-4 py-2.5 text-xs text-text-secondary">
                      {new Date(r.timestamp).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </td>
                    <td className={`px-4 py-2.5 text-xs font-bold ${r.val_score >= (arPerf?.baseline || 78) ? 'text-success' : 'text-error'}`}>
                      {r.val_score}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-text-muted font-mono">{r.hyperparams.lr}</td>
                    <td className="px-4 py-2.5 text-xs text-text-muted">{r.hyperparams.rank}</td>
                    <td className="px-4 py-2.5 text-xs text-text-muted">{r.hyperparams.epochs}</td>
                    <td className="px-4 py-2.5 text-xs text-text-muted">{r.num_examples}</td>
                    <td className="px-4 py-2.5 text-xs text-text-muted">{Math.round(r.training_time_s / 60)}m {Math.round(r.training_time_s % 60)}s</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Autoresearch Experiments (Main Agent) */}
      {agentResults.length > 0 && trainingType === 'main_agent' && (
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-text-muted mb-3">Autoresearch Experiments — Main Agent</p>
          <div className="rounded-xl border border-bg-tertiary bg-bg-secondary overflow-hidden">
            {/* Mini performance chart */}
            <div className="p-4 border-b border-bg-tertiary">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-text-muted">Val Score Over Time</span>
                <span className="text-xs text-warning font-medium">
                  Best: {agentPerf?.bestScore || Math.max(...agentResults.map(r => r.val_score))}
                </span>
              </div>
              <div className="h-16 flex items-end gap-1">
                {agentResults.map((r, i) => {
                  const maxScore = Math.max(...agentResults.map(r => r.val_score), 100);
                  const minScore = Math.min(...agentResults.map(r => r.val_score), 0);
                  const range = maxScore - minScore || 1;
                  const height = ((r.val_score - minScore) / range) * 100;
                  return (
                    <div
                      key={i}
                      className="flex-1 rounded-t transition-all hover:opacity-80"
                      style={{
                        height: `${Math.max(height, 4)}%`,
                        backgroundColor: agentPerf?.baseline != null ? (r.val_score >= agentPerf.baseline ? 'var(--color-warning)' : 'var(--color-error)') : 'var(--color-purple)',
                      }}
                      title={`Run ${i + 1}: ${r.val_score} (${new Date(r.timestamp).toLocaleDateString()})`}
                    />
                  );
                })}
              </div>
              {/* Baseline line */}
              <div className="relative mt-1">
                <div className="border-t border-dashed border-border-light/50 absolute w-full" />
                <span className="text-[9px] text-text-muted relative -top-2">{agentPerf?.baseline != null ? `baseline: ${agentPerf.baseline}` : 'baseline: —'}</span>
              </div>
            </div>

            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-bg-tertiary">
                  <th className="px-4 py-2.5 text-xs font-medium text-text-muted">#</th>
                  <th className="px-4 py-2.5 text-xs font-medium text-text-muted">Date</th>
                  <th className="px-4 py-2.5 text-xs font-medium text-text-muted">Score</th>
                  <th className="px-4 py-2.5 text-xs font-medium text-text-muted">LR</th>
                  <th className="px-4 py-2.5 text-xs font-medium text-text-muted">Rank</th>
                  <th className="px-4 py-2.5 text-xs font-medium text-text-muted">Epochs</th>
                  <th className="px-4 py-2.5 text-xs font-medium text-text-muted">Examples</th>
                  <th className="px-4 py-2.5 text-xs font-medium text-text-muted">Duration</th>
                </tr>
              </thead>
              <tbody>
                {agentResults.slice().reverse().slice(0, 20).map((r, i) => (
                  <tr key={i} className="border-b border-bg-tertiary last:border-0">
                    <td className="px-4 py-2.5 text-xs text-text-muted">{agentResults.length - i}</td>
                    <td className="px-4 py-2.5 text-xs text-text-secondary">
                      {new Date(r.timestamp).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </td>
                    <td className={`px-4 py-2.5 text-xs font-bold ${r.val_score >= (agentPerf?.baseline || 70) ? 'text-warning' : 'text-error'}`}>
                      {r.val_score}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-text-muted font-mono">{r.hyperparams.lr}</td>
                    <td className="px-4 py-2.5 text-xs text-text-muted">{r.hyperparams.rank}</td>
                    <td className="px-4 py-2.5 text-xs text-text-muted">{r.hyperparams.epochs}</td>
                    <td className="px-4 py-2.5 text-xs text-text-muted">{r.num_examples}</td>
                    <td className="px-4 py-2.5 text-xs text-text-muted">{Math.round(r.training_time_s / 60)}m {Math.round(r.training_time_s % 60)}s</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

export default SelfImprovePanel;
