import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, User, Clock, Pause, Volume2, Lock, Check } from 'lucide-react';
import { getPersonaProfiles, getActivePersona, type PersonaProfile, type ActivePersona } from '@/api/client';
import { PageHeader } from '@/components/shared/PageHeader';
import { useToast } from '@/components/shared/Toast';

/**
 * Persona Profiles panel — surfaces the v5.5.24 resolver state.
 *
 * Backend is at /api/persona-profiles (full config) and
 * /api/persona-profiles/active (the one currently resolved). UI shows:
 *  - master-enabled banner with config snippet to opt in
 *  - the currently-active persona with its resolution reason
 *  - all defined profiles as cards (id, name, schedule, windDown, tools)
 *
 * No mutation here — persona definitions are config-managed for v1.
 */
export default function PersonaProfilesPanel() {
  const { toast } = useToast();
  const [list, setList] = useState<{ enabled: boolean; defaultPersona: string | null; channelPins: Record<string, string>; profiles: PersonaProfile[] } | null>(null);
  const [active, setActive] = useState<ActivePersona | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [l, a] = await Promise.all([getPersonaProfiles(), getActivePersona()]);
      setList(l);
      setActive(a);
    } catch (err) {
      toast('error', `Couldn't load persona profiles — try again. (${(err as Error).message})`);
    }
    setLoading(false);
  }, [toast]);

  useEffect(() => { refresh(); }, [refresh]);

  const enabled = list?.enabled ?? false;
  const profiles = list?.profiles ?? [];

  return (
    <div className="space-y-4">
      <PageHeader title="Persona Profiles" breadcrumbs={[{label:'Admin', href:'/overview'}, {label:'Identity'}, {label:'Personas'}]} />

      <div className="flex items-center gap-2">
        <button
          onClick={refresh}
          disabled={loading}
          className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[#27272a] text-[#a1a1aa] text-sm font-medium hover:bg-[#3f3f46] disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      {/* Enabled banner */}
      {!enabled ? (
        <div className="p-4 rounded-lg border border-amber-900/50 bg-amber-950/20 text-sm">
          <div className="font-semibold text-amber-300 mb-1">Personas disabled</div>
          <div className="text-[#a1a1aa]">
            TITAN behaves as a single default persona. To enable Dad Mode (and any other defined profiles), add to <code className="px-1 py-0.5 rounded bg-[#0a0a0f] text-[#e4e4e7]">~/.titan/titan.json</code>:
          </div>
          <pre className="mt-2 p-2 rounded bg-[#0a0a0f] text-xs text-[#a1a1aa] overflow-x-auto">{`{
  "personas": { "enabled": true }
}`}</pre>
          <div className="text-[#a1a1aa] mt-1">Then restart <code className="px-1 py-0.5 rounded bg-[#0a0a0f]">titan.service</code>.</div>
        </div>
      ) : (
        <div className="p-4 rounded-lg border border-[#27272a] bg-[#0a0a0f] text-sm flex items-start gap-3">
          <Check className="w-4 h-4 text-emerald-400 mt-0.5 shrink-0" />
          <div>
            <div className="font-semibold text-emerald-300 mb-1">Personas enabled</div>
            <div className="text-[#a1a1aa]">
              Active right now: <span className="text-[#e4e4e7] font-medium">{active?.activeName ?? '—'}</span>
              {active?.windDown && <span className="ml-2 inline-flex items-center gap-1 text-amber-300"><Pause className="w-3 h-3" /> wind-down active</span>}
            </div>
            <div className="text-xs text-[#52525b] mt-1">{active?.reason}</div>
          </div>
        </div>
      )}

      {/* Channel pins */}
      {enabled && list && Object.keys(list.channelPins).length > 0 && (
        <div className="p-3 rounded-lg border border-[#27272a] bg-[#0a0a0f]">
          <div className="text-xs uppercase tracking-wide text-[#52525b] mb-2">Channel pins</div>
          <div className="flex flex-wrap gap-2">
            {Object.entries(list.channelPins).map(([ch, pid]) => (
              <span key={ch} className="text-xs px-2 py-1 rounded bg-[#27272a] text-[#a1a1aa]">
                {ch} → <span className="text-[#e4e4e7]">{pid}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Profile cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {profiles.map(p => {
          const isActive = enabled && active?.activeId === p.id;
          return (
            <div
              key={p.id}
              className={`p-4 rounded-lg border ${isActive ? 'border-emerald-700 bg-emerald-950/20' : 'border-[#27272a] bg-[#0a0a0f]'}`}
            >
              <div className="flex items-start justify-between mb-2">
                <div className="flex items-center gap-2">
                  <User className="w-4 h-4 text-[#6366f1]" />
                  <div>
                    <div className="text-sm font-semibold text-[#e4e4e7]">{p.name}</div>
                    <div className="text-xs text-[#52525b]">{p.id}</div>
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  {p.windDown && (
                    <span title="windDown=true: pauses autopilot when active" className="text-xs px-1.5 py-0.5 rounded bg-amber-950/40 text-amber-300 inline-flex items-center gap-1">
                      <Pause className="w-3 h-3" /> wind-down
                    </span>
                  )}
                  {p.voiceId && (
                    <span title={`voiceId: ${p.voiceId}`} className="text-xs px-1.5 py-0.5 rounded bg-[#27272a] text-[#a1a1aa] inline-flex items-center gap-1">
                      <Volume2 className="w-3 h-3" /> voice
                    </span>
                  )}
                  {isActive && (
                    <span className="text-xs px-1.5 py-0.5 rounded bg-emerald-950/40 text-emerald-300 inline-flex items-center gap-1">
                      <Check className="w-3 h-3" /> active
                    </span>
                  )}
                </div>
              </div>

              {p.description && (
                <div className="text-xs text-[#a1a1aa] mb-3">{p.description}</div>
              )}

              {p.schedule && (
                <div className="text-xs text-[#a1a1aa] flex items-center gap-1 mb-2">
                  <Clock className="w-3 h-3" /> {p.schedule.from} – {p.schedule.to} local
                </div>
              )}

              {(p.allowedTools.length > 0 || p.deniedTools.length > 0) && (
                <div className="space-y-1.5 mt-2">
                  {p.allowedTools.length > 0 && (
                    <div>
                      <div className="text-[10px] uppercase tracking-wide text-[#52525b] mb-1 flex items-center gap-1">
                        <Lock className="w-3 h-3" /> allowed only
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {p.allowedTools.map(t => (
                          <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-[#27272a] text-[#a1a1aa]">{t}</span>
                        ))}
                      </div>
                    </div>
                  )}
                  {p.deniedTools.length > 0 && (
                    <div>
                      <div className="text-[10px] uppercase tracking-wide text-[#52525b] mb-1">denied</div>
                      <div className="flex flex-wrap gap-1">
                        {p.deniedTools.map(t => (
                          <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-red-950/30 text-red-300">{t}</span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {profiles.length === 0 && !loading && (
          <div className="text-sm text-[#52525b] p-3">No persona profiles defined.</div>
        )}
      </div>
    </div>
  );
}
