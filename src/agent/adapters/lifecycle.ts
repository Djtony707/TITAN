/**
 * TITAN — Adapter Lifecycle Manager
 *
 * Manages start/stop/heartbeat/execute lifecycle for all adapter types.
 */
import type { AdapterContext, AdapterResult, AdapterConfig, AdapterStatus } from './base.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'AdapterLifecycle';
const DEFAULT_HEARTBEAT_MS = 30_000;

interface RunningEntry {
    adapter: import('./base.js').ExternalAdapter;
    agentId: string;
    config: AdapterConfig;
    startedAt: string;
}

export class AdapterLifecycleManager {
    private running = new Map<string, RunningEntry>();
    private heartbeatTimers = new Map<string, ReturnType<typeof setInterval>>();

    async startAdapter(agentId: string, adapterType: string, config: AdapterConfig): Promise<void> {
        if (this.running.has(agentId)) await this.stopAdapter(agentId);

        // Dynamic import to avoid circular dependency with index.ts
        const { getAdapter } = await import('./index.js');
        const adapter = getAdapter(adapterType);
        if (!adapter) throw new Error(`Unknown adapter type: '${adapterType}'`);

        logger.info(COMPONENT, `Starting '${adapterType}' for agent ${agentId}`);
        if (adapter.start) await adapter.start(config);

        this.running.set(agentId, { adapter, agentId, config, startedAt: new Date().toISOString() });

        if (adapter.persistent && adapter.checkHeartbeat) {
            const ms = config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS;
            const timer = setInterval(async () => {
                try {
                    const ok = await adapter.checkHeartbeat!();
                    if (!ok) logger.warn(COMPONENT, `Heartbeat FAILED for ${agentId}`);
                } catch (e) { logger.warn(COMPONENT, `Heartbeat error for ${agentId}: ${(e as Error).message}`); }
            }, ms);
            timer.unref();
            this.heartbeatTimers.set(agentId, timer);
        }
    }

    async stopAdapter(agentId: string): Promise<void> {
        const timer = this.heartbeatTimers.get(agentId);
        if (timer) { clearInterval(timer); this.heartbeatTimers.delete(agentId); }
        const entry = this.running.get(agentId);
        if (!entry) return;
        this.running.delete(agentId);
        logger.info(COMPONENT, `Stopping '${entry.adapter.type}' for agent ${agentId}`);
        if (entry.adapter.stop) {
            try { await entry.adapter.stop(); } catch (e) { logger.warn(COMPONENT, `Stop error: ${(e as Error).message}`); }
        }
    }

    getAdapterStatus(agentId: string): AdapterStatus {
        const entry = this.running.get(agentId);
        if (!entry) return { connected: false, lastHeartbeat: null, upSince: null, error: 'No adapter running' };
        if (entry.adapter.getStatus) return entry.adapter.getStatus();
        return { connected: true, lastHeartbeat: null, upSince: entry.startedAt, error: null };
    }

    async executeTask(agentId: string, ctx: AdapterContext): Promise<AdapterResult> {
        const entry = this.running.get(agentId);
        if (!entry) throw new Error(`No adapter running for agent '${agentId}'`);
        return entry.adapter.execute(ctx);
    }

    async checkAllHeartbeats(): Promise<Map<string, boolean>> {
        const results = new Map<string, boolean>();
        const checks = [...this.running.entries()]
            .filter(([, e]) => e.adapter.checkHeartbeat)
            .map(async ([id, e]) => {
                try { results.set(id, await e.adapter.checkHeartbeat!()); }
                catch { results.set(id, false); }
            });
        await Promise.all(checks);
        return results;
    }

    async shutdownAll(): Promise<void> {
        const ids = [...this.running.keys()];
        logger.info(COMPONENT, `Shutting down ${ids.length} adapter(s)`);
        await Promise.all(ids.map(id => this.stopAdapter(id)));
    }

    listRunning(): Array<{ agentId: string; adapterType: string; startedAt: string }> {
        return [...this.running.entries()].map(([agentId, e]) => ({ agentId, adapterType: e.adapter.type, startedAt: e.startedAt }));
    }
}
