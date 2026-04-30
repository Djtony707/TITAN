/**
 * TitanAgent TypeScript Bridge
 *
 * Spawns titan-voice-agent/agent.py as a child process and
 * communicates via JSON over stdin/stdout. Makes the voice agent
 * visible to the TITAN core graph (GitNexus Process tracing).
 */

import { spawn, ChildProcess } from 'child_process';
import logger from '../utils/logger.js';

interface VoiceAgentOptions {
  pythonPath?: string;
  agentScript?: string;
  model?: string;
  device?: string;
  whisperModel?: string;
  ttsModel?: string;
}

interface AgentStatus {
  running: boolean;
  uptime: number;
  lastError?: string;
}

const COMPONENT = 'VoiceBridge';

export class TitanAgentBridge {
  private proc: ChildProcess | null = null;
  private status: AgentStatus = { running: false, uptime: 0 };
  private startTime = 0;
  // Track pending audio requests so we can match response IDs
  private pendingAudio = new Map<string, { resolve: (value: string) => void; reject: (reason: Error) => void }>();

  constructor(private options: VoiceAgentOptions = {}) {}

  async start(): Promise<void> {
    const python = this.options.pythonPath || process.env.TITAN_PYTHON_PATH || 'python3';
    const script = this.options.agentScript || './titan-voice-agent/agent.py';
    const model = this.options.model || this.options.whisperModel || 'base';

    try {
      this.proc = spawn(python, [script, '--server', '--model', model, '--device', this.options.device || 'auto'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, TITAN_VOICE_MODEL: model }
      });
    } catch (err) {
      logger.warn(COMPONENT, `Failed to spawn TitanAgent: ${(err as Error).message}`);
      this.status.lastError = (err as Error).message;
      throw err;
    }

    this.proc.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'ready') {
            logger.info(COMPONENT, 'TitanAgent ready');
          } else if (msg.type === 'transcript' && msg.requestId) {
            const pending = this.pendingAudio.get(msg.requestId);
            if (pending) {
              pending.resolve(msg.text || '');
              this.pendingAudio.delete(msg.requestId);
            }
          } else if (msg.type === 'error' && msg.requestId) {
            const pending = this.pendingAudio.get(msg.requestId);
            if (pending) {
              pending.reject(new Error(msg.message || 'Audio processing error'));
              this.pendingAudio.delete(msg.requestId);
            }
          }
        } catch {
          logger.debug(COMPONENT, line.trim());
        }
      }
    });

    this.proc.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      logger.error(COMPONENT, msg);
      this.status.lastError = msg;
    });

    this.proc.on('close', (code) => {
      logger.warn(COMPONENT, `TitanAgent exited with code ${code}`);
      this.status.running = false;
      // Reject all pending audio requests
      for (const [id, { reject }] of this.pendingAudio) {
        reject(new Error('TitanAgent process exited'));
        this.pendingAudio.delete(id);
      }
    });

    this.startTime = Date.now();
    this.status.running = true;

    // Wait briefly for startup
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
  }

  async processAudio(audioBuffer: Buffer): Promise<string> {
    if (!this.proc?.stdin?.writable) {
      throw new Error('TitanAgent not running');
    }

    const requestId = Math.random().toString(36).slice(2);
    const payload = JSON.stringify({ type: 'audio', requestId, data: audioBuffer.toString('base64') }) + '\n';

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingAudio.delete(requestId);
        reject(new Error('Audio processing timeout'));
      }, 30000);

      const wrappedResolve = (value: string) => {
        clearTimeout(timeout);
        resolve(value);
      };

      this.pendingAudio.set(requestId, { resolve: wrappedResolve, reject });
      this.proc!.stdin!.write(payload, (err) => {
        if (err) {
          clearTimeout(timeout);
          this.pendingAudio.delete(requestId);
          reject(err);
        }
      });
    });
  }

  getStatus(): AgentStatus {
    return {
      ...this.status,
      uptime: this.status.running ? Date.now() - this.startTime : 0
    };
  }

  async stop(): Promise<void> {
    if (!this.proc) return;
    this.proc.kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 2000));
    if (!this.proc.killed) {
      this.proc.kill('SIGKILL');
    }
    this.status.running = false;
    this.proc = null;
  }
}
