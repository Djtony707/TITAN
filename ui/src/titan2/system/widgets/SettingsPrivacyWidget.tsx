/**
 * Settings → Privacy & Telemetry
 *
 * Post-wizard controls for the telemetry consent captured during onboarding.
 * Lets Tony (and every TITAN user) see exactly what state their install is
 * in — opted in or not, which fields go out, when consent was granted —
 * and flip it off at any time.
 *
 * Reads + writes:
 *   GET  /api/telemetry/consent → { enabled, crashReports, consentedAt, consentedVersion, remoteUrl }
 *   POST /api/telemetry/consent { enabled, crashReports }
 *   GET  /api/analytics/profile → live system_profile preview
 */
import React, { useEffect, useState, useCallback } from 'react';
import { apiFetch } from '@/api/client';
import { Shield, ShieldCheck, AlertCircle, RefreshCw, ExternalLink, CheckCircle2, XCircle, Send, Clock } from 'lucide-react';

interface ConsentState {
    enabled: boolean;
    crashReports: boolean;
    consentedAt?: string;
    consentedVersion?: string;
    remoteUrl?: string;
}

interface RemoteStatus {
    configured: boolean;
    remoteUrl?: string;
    sentCount: number;
    failedCount: number;
    lastAttemptAt?: string;
    lastSuccessAt?: string;
    lastError?: string;
    lastEventType?: string;
}

interface SystemProfile {
    installId: string;
    version: string;
    nodeVersion: string;
    os: string;
    osRelease: string;
    arch: string;
    cpuModel: string;
    cpuCores: number;
    ramTotalMB: number;
    gpuVendor: string;
    gpuName: string;
    gpuVramMB: number;
    installMethod: string;
    diskTotalGB: number;
}

