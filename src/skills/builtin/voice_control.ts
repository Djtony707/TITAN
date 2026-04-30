/**
 * Voice control skill for TITAN agent.
 *
 * Bridges to TitanAgentBridge so the agent can start/stop/process
 * voice via the standard tool interface.
 */

import { TitanAgentBridge } from '../../voice/bridge.js';

let bridge: TitanAgentBridge | null = null;

export async function startVoiceAgent(model?: string): Promise<string> {
  if (bridge?.getStatus().running) {
    return 'Voice agent already running';
  }
  bridge = new TitanAgentBridge({ model });
  await bridge.start();
  return `Voice agent started${model ? ` (model: ${model})` : ''}`;
}

export async function stopVoiceAgent(): Promise<string> {
  if (!bridge) {
    return 'Voice agent not running';
  }
  await bridge.stop();
  bridge = null;
  return 'Voice agent stopped';
}

export async function getVoiceStatus(): Promise<Record<string, unknown>> {
  if (!bridge) {
    return { running: false, uptime: 0 };
  }
  return bridge.getStatus();
}

export async function processVoiceAudio(base64Audio: string): Promise<string> {
  if (!bridge) {
    throw new Error('Voice agent not started. Call start_voice_agent first.');
  }
  const buffer = Buffer.from(base64Audio, 'base64');
  return bridge.processAudio(buffer);
}
