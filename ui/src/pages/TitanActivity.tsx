import { useQuery } from '@tanstack/react-query';
import {
  Activity, Bot, MessageSquare, Wrench, ShieldCheck,
  Target, CircleDot, Server, Brain, Zap, Clock
} from 'lucide-react';
import { dashboardApi } from '@/api/dashboard';
import { queryKeys } from '@/lib/queryKeys';

/* ═══════════════════════════════════════════════════════════════════
   TITAN Activity — Space Agent-style unified activity feed
   ═══════════════════════════════════════════════════════════════════ */

const TYPE_ICONS: Record<string, { icon: React.ElementType; color: string }> = {
  agent_start: { icon: Bot, color: '#22c55e' },
  agent_stop: { icon: Bot, color: '#f59e0b' },
  session_created: { icon: MessageSquare, color: '#6366f1' },
  tool_called: { icon: Wrench, color: '#22d3ee' },
  error: { icon: Server, color: '#ef4444' },
};

export function TitanActivity() {
  const { data: activity, isLoading } = useQuery({
    queryKey: [...queryKeys.dashboard, 'activity'],
    queryFn: () => dashboardApi.activity(),
    refetchInterval: 10000,
  });

  return (
    <div className="h-full overflow-auto p-4 md:p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-lg font-bold text-[#fafafa]">Activity</h1>
          <p className="text-xs text-[#52525b]">{activity?.length ?? 0} events</p>
        </div>
        <div className="flex items-center gap-2">
          <Zap className="w-4 h-4 text-[#6366f1] animate-pulse" />
          <span className="text-[10px] text-[#6366f1]">Live</span>
        </div>
      </div>

      {/* Timeline */}
      <div className="relative">
        {/* Vertical line */}
        <div className="absolute left-[19px] top-2 bottom-2 w-px bg-[#27272a]" />

        <div className="space-y-1">
          {isLoading && (
            <div className="text-center py-8 text-sm text-[#52525b]">Loading activity...</div>
          )}

          {activity?.map((event, i) => {
            const config = TYPE_ICONS[event.type] || { icon: CircleDot, color: '#71717a' };
            const Icon = config.icon;

            return (
              <div key={`${event.id}-${i}`} className="flex gap-3 px-2 py-2.5 rounded-lg hover:bg-[#27272a]/20 transition-colors group">
                {/* Icon dot */}
                <div className="relative z-10 flex-shrink-0">
                  <div
                    className="w-10 h-10 rounded-full flex items-center justify-center border-2 border-[#09090b]"
                    style={{ background: `${config.color}15` }}
                  >
                    <Icon className="w-4 h-4" style={{ color: config.color }} />
                  </div>
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0 pt-1">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-[12px] font-medium text-[#fafafa]">{event.title}</span>
                    <span className="text-[9px] text-[#3f3f46]">{event.type.replace('_', ' ')}</span>
                  </div>
                  <p className="text-[11px] text-[#52525b] mb-1">{event.description}</p>
                  <div className="flex items-center gap-2 text-[9px] text-[#3f3f46]">
                    <Clock className="w-3 h-3" />
                    {timeAgo(event.timestamp)}
                    {event.agentName && (
                      <span className="flex items-center gap-1 text-[#6366f1]">
                        <Bot className="w-3 h-3" />
                        {event.agentName}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}

          {activity?.length === 0 && (
            <div className="text-center py-12">
              <Activity className="w-8 h-8 text-[#3f3f46] mx-auto mb-3" />
              <p className="text-sm text-[#52525b]">No activity yet</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function timeAgo(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}
