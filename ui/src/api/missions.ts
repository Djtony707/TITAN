/**
 * TITAN — Mission Chat API client (v6.1.0)
 *
 * Thin typed wrappers over /api/missions/*. Re-uses the existing
 * authHeaders helper from api/client.ts so token-mode installs work
 * transparently.
 */
import { authHeaders } from './client';

// ── Types (mirror src/agent/missionRoom.ts) ────────────────────────

export type MissionStatus = 'forming' | 'working' | 'paused' | 'blocked' | 'done' | 'failed';
export type MemberState = 'idle' | 'working' | 'editing' | 'blocked' | 'done';

export interface MissionMember {
  agentId: string;
  name: string;
  role: string;
  color: string;
  state: MemberState;
  currentActivity?: string;
  lastActiveAt?: string;
  /** v6.1.0-alpha.19 — per-agent model override (provider/model id). */
  modelOverride?: string;
  /** v6.1.0-alpha.19 — agent paused by user. */
  paused?: boolean;
  /** v6.1.0-alpha.31 — rolling activity log (max 8 most recent). Each
   *  entry is a sticky-note's worth of activity ("searched the web",
   *  "read a page", "wrote a file"). The desk renders these as live
   *  sticky notes near the agent that produced them. */
  activityLog?: Array<{ at: string; icon: string; activity: string; detail?: string }>;
}

export type MissionMessage =
  | { id: string; at: string; kind: 'user'; content: string }
  | {
      id: string; at: string; kind: 'agent';
      from: { agentId: string; name: string; role: string; color: string };
      content: string;
      actions?: { name: string; detail?: string }[];
      meta?: {
        subtaskTitle?: string;
        status?: string;
        durationMs?: number;
        tokensUsed?: number;
        costUsd?: number;
        model?: string;
        failureDetail?: string;
      };
      sources?: Array<{
        type: 'url' | 'file' | 'fact' | 'report';
        ref: string;
        description?: string;
      }>;
    }
  | { id: string; at: string; kind: 'system'; content: string; tag?: string }
  | {
      id: string; at: string; kind: 'question';
      from: { agentId: string; name: string; role: string; color: string };
      content: string;
      approvalId: string;
      quickReplies: string[];
      answer?: { content: string; at: string };
    }
  | {
      id: string; at: string; kind: 'artifact_update';
      by: { agentId: string; name: string };
      summary: string;
      wordCount: number;
    };

export interface MissionArtifact {
  format: 'markdown';
  content: string;
  snapshots: Array<{ at: string; content: string; by: string; summary: string; wordCount: number }>;
  updatedAt: string;
}

