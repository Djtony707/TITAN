/**
 * TITAN Lifecycle Manager
 *
 * Central registry for all daemon/sidecar/server processes.
 * Provides coordinated shutdown in reverse dependency order.
 *
 * Usage:
 *   const lm = new LifecycleManager();
 *   lm.register('f5tts', () => startF5TTSHandler(), () => stopF5TTSHandler());
 *   lm.register('paperclip', () => startPaperclip(...), () => stopPaperclip());
 *   lm.register('voice', () => bridge.start(), () => bridge.stop());
 *   
 *   await lm.startAll();     // start in registration order
 *   await lm.stopAll();      // stop in reverse order
 *   await lm.gracefulShutdown(SIGTERM);  // handles process signals
 */

import logger from './logger.js';

interface LifecycleEntry {
  name: string;
  start: () => Promise<void> | void;
  stop: () => Promise<void> | void;
  running: boolean;
  status: 'idle' | 'starting' | 'running' | 'stopping' | 'error';
  lastError?: string;
  startTime?: number;
  stopTime?: number;
}

const COMPONENT = 'LifecycleManager';

export class LifecycleManager {
  private entries: LifecycleEntry[] = [];
  private shutdownInProgress = false;

  register(
    name: string,
    start: () => Promise<void> | void,
    stop: () => Promise<void> | void
  ): void {
    if (this.entries.find(e => e.name === name)) {
      logger.warn(COMPONENT, `Service "${name}" already registered, skipping duplicate`);
      return;
    }
    this.entries.push({ name, start, stop, running: false, status: 'idle' });
  }

  async startAll(): Promise<void> {
    for (const entry of this.entries) {
      try {
        entry.status = 'starting';
        logger.info(COMPONENT, `Starting ${entry.name}...`);
        await entry.start();
        entry.running = true;
        entry.status = 'running';
        entry.startTime = Date.now();
        logger.info(COMPONENT, `${entry.name} started (${Date.now() - entry.startTime!}ms)`);
      } catch (err) {
        entry.status = 'error';
        entry.lastError = (err as Error).message;
        logger.error(COMPONENT, `Failed to start ${entry.name}: ${entry.lastError}`);
        // Continue with next service — don't let one failure block the rest
      }
    }
  }

  async stopAll(): Promise<void> {
    if (this.shutdownInProgress) {
      logger.warn(COMPONENT, 'Shutdown already in progress');
      return;
    }
    this.shutdownInProgress = true;

    // Stop in reverse dependency order
    const reverse = [...this.entries].reverse();

    for (const entry of reverse) {
      if (!entry.running && entry.status === 'idle') continue;
      try {
        entry.status = 'stopping';
        logger.info(COMPONENT, `Stopping ${entry.name}...`);
        await entry.stop();
        entry.running = false;
        entry.status = 'idle';
        entry.stopTime = Date.now();
        const uptime = entry.startTime ? entry.stopTime - entry.startTime : 0;
        logger.info(COMPONENT, `${entry.name} stopped (uptime: ${uptime}ms)`);
      } catch (err) {
        entry.status = 'error';
        entry.lastError = (err as Error).message;
        logger.error(COMPONENT, `Failed to stop ${entry.name}: ${entry.lastError}`);
        // Continue — don't let one failure prevent cleanup of others
      }
    }

    this.shutdownInProgress = false;
  }

  /** Attach signal handlers for graceful shutdown */
  gracefulShutdown(signal: NodeJS.Signals | string): void {
    logger.info(COMPONENT, `Received ${signal}, initiating graceful shutdown...`);
    this.stopAll().then(() => {
      logger.info(COMPONENT, 'All services stopped. Exiting.');
      process.exit(0);
    }).catch((err) => {
      logger.error(COMPONENT, `Shutdown failed: ${(err as Error).message}`);
      process.exit(1);
    });
  }

  getStatus(): Array<{ name: string; status: string; running: boolean; uptime: number }> {
    return this.entries.map(e => ({
      name: e.name,
      status: e.status,
      running: e.running,
      uptime: e.startTime ? Date.now() - e.startTime : 0,
    }));
  }
}

// Singleton for the running gateway process
let _manager: LifecycleManager | null = null;

export function getLifecycleManager(): LifecycleManager {
  if (!_manager) _manager = new LifecycleManager();
  return _manager;
}
