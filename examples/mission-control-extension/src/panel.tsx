/**
 * TITAN Mission Control Extension — Custom "System Health" admin panel.
 *
 * Demonstrates:
 * - Creating a React component for Mission Control v2
 * - Fetching data from TITAN's REST API (/api/stats, /api/config)
 * - Displaying real-time metrics (CPU, memory, sessions, tools)
 * - Auto-refresh with setInterval
 * - Error handling and loading states
 *
 * To add this to Mission Control:
 * 1. Copy this file to ui/src/components/admin/SystemHealthPanel.tsx
 * 2. Add route: <Route path="/admin/health" element={<SystemHealthPanel />} />
 * 3. Add menu item in sidebar
 */

import React, { useEffect, useState, useCallback } from "react";

// ============================================================
// Types (match the shape of TITAN's API responses)
// ============================================================

interface SystemStats {
  uptime: number;
  memory: {
    rss: number;
    heapUsed: number;
    heapTotal: number;
  };
  sessions: number;
  tools: {
    total: number;
    loaded: number;
  };
  errors?: Array<{ message: string; timestamp: string }>;
}

interface PanelData {
  stats: SystemStats;
  config: {
    agent: { model: string; autonomyMode: string };
    gateway: { host: string; port: number };
  };
}

// ============================================================
// System Health Panel Component
// ============================================================

export function SystemHealthPanel() {
  const [data, setData] = useState<PanelData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      // Fetch stats and config in parallel
      const [statsRes, configRes] = await Promise.all([
        fetch("/api/stats"),
        fetch("/api/config"),
      ]);

      if (!statsRes.ok || !configRes.ok) {
        throw new Error(
          `API returned ${statsRes.status} / ${configRes.status}`,
        );
      }

      const stats = await statsRes.json();
      const config = await configRes.json();

      setData({ stats, config });
      setLastRefresh(new Date());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Auto-refresh every 10 seconds
  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 10_000);
    return () => clearInterval(interval);
  }, [fetchData]);

  // ============================================================
  // Render
  // ============================================================

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-400">Loading system health...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 bg-red-900/20 border border-red-700 rounded-lg">
        <h3 className="text-red-400 font-semibold mb-2">Error Loading Data</h3>
        <p className="text-sm text-red-300">{error}</p>
        <button
          onClick={fetchData}
          className="mt-3 px-4 py-2 bg-red-700 hover:bg-red-600 rounded text-sm"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!data) return null;

  const { stats, config } = data;
  const uptimeMinutes = Math.floor(stats.uptime / 60);
  const memoryMB = (stats.memory.rss / 1024 / 1024).toFixed(1);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold">System Health</h2>
        <div className="text-xs text-gray-500">
          Last refresh: {lastRefresh.toLocaleTimeString()}
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="p-4 bg-gray-800 rounded-lg">
          <div className="text-sm text-gray-400">Uptime</div>
          <div className="text-2xl font-mono">{uptimeMinutes}m</div>
        </div>

        <div className="p-4 bg-gray-800 rounded-lg">
          <div className="text-sm text-gray-400">Memory (RSS)</div>
          <div className="text-2xl font-mono">{memoryMB} MB</div>
        </div>

        <div className="p-4 bg-gray-800 rounded-lg">
          <div className="text-sm text-gray-400">Active Sessions</div>
          <div className="text-2xl font-mono">{stats.sessions}</div>
        </div>

        <div className="p-4 bg-gray-800 rounded-lg">
          <div className="text-sm text-gray-400">Tools Loaded</div>
          <div className="text-2xl font-mono">
            {stats.tools.loaded}/{stats.tools.total}
          </div>
        </div>
      </div>

      {/* Model Info */}
      <div className="p-4 bg-gray-800 rounded-lg">
        <h3 className="font-semibold mb-2">Agent Configuration</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
          <div>
            <span className="text-gray-400">Model:</span>{" "}
            <span className="font-mono">{config.agent.model}</span>
          </div>
          <div>
            <span className="text-gray-400">Autonomy Mode:</span>{" "}
            <span className="font-mono">{config.agent.autonomyMode}</span>
          </div>
          <div>
            <span className="text-gray-400">Gateway:</span>{" "}
            <span className="font-mono">
              {config.gateway.host}:{config.gateway.port}
            </span>
          </div>
        </div>
      </div>

      {/* Recent Errors */}
      {stats.errors && stats.errors.length > 0 && (
        <div className="p-4 bg-yellow-900/20 border border-yellow-700 rounded-lg">
          <h3 className="text-yellow-400 font-semibold mb-2">
            Recent Errors ({stats.errors.length})
          </h3>
          <div className="space-y-1 max-h-40 overflow-y-auto">
            {stats.errors.slice(0, 10).map((err, i) => (
              <div key={i} className="text-sm text-yellow-300 font-mono">
                [{new Date(err.timestamp).toLocaleTimeString()}] {err.message}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Manual Refresh Button */}
      <button
        onClick={fetchData}
        className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded text-sm"
      >
        Refresh
      </button>
    </div>
  );
}

export default SystemHealthPanel;