export interface MissionRoom {
  schemaVersion: 1;
  id: string;
  goal: string;
  status: MissionStatus;
  playId?: string;
  goalId?: string;
  ownerId?: string;
  team: MissionMember[];
  artifact: MissionArtifact;
  messages: MissionMessage[];
  cost: { tokens: number; usd: number };
  /** v6.1.0-alpha.19 — Marathon mode (long-running multi-agent). */
  longRunningMode?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PlaySummary {
  id: string;
  title: string;
  description: string;
  team: string[];
  artifactFormat: string;
  artifactTitle?: string;
  source: 'builtin' | 'user';
}

// ── REST ───────────────────────────────────────────────────────────

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export function createMission(goal: string, playId?: string): Promise<{ mission: MissionRoom }> {
  return json('/api/missions', {
    method: 'POST',
    body: JSON.stringify({ goal, playId }),
  });
}

export function listMissions(): Promise<{ missions: MissionRoom[] }> {
  return json('/api/missions');
}

export function getMission(id: string): Promise<{ mission: MissionRoom }> {
  return json(`/api/missions/${id}`);
}

export function deleteMission(id: string): Promise<{ ok: boolean }> {
  return json(`/api/missions/${id}`, { method: 'DELETE' });
}

export function postMessage(id: string, content: string): Promise<{ message: MissionMessage }> {
  return json(`/api/missions/${id}/message`, {
    method: 'POST',
    body: JSON.stringify({ content }),
  });
}

export function answerQuestion(id: string, approvalId: string, answer: string): Promise<{ ok: boolean }> {
  return json(`/api/missions/${id}/answer`, {
    method: 'POST',
    body: JSON.stringify({ approvalId, answer }),
  });
}

export function setMissionStatus(id: string, status: 'paused' | 'working'): Promise<{ ok: boolean }> {
  return json(`/api/missions/${id}/status`, {
    method: 'POST',
    body: JSON.stringify({ status }),
  });
}

/** v6.1.0-alpha.19 — per-agent model override. Pass `null` to clear. */
export function setAgentModelOverride(missionId: string, agentId: string, model: string | null): Promise<{ ok: boolean; member: MissionMember }> {
  return json(`/api/missions/${missionId}/agent/${encodeURIComponent(agentId)}/model`, {
    method: 'POST',
    body: JSON.stringify({ model }),
  });
}

/** v6.1.0-alpha.19 — pause / resume a specific agent. */
export function setAgentPaused(missionId: string, agentId: string, paused: boolean): Promise<{ ok: boolean; member: MissionMember }> {
  return json(`/api/missions/${missionId}/agent/${encodeURIComponent(agentId)}/pause`, {
    method: 'POST',
    body: JSON.stringify({ paused }),
  });
}

/** v6.1.0-alpha.19 — Marathon mode (long-running collaborative run). */
export function setMissionMode(missionId: string, longRunningMode: boolean): Promise<{ ok: boolean; longRunningMode: boolean }> {
  return json(`/api/missions/${missionId}/mode`, {
    method: 'POST',
    body: JSON.stringify({ longRunningMode }),
  });
}

export interface MissionFile {
  ref: string;
  content: string;
  mimeType: string;
  encoding: 'utf-8' | 'base64';
  sizeBytes: number;
  truncated: boolean;
}

export function getMissionFile(missionId: string, ref: string): Promise<MissionFile> {
  return json(`/api/missions/${missionId}/file?ref=${encodeURIComponent(ref)}`);
}

export function listPlays(): Promise<{ plays: PlaySummary[] }> {
  return json('/api/missions/plays');
}

export function matchPlay(goal: string): Promise<{ play: PlaySummary; team: Array<{ agentId: string; name: string }> }> {
  return json('/api/missions/match-play?goal=' + encodeURIComponent(goal));
}

// ── SSE ────────────────────────────────────────────────────────────

export interface MissionEvent {
  kind:
    | 'mission_created' | 'team_formed' | 'message_added' | 'agent_state_changed'
    | 'artifact_updated' | 'question_raised' | 'question_answered'
    | 'status_changed' | 'cost_changed' | 'mission_deleted'
    | 'hello';
  missionId: string;
  at: string;
  data?: Record<string, unknown>;
}

/**
 * Subscribe to a mission's event stream. Returns an unsubscribe.
 * Auto-reconnects with backoff on disconnect.
 */
export function subscribeToMission(
  missionId: string,
  handler: (ev: MissionEvent) => void,
): () => void {
  let stopped = false;
  let es: EventSource | null = null;
  let reconnectDelay = 500;

  function connect() {
    if (stopped) return;
    // EventSource doesn't support custom headers; auth via cookie or token in URL.
    // For now we rely on the gateway's open-auth or cookie-based session.
    const token = localStorage.getItem('titan-token');
    const url = `/api/missions/${missionId}/stream${token ? `?token=${encodeURIComponent(token)}` : ''}`;
    es = new EventSource(url);

    // The hello frame uses event:hello; others use their kind name.
    const eventNames: MissionEvent['kind'][] = [
      'hello', 'mission_created', 'team_formed', 'message_added',
      'agent_state_changed', 'artifact_updated', 'question_raised',
      'question_answered', 'status_changed', 'cost_changed', 'mission_deleted',
    ];
    for (const name of eventNames) {
      es.addEventListener(name, (e) => {
        try {
          const payload = JSON.parse((e as MessageEvent).data) as MissionEvent;
          handler(payload);
        } catch { /* malformed frame — ignore */ }
      });
    }

    es.onopen = () => { reconnectDelay = 500; };
    es.onerror = () => {
      es?.close();
      es = null;
      if (stopped) return;
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 8000);
    };
  }

  connect();
  return () => {
    stopped = true;
    es?.close();
  };
}
