import { useCallback, useEffect, useState } from 'react';
import { PhoneCall, Radio, RefreshCw, ShieldCheck, Ban, ClipboardList } from 'lucide-react';
import {
  getDograhCalls,
  getDograhOptOuts,
  getDograhStatus,
  getDograhWorkflows,
  requestDograhOutboundCall,
  type DograhCallReceipt,
  type DograhOptOut,
  type DograhStatusResponse,
  type DograhWorkflowSummary,
} from '@/api/client';
import { PageHeader, StatusBadge } from '@/components/shared';
import { useToast } from '@/components/shared/Toast';

function SmallCard({ title, value, detail }: { title: string; value: string; detail?: string }) {
  return (
    <div className="rounded-xl border border-border bg-bg-secondary/70 p-4">
      <div className="text-[10px] uppercase tracking-[0.16em] text-text-muted">{title}</div>
      <div className="mt-1 text-lg font-semibold text-text">{value}</div>
      {detail && <div className="mt-1 text-xs text-text-secondary">{detail}</div>}
    </div>
  );
}

function timeSince(dateStr: string): string {
  const ms = Date.now() - new Date(dateStr).getTime();
  if (!Number.isFinite(ms)) return 'unknown';
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function PhoneDeskPanel() {
  const [status, setStatus] = useState<DograhStatusResponse | null>(null);
  const [workflows, setWorkflows] = useState<DograhWorkflowSummary[]>([]);
  const [calls, setCalls] = useState<DograhCallReceipt[]>([]);
  const [optOuts, setOptOuts] = useState<DograhOptOut[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toNumber, setToNumber] = useState('');
  const [purpose, setPurpose] = useState('');
  const [workflowId, setWorkflowId] = useState('');
  const [mode, setMode] = useState<'test' | 'callback' | 'campaign'>('callback');
  const [submitting, setSubmitting] = useState(false);
  const { toast } = useToast();

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [statusData, workflowData, callData, optOutData] = await Promise.all([
        getDograhStatus().catch((e) => ({ ok: false, dograh: { error: (e as Error).message } } as DograhStatusResponse)),
        getDograhWorkflows().catch(() => ({ workflows: [], count: 0 })),
        getDograhCalls(50).catch(() => ({ calls: [], count: 0 })),
        getDograhOptOuts().catch(() => ({ optOuts: [], count: 0 })),
      ]);
      setStatus(statusData);
      setWorkflows(workflowData.workflows);
      setCalls(callData.calls);
      setOptOuts(optOutData.optOuts);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Phone Desk refresh failed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const requestCall = async () => {
    if (!toNumber.trim() || !purpose.trim() || submitting) return;
    setSubmitting(true);
    try {
      const result = await requestDograhOutboundCall({
        toNumber: toNumber.trim(),
        purpose: purpose.trim(),
        mode,
        workflowId: workflowId.trim() || undefined,
      });
      if (result.status === 'pending_approval') {
        toast('success', `Approval queued: ${result.approvalActionId}`);
      } else if (result.status === 'started') {
        toast('success', 'Dograh call started');
      } else {
        toast('info', 'Dograh request recorded');
      }
      setPurpose('');
      await refresh();
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Call request failed');
    } finally {
      setSubmitting(false);
    }
  };

  const config = status?.config as { enabled?: boolean; adminNumberCount?: number; publicNumberCount?: number; allowCampaigns?: boolean; maxCallsPerHour?: number; dograh?: { baseUrl?: string; apiKeyConfigured?: boolean; defaultOutboundWorkflowId?: string | null; defaultInboundWorkflowId?: string | null } } | undefined;
  const dograh = status?.dograh as { error?: string; workflowCount?: { total?: number; active?: number } } | undefined;

  return (
    <div className="mx-auto max-w-7xl space-y-5 px-4 py-6 md:px-8">
      <PageHeader
        title="Phone Desk"
        breadcrumbs={[{ label: 'Tools' }, { label: 'Phone Desk' }]}
        actions={
          <button onClick={refresh} disabled={loading} className="inline-flex items-center gap-2 rounded-md border border-border bg-bg-secondary px-3 py-1.5 text-xs text-text-secondary hover:text-text disabled:opacity-50">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
        }
      />

      {error && <div className="rounded-lg border border-error/30 bg-error/10 px-4 py-3 text-sm text-error">{error}</div>}

      <div className="grid gap-3 md:grid-cols-4">
        <SmallCard title="Dograh" value={status?.ok ? 'Reachable' : 'Not ready'} detail={dograh?.error || config?.dograh?.baseUrl || 'Optional sidecar'} />
        <SmallCard title="Admin numbers" value={String(config?.adminNumberCount ?? 0)} detail="Only these callers can control TITAN" />
        <SmallCard title="Public numbers" value={String(config?.publicNumberCount ?? 0)} detail="Receptionist/coworker intake lines" />
        <SmallCard title="Campaign mode" value={config?.allowCampaigns ? 'Enabled' : 'Locked'} detail={`${config?.maxCallsPerHour ?? 0}/hour limit`} />
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_1.2fr]">
        <section className="rounded-2xl border border-border bg-bg-secondary/60 p-5">
          <div className="mb-4 flex items-center gap-2">
            <PhoneCall size={16} className="text-accent-light" />
            <h2 className="text-sm font-semibold text-text">Request outbound call</h2>
          </div>
          <p className="mb-4 text-xs leading-relaxed text-text-secondary">
            TITAN creates an approval request first. It does not dial until a matching Phone Desk approval is consumed.
          </p>
          <div className="space-y-3">
            <input value={toNumber} onChange={(e) => setToNumber(e.target.value)} placeholder="E.164 number, e.g. +15551234567" className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text outline-none focus:border-accent" />
            <input value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="Purpose / objective" className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text outline-none focus:border-accent" />
            <select value={workflowId} onChange={(e) => setWorkflowId(e.target.value)} className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text outline-none focus:border-accent">
              <option value="">Default outbound workflow</option>
              {workflows.map((wf) => <option key={wf.id} value={wf.id}>{wf.name} ({wf.id})</option>)}
            </select>
            <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)} className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text outline-none focus:border-accent">
              <option value="test">Test call</option>
              <option value="callback">Callback / follow-up</option>
              <option value="campaign">Campaign / cold call (compliance-gated)</option>
            </select>
            <button onClick={requestCall} disabled={submitting || !toNumber.trim() || !purpose.trim()} className="w-full rounded-md bg-accent px-3 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50">
              {submitting ? 'Creating approval…' : 'Create approval request'}
            </button>
          </div>
        </section>

        <section className="rounded-2xl border border-border bg-bg-secondary/60 p-5">
          <div className="mb-4 flex items-center gap-2">
            <Radio size={16} className="text-accent-light" />
            <h2 className="text-sm font-semibold text-text">Dograh workflows</h2>
            <StatusBadge status={`${workflows.length}`} size="sm" />
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {workflows.length === 0 ? (
              <div className="col-span-full rounded-lg border border-border bg-bg-tertiary/40 p-4 text-sm text-text-muted">No workflows returned. Configure Dograh and API key, then refresh.</div>
            ) : workflows.map((workflow) => (
              <div key={workflow.id} className="rounded-lg border border-border bg-bg-tertiary/40 p-3">
                <div className="text-sm font-medium text-text">{workflow.name}</div>
                <div className="mt-1 font-mono text-[11px] text-text-muted">{workflow.id}</div>
              </div>
            ))}
          </div>
          <div className="mt-4 grid gap-2 text-xs text-text-secondary sm:grid-cols-2">
            <div className="rounded-lg border border-border bg-bg-tertiary/30 p-3"><ShieldCheck size={14} className="mb-1 text-success" />API key configured: {config?.dograh?.apiKeyConfigured ? 'yes' : 'no'}</div>
            <div className="rounded-lg border border-border bg-bg-tertiary/30 p-3"><ClipboardList size={14} className="mb-1 text-info" />Workflow count: {dograh?.workflowCount?.active ?? 'unknown'} active</div>
          </div>
        </section>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <section className="rounded-2xl border border-border bg-bg-secondary/60 p-5">
          <div className="mb-4 flex items-center gap-2"><ClipboardList size={16} className="text-accent-light" /><h2 className="text-sm font-semibold text-text">Recent call receipts</h2></div>
          <div className="divide-y divide-border/50 overflow-hidden rounded-lg border border-border">
            {calls.length === 0 ? <div className="p-4 text-sm text-text-muted">No Dograh call receipts yet.</div> : calls.map((call) => (
              <div key={call.actionId} className="p-3 text-xs">
                <div className="flex items-center justify-between gap-2"><span className="font-medium text-text">{call.summary}</span><StatusBadge status={call.status} size="sm" /></div>
                <div className="mt-1 flex flex-wrap gap-2 text-text-muted"><span>{timeSince(call.ts)}</span>{call.mode && <span>mode: {call.mode}</span>}{call.direction && <span>{call.direction}</span>}{call.workflowRunId !== undefined && <span>run: {String(call.workflowRunId)}</span>}</div>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-2xl border border-border bg-bg-secondary/60 p-5">
          <div className="mb-4 flex items-center gap-2"><Ban size={16} className="text-warning" /><h2 className="text-sm font-semibold text-text">Opt-outs</h2></div>
          <div className="divide-y divide-border/50 overflow-hidden rounded-lg border border-border">
            {optOuts.length === 0 ? <div className="p-4 text-sm text-text-muted">No campaign opt-outs recorded.</div> : optOuts.map((entry) => (
              <div key={`${entry.phoneRedacted}-${entry.recordedAt}`} className="p-3 text-xs">
                <div className="flex items-center justify-between gap-2"><span className="font-medium text-text">{entry.phoneRedacted}</span><span className="text-text-muted">{timeSince(entry.recordedAt)}</span></div>
                <div className="mt-1 text-text-secondary">{entry.reason}</div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
