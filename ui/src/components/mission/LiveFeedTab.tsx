import { useState, useEffect } from 'react';
import { getActivityRecent } from '../../api/client';
import { Clock, Wrench, CheckCircle, XCircle } from 'lucide-react';

interface ActivityEvent {
  id?: string;
  type: string;
  timestamp: string;
  message?: string;
  detail?: string;
  success?: boolean;
}

export default function LiveFeedTab() {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const data = await getActivityRecent('all', 30);
        if (active) setEvents(Array.isArray(data) ? data : (data as { events?: ActivityEvent[] }).events || []);
      } catch { /* non-critical */ }
      if (active) setLoading(false);
    };
    poll();
    const id = setInterval(poll, 5000);
    return () => { active = false; clearInterval(id); };
  }, []);

  if (loading) {
    return (
      <div className="space-y-2">
        {[1, 2, 3].map(i => (
          <div key={i} className="h-12 rounded-lg skeleton-shimmer" />
        ))}
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-32 text-text-muted text-xs">
        <Clock size={20} className="mb-2 opacity-40" />
        No recent activity
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {events.map((event, i) => (
        <div
          key={event.id || i}
          className="flex items-start gap-2 px-2.5 py-2 rounded-lg bg-bg-secondary/30 hover:bg-bg-tertiary transition-colors"
        >
          <div className="mt-0.5">
            {event.type?.includes('tool') ? (
              <Wrench size={12} className="text-cyan" />
            ) : event.success === false ? (
              <XCircle size={12} className="text-error" />
            ) : (
              <CheckCircle size={12} className="text-success" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs text-text-secondary truncate">
              {event.message || event.type || 'Event'}
            </p>
            {event.detail && (
              <p className="text-[10px] text-text-muted truncate">{event.detail}</p>
            )}
          </div>
          <span className="text-[10px] text-text-muted shrink-0">
            {new Date(event.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>
      ))}
    </div>
  );
}
