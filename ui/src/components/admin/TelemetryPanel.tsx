import { useEffect, useState } from 'react';
import { BarChart3 } from 'lucide-react';
import { getMetricsSummary } from '@/api/client';
import { StatCard } from '@/components/shared/StatCard';

function TelemetryPanel() {
  const [metrics, setMetrics] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchMetrics = async () => {
    try {
      const data = await getMetricsSummary();
      setMetrics(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch metrics');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchMetrics();
    const interval = setInterval(fetchMetrics, 15_000);
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="h-28 animate-pulse rounded-xl border border-border bg-bg-secondary" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border border-error/50 bg-bg-secondary p-6 text-center text-error">
        {error}
      </div>
    );
  }

  if (!metrics) return null;

  // Flatten metrics — expand nested objects like { totalTokens: { prompt, completion } }
  const entries: [string, string | number][] = [];
  for (const [key, value] of Object.entries(metrics)) {
    if (typeof value === 'number' || typeof value === 'string') {
      entries.push([key, value]);
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [subKey, subVal] of Object.entries(value as Record<string, unknown>)) {
        if (typeof subVal === 'number' || typeof subVal === 'string') {
          entries.push([`${key}.${subKey}`, subVal]);
        }
      }
    }
  }

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-text">Telemetry</h2>
      {entries.length === 0 ? (
        <div className="rounded-xl border border-border bg-bg-secondary p-12 text-center text-text-muted">
          No metrics available
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {entries.map(([key, value]) => (
            <StatCard
              key={key}
              title={key.replace(/([A-Z])/g, ' $1').replace(/[_-]/g, ' ').trim()}
              value={typeof value === 'number' ? value.toLocaleString() : String(value)}
              icon={<BarChart3 className="h-5 w-5" />}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default TelemetryPanel;