export function SettingsPrivacyWidget() {
    const [consent, setConsent] = useState<ConsentState | null>(null);
    const [profile, setProfile] = useState<SystemProfile | null>(null);
    const [remote, setRemote] = useState<RemoteStatus | null>(null);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [savedAt, setSavedAt] = useState<number | null>(null);

    const fetchAll = useCallback(async () => {
        setError(null);
        try {
            const [c, p, s] = await Promise.all([
                apiFetch('/api/telemetry/consent').then(r => r.ok ? r.json() : Promise.reject(new Error(`consent ${r.status}`))),
                apiFetch('/api/analytics/profile').then(r => r.ok ? r.json() : null),
                apiFetch('/api/telemetry/status').then(r => r.ok ? r.json() : null),
            ]);
            setConsent(c);
            setProfile(p);
            if (s?.remote) setRemote(s.remote);
        } catch (e) {
            setError((e as Error).message);
        }
    }, []);

    // Poll the remote status every 15s so the delivery card stays fresh.
    useEffect(() => {
        const tick = setInterval(() => {
            apiFetch('/api/telemetry/status')
                .then(r => r.ok ? r.json() : null)
                .then(s => { if (s?.remote) setRemote(s.remote); })
                .catch(() => { /* ignore — card will just show stale values */ });
        }, 15_000);
        return () => clearInterval(tick);
    }, []);

    useEffect(() => { void fetchAll(); }, [fetchAll]);

    const save = useCallback(async (next: { enabled: boolean; crashReports: boolean }) => {
        setSaving(true);
        setError(null);
        try {
            const r = await apiFetch('/api/telemetry/consent', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(next),
            });
            if (!r.ok) throw new Error(`save failed: ${r.status}`);
            const saved = await r.json() as { enabled: boolean; crashReports: boolean };
            setConsent(prev => prev
                ? { ...prev, ...saved, consentedAt: saved.enabled ? new Date().toISOString() : undefined }
                : null);
            setSavedAt(Date.now());
            setTimeout(() => setSavedAt(null), 2000);
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setSaving(false);
        }
    }, []);

    const mainEnabled = Boolean(consent?.enabled);
    const crashEnabled = Boolean(consent?.crashReports);

    return (
        <div className="w-full h-full overflow-auto bg-[#0a0a0f] text-[#e4e4e7] text-sm p-4">
            {/* Header */}
            <div className="flex items-center gap-2 mb-4">
                {mainEnabled ? <ShieldCheck className="w-5 h-5 text-[#10b981]" /> : <Shield className="w-5 h-5 text-[#71717a]" />}
                <h3 className="font-semibold text-base">Privacy & Telemetry</h3>
                <span className={`ml-2 text-[10px] px-2 py-0.5 rounded-full border ${
                    mainEnabled ? 'border-[#10b981]/40 bg-[#10b981]/10 text-[#10b981]' : 'border-[#3f3f46] bg-[#18181b] text-[#71717a]'
                }`}>
                    {mainEnabled ? 'ENABLED' : 'OFF'}
                </span>
                <div className="ml-auto flex items-center gap-2">
                    {savedAt && <span className="text-[11px] text-[#10b981] flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> Saved</span>}
                    {error && <span className="text-[11px] text-[#ef4444] flex items-center gap-1"><XCircle className="w-3 h-3" /> {error}</span>}
                    <button
                        onClick={() => { void fetchAll(); }}
                        className="flex items-center gap-1 px-2 py-1 rounded text-[11px] text-[#71717a] hover:text-[#e4e4e7] hover:bg-[#27272a]/60 transition-colors"
                    >
                        <RefreshCw className="w-3 h-3" /> Refresh
                    </button>
                </div>
            </div>

            {/* Primary toggle */}
            <div className="mb-4 p-4 rounded-lg border border-[#27272a]/60 bg-[#18181b]/70">
                <label className="flex items-start gap-3 cursor-pointer">
                    <input
                        type="checkbox"
                        checked={mainEnabled}
                        disabled={saving}
                        onChange={(e) => save({ enabled: e.target.checked, crashReports: crashEnabled })}
                        className="mt-1 w-4 h-4 accent-[#6366f1] disabled:opacity-50"
                    />
                    <div className="flex-1 min-w-0">
                        <div className="font-medium">Send anonymous usage stats</div>
                        <div className="text-xs text-[#a1a1aa] mt-1 leading-relaxed">
                            OS, Node version, CPU/GPU model + VRAM, RAM, TITAN version, and install method.
                            A heartbeat every 5 minutes so we see uptime + concurrent-session counts.
                            Never sends: prompts, file contents, credentials, IP address, or conversations.
                        </div>
                        {consent?.consentedAt && (
                            <div className="text-[10px] text-[#71717a] mt-2">
                                Consented <span className="font-mono">{new Date(consent.consentedAt).toLocaleString()}</span>
                                {consent.consentedVersion && <> on TITAN v<span className="font-mono">{consent.consentedVersion}</span></>}
                            </div>
                        )}
                    </div>
                </label>
            </div>

            {/* Crash reports sub-toggle */}
            <div className={`mb-4 p-4 rounded-lg border transition-opacity ${mainEnabled ? 'border-[#27272a]/60 bg-[#18181b]/70' : 'border-[#27272a]/30 bg-[#18181b]/30 opacity-60'}`}>
                <label className="flex items-start gap-3 cursor-pointer">
                    <input
                        type="checkbox"
                        checked={crashEnabled}
                        disabled={saving || !mainEnabled}
                        onChange={(e) => save({ enabled: mainEnabled, crashReports: e.target.checked })}
                        className="mt-1 w-4 h-4 accent-[#6366f1] disabled:opacity-50"
                    />
                    <div className="flex-1">
                        <div className="font-medium">Send crash reports</div>
                        <div className="text-xs text-[#a1a1aa] mt-1 leading-relaxed">
                            When TITAN throws an uncaught exception or unhandled promise rejection, send the error
                            class, message, and stack trace. <span className="text-[#fbbf24]">Your $HOME path is replaced with the string <span className="font-mono">"$HOME"</span> before sending.</span>
                        </div>
                    </div>
                </label>
            </div>

            {/* Transparency panel */}
            <div className="mb-4 p-4 rounded-lg border border-[#27272a]/60 bg-[#18181b]/40">
                <div className="flex items-center gap-2 mb-3">
                    <AlertCircle className="w-4 h-4 text-[#6366f1]" />
                    <div className="text-sm font-medium">What would be sent right now</div>
                </div>
                {profile ? (
                    <dl className="grid grid-cols-[160px_1fr] gap-y-1 text-xs">
                        <dt className="text-[#71717a]">installId</dt>
                        <dd className="font-mono text-[#e4e4e7]">{profile.installId.slice(0, 32)}…</dd>
                        <dt className="text-[#71717a]">os / arch</dt>
                        <dd className="font-mono text-[#e4e4e7]">{profile.os} / {profile.arch} ({profile.osRelease})</dd>
                        <dt className="text-[#71717a]">cpu</dt>
                        <dd className="font-mono text-[#e4e4e7]">{profile.cpuModel} · {profile.cpuCores}c</dd>
                        <dt className="text-[#71717a]">ram</dt>
                        <dd className="font-mono text-[#e4e4e7]">{(profile.ramTotalMB / 1024).toFixed(1)} GB</dd>
                        <dt className="text-[#71717a]">gpu</dt>
                        <dd className="font-mono text-[#e4e4e7]">{profile.gpuVendor}/{profile.gpuName} · {(profile.gpuVramMB / 1024).toFixed(1)} GB VRAM</dd>
                        <dt className="text-[#71717a]">disk</dt>
                        <dd className="font-mono text-[#e4e4e7]">{profile.diskTotalGB} GB</dd>
                        <dt className="text-[#71717a]">version / node</dt>
                        <dd className="font-mono text-[#e4e4e7]">{profile.version} · {profile.nodeVersion}</dd>
                        <dt className="text-[#71717a]">install method</dt>
                        <dd className="font-mono text-[#e4e4e7]">{profile.installMethod}</dd>
                    </dl>
                ) : (
                    <div className="text-xs text-[#71717a]">Loading profile preview…</div>
                )}
            </div>

            {/* Delivery status — v5.0 addition. Tony asked: "Fix TITAN to
                where anonymous stats get reported somewhere." The live
                status proves the pipe is flowing: green = last send worked,
                red = the collector is unreachable or returned !2xx. */}
            <div className="mb-4 p-4 rounded-lg border border-[#27272a]/60 bg-[#18181b]/50">
                <div className="flex items-center gap-2 mb-3">
                    <Send className="w-4 h-4 text-[#6366f1]" />
                    <div className="text-sm font-medium">Delivery status</div>
                    {remote?.lastSuccessAt && !remote.lastError && (
                        <span className="ml-auto text-[10px] px-2 py-0.5 rounded-full border border-[#10b981]/40 bg-[#10b981]/10 text-[#10b981]">FLOWING</span>
                    )}
                    {remote?.lastError && (
                        <span className="ml-auto text-[10px] px-2 py-0.5 rounded-full border border-[#ef4444]/40 bg-[#ef4444]/10 text-[#ef4444]">ERROR</span>
                    )}
                    {!remote?.configured && (
                        <span className="ml-auto text-[10px] px-2 py-0.5 rounded-full border border-[#71717a]/40 bg-[#71717a]/10 text-[#71717a]">NO REMOTE</span>
                    )}
                </div>
                {remote ? (
                    <dl className="grid grid-cols-[160px_1fr] gap-y-1 text-xs">
                        <dt className="text-[#71717a]">remote URL</dt>
                        <dd className="font-mono text-[#e4e4e7] break-all">{remote.remoteUrl || '—'}</dd>
                        <dt className="text-[#71717a]">sent / failed</dt>
                        <dd className="font-mono text-[#e4e4e7]">
                            <span className="text-[#10b981]">{remote.sentCount}</span>
                            {' / '}
                            <span className={remote.failedCount > 0 ? 'text-[#ef4444]' : 'text-[#71717a]'}>{remote.failedCount}</span>
                            {remote.lastEventType && <span className="text-[#71717a]"> · last event: <span className="text-[#a1a1aa]">{remote.lastEventType}</span></span>}
                        </dd>
                        <dt className="text-[#71717a]">last attempt</dt>
                        <dd className="font-mono text-[#e4e4e7] flex items-center gap-1">
                            <Clock className="w-3 h-3 text-[#71717a]" />
                            {remote.lastAttemptAt ? new Date(remote.lastAttemptAt).toLocaleString() : '—'}
                        </dd>
                        <dt className="text-[#71717a]">last success</dt>
                        <dd className="font-mono text-[#e4e4e7]">
                            {remote.lastSuccessAt ? new Date(remote.lastSuccessAt).toLocaleString() : '—'}
                        </dd>
                        {remote.lastError && (
                            <>
                                <dt className="text-[#ef4444]">last error</dt>
                                <dd className="font-mono text-[#fca5a5] break-all">{remote.lastError}</dd>
                            </>
                        )}
                    </dl>
                ) : (
                    <div className="text-xs text-[#71717a]">Checking collector reachability…</div>
                )}
            </div>

            {/* Collector URL + links */}
            <div className="mb-4 p-3 rounded-lg border border-[#27272a]/60 bg-[#0a0a0f]">
                <div className="text-[10px] text-[#71717a] uppercase tracking-wider mb-1">Collector</div>
                <div className="font-mono text-[11px] text-[#a1a1aa] break-all">{consent?.remoteUrl || '—'}</div>
            </div>

            <div className="flex items-center gap-3 text-[11px]">
                <a
                    href="https://github.com/Djtony707/TITAN/blob/main/PRIVACY.md"
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1 text-[#6366f1] hover:underline"
                >
                    <ExternalLink className="w-3 h-3" /> Read the full PRIVACY.md
                </a>
                <span className="text-[#52525b]">·</span>
                <a
                    href="https://github.com/Djtony707/TITAN/blob/main/src/analytics/collector.ts"
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1 text-[#6366f1] hover:underline"
                >
                    <ExternalLink className="w-3 h-3" /> See the collector source
                </a>
            </div>
        </div>
    );
}
