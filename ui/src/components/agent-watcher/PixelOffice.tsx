import { useRef, useEffect, useState } from 'react';
import type { AgentEvent } from '@/api/types';

type AgentState = 'idle' | 'thinking' | 'typing' | 'searching' | 'reading' | 'executing' | 'error' | 'done';

const STATE_COLORS: Record<AgentState, string> = {
  idle: 'var(--color-accent)', thinking: 'var(--color-warning)', typing: 'var(--color-cyan)', searching: 'var(--color-purple-light)',
  reading: 'var(--color-emerald)', executing: 'var(--color-cyan)', error: 'var(--color-error)', done: 'var(--color-success)',
};

const AGENT_BODY_COLORS = ['var(--color-accent)', 'var(--color-cyan)', 'var(--color-warning)', 'var(--color-purple-light)', 'var(--color-emerald)', '#ec4899', '#f97316', '#14b8a6'];

function toolToState(toolName?: string): AgentState {
  if (!toolName) return 'thinking';
  const n = toolName.toLowerCase();
  if (n.includes('search') || n.includes('browse') || n.includes('web')) return 'searching';
  if (n.includes('write') || n.includes('edit') || n.includes('shell')) return 'typing';
  if (n.includes('read') || n.includes('list')) return 'reading';
  if (n.includes('code_exec') || n.includes('exec')) return 'executing';
  return 'thinking';
}

interface PixelAgent {
  name: string;
  state: AgentState;
  status: string;
  bodyColor: string;
  lastSeen: number;
  // Position & movement
  x: number; y: number;
  targetX: number; targetY: number;
  deskX: number; deskY: number;
  walkFrame: number;
  facingRight: boolean;
  atDesk: boolean;
}

// Office furniture positions (relative to canvas)
const STATIONS = {
  waterCooler: { x: 0.08, y: 0.55 },
  whiteboard: { x: 0.5, y: 0.25 },
  printer: { x: 0.92, y: 0.55 },
  coffee: { x: 0.15, y: 0.35 },
  server: { x: 0.85, y: 0.35 },
};

export function PixelOffice({ events }: { events: AgentEvent[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const agentsRef = useRef<Map<string, PixelAgent>>(new Map());
  const frameRef = useRef(0);
  const [agentList, setAgentList] = useState<PixelAgent[]>([]);
  const sizeRef = useRef({ w: 400, h: 280 });

  useEffect(() => {
    const latest = events[events.length - 1];
    if (!latest) return;
    const agents = agentsRef.current;
    const agentName = latest.agentName || 'TITAN';
    const w = sizeRef.current.w;
    const h = sizeRef.current.h;

    let agent = agents.get(agentName);
    if (!agent) {
      const idx = agents.size;
      const deskSpacing = Math.min(w / (agents.size + 2), 140);
      const deskX = (w / 2) - ((agents.size) * deskSpacing / 2) + idx * deskSpacing;
      const deskY = h * 0.55;
      agent = {
        name: agentName, state: 'idle', status: 'Ready',
        bodyColor: AGENT_BODY_COLORS[idx % AGENT_BODY_COLORS.length],
        lastSeen: Date.now(),
        x: deskX, y: deskY, targetX: deskX, targetY: deskY,
        deskX, deskY, walkFrame: 0, facingRight: true, atDesk: true,
      };
      agents.set(agentName, agent);
    }
    agent.lastSeen = Date.now();

    const prevState = agent.state;
    if (latest.type === 'tool_start') {
      agent.state = toolToState(latest.toolName);
      agent.status = `${latest.toolName}...`;
      // Walk to a station based on tool type
      if (agent.state === 'searching') {
        agent.targetX = w * STATIONS.whiteboard.x; agent.targetY = h * STATIONS.whiteboard.y; agent.atDesk = false;
      } else if (agent.state === 'reading') {
        agent.targetX = w * STATIONS.server.x; agent.targetY = h * STATIONS.server.y; agent.atDesk = false;
      } else {
        agent.targetX = agent.deskX; agent.targetY = agent.deskY; agent.atDesk = true;
      }
    } else if (latest.type === 'tool_end') {
      agent.state = latest.status === 'error' ? 'error' : 'done';
      agent.status = latest.status === 'error' ? `${latest.toolName} failed` : `${latest.toolName} done`;
      // Walk back to desk
      agent.targetX = agent.deskX; agent.targetY = agent.deskY; agent.atDesk = true;
    } else if (latest.type === 'thinking') {
      agent.state = 'thinking';
      agent.status = 'Thinking...';
      // Wander to coffee or whiteboard
      if (prevState !== 'thinking') {
        const spot = Math.random() > 0.5 ? STATIONS.coffee : STATIONS.whiteboard;
        agent.targetX = w * spot.x + (Math.random() - 0.5) * 30;
        agent.targetY = h * spot.y + (Math.random() - 0.5) * 15;
        agent.atDesk = false;
      }
    } else if (latest.type === 'token') {
      agent.state = 'typing'; agent.status = 'Responding...';
      agent.targetX = agent.deskX; agent.targetY = agent.deskY; agent.atDesk = true;
    } else if (latest.type === 'done') {
      agent.state = 'done'; agent.status = 'Complete!';
      agent.targetX = agent.deskX; agent.targetY = agent.deskY; agent.atDesk = true;
    }

    for (const [, a] of agents) {
      if (Date.now() - a.lastSeen > 60000) { a.state = 'idle'; a.status = 'Idle'; }
    }
    setAgentList([...agents.values()]);
  }, [events]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth; const h = canvas.clientHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    ctx.scale(dpr, dpr);
    sizeRef.current = { w, h };

    let animId: number;

    const drawFurniture = (t: number) => {
      // Floor
      ctx.strokeStyle = '#141418'; ctx.lineWidth = 0.5;
      for (let i = 0; i < w; i += 24) { ctx.beginPath(); ctx.moveTo(i, h * 0.7); ctx.lineTo(i, h); ctx.stroke(); }
      for (let j = h * 0.7; j < h; j += 24) { ctx.beginPath(); ctx.moveTo(0, j); ctx.lineTo(w, j); ctx.stroke(); }

      // Whiteboard
      const wb = STATIONS.whiteboard;
      ctx.fillStyle = 'var(--color-bg-tertiary)'; ctx.fillRect(w * wb.x - 40, h * wb.y - 30, 80, 50);
      ctx.fillStyle = 'var(--color-text)'; ctx.fillRect(w * wb.x - 36, h * wb.y - 26, 72, 42);
      ctx.fillStyle = '#6366f140';
      for (let i = 0; i < 4; i++) ctx.fillRect(w * wb.x - 30 + Math.sin(t * 0.5 + i) * 5, h * wb.y - 20 + i * 10, 20 + Math.sin(i) * 15, 2);

      // Water cooler
      const wc = STATIONS.waterCooler;
      ctx.fillStyle = 'var(--color-border)'; ctx.fillRect(w * wc.x - 8, h * wc.y - 15, 16, 30);
      ctx.fillStyle = '#60a5fa40'; ctx.fillRect(w * wc.x - 6, h * wc.y - 12, 12, 14);

      // Coffee machine
      const cf = STATIONS.coffee;
      ctx.fillStyle = '#44403c'; ctx.fillRect(w * cf.x - 10, h * cf.y - 10, 20, 20);
      ctx.fillStyle = '#78716c'; ctx.fillRect(w * cf.x - 8, h * cf.y - 8, 16, 12);
      if (Math.sin(t * 2) > 0.5) { ctx.fillStyle = '#fbbf2440'; ctx.fillRect(w * cf.x - 4, h * cf.y - 16, 8, 6); }

      // Server rack
      const sr = STATIONS.server;
      ctx.fillStyle = 'var(--color-bg-tertiary)'; ctx.fillRect(w * sr.x - 12, h * sr.y - 20, 24, 40);
      for (let i = 0; i < 4; i++) {
        ctx.fillStyle = i % 2 === 0 ? '#22c55e40' : '#3b82f640';
        ctx.fillRect(w * sr.x - 8, h * sr.y - 16 + i * 8, 3, 3);
        if (Math.sin(t * 3 + i) > 0) { ctx.fillStyle = 'var(--color-success)'; ctx.fillRect(w * sr.x + 4, h * sr.y - 16 + i * 8, 2, 2); }
      }

      // Printer
      const pr = STATIONS.printer;
      ctx.fillStyle = 'var(--color-border)'; ctx.fillRect(w * pr.x - 14, h * pr.y - 8, 28, 16);
      ctx.fillStyle = 'var(--color-border-light)'; ctx.fillRect(w * pr.x - 12, h * pr.y - 6, 24, 8);
    };

    const drawPixelAgent = (agent: PixelAgent, t: number) => {
      const { x, y, state, bodyColor, facingRight, walkFrame, atDesk } = agent;
      const color = state === 'idle' ? bodyColor : STATE_COLORS[state];
      const bob = atDesk ? Math.sin(t * 0.8) * 1 : 0;
      const isWalking = Math.abs(agent.x - agent.targetX) > 2 || Math.abs(agent.y - agent.targetY) > 2;
      const legAnim = isWalking ? Math.sin(walkFrame * 0.4) * 3 : 0;

      // Shadow
      ctx.fillStyle = 'rgba(0,0,0,0.2)';
      ctx.beginPath(); ctx.ellipse(x, y + 16, 8, 3, 0, 0, Math.PI * 2); ctx.fill();

      // Desk (only if at desk)
      if (atDesk) {
        ctx.fillStyle = 'var(--color-border)'; ctx.fillRect(x - 22, y + 8, 44, 6);
        ctx.fillStyle = 'var(--color-border-light)'; ctx.fillRect(x - 20, y + 9, 40, 4);
        // Mini monitor
        ctx.fillStyle = 'var(--color-bg-tertiary)'; ctx.fillRect(x - 8, y - 4, 16, 12);
        const sc = state === 'error' ? 'var(--color-error)' : color;
        ctx.fillStyle = sc + '50'; ctx.fillRect(x - 6, y - 2, 12, 8);
        if (state === 'typing') {
          ctx.fillStyle = sc + '90';
          for (let i = 0; i < 2; i++) ctx.fillRect(x - 4, y + i * 3, 4 + Math.sin(t * 3 + i) * 3, 1);
        }
      }

      // Legs
      ctx.fillStyle = 'var(--color-border)';
      if (isWalking) {
        ctx.fillRect(x - 3 + (facingRight ? 0 : -1), y + 8 + bob + legAnim, 3, 6);
        ctx.fillRect(x + (facingRight ? 1 : 0), y + 8 + bob - legAnim, 3, 6);
      } else {
        ctx.fillRect(x - 3, y + 8 + bob, 3, 6);
        ctx.fillRect(x + 1, y + 8 + bob, 3, 6);
      }

      // Body
      ctx.fillStyle = bodyColor;
      ctx.fillRect(x - 5, y - 2 + bob, 10, 10);

      // Head
      const headBob = state === 'thinking' ? Math.sin(t * 1.5) * 1.5 : 0;
      ctx.fillStyle = '#d4d4d8';
      ctx.fillRect(x - 4, y - 10 + bob + headBob, 8, 8);

      // Eyes
      const blink = Math.sin(t * 0.3) > 0.95 ? 0 : 2;
      ctx.fillStyle = color;
      const eyeDir = facingRight ? 1 : -1;
      ctx.fillRect(x - 2 + eyeDir, y - 7 + bob + headBob, 2, blink);
      ctx.fillRect(x + 1 + eyeDir, y - 7 + bob + headBob, 2, blink);

      // Hair / hat (color-coded)
      ctx.fillStyle = bodyColor;
      ctx.fillRect(x - 4, y - 11 + bob + headBob, 8, 2);

      // Arms
      ctx.fillStyle = bodyColor;
      if (state === 'typing' && atDesk) {
        ctx.fillRect(x - 8, y + 1 + bob + Math.sin(t * 5) * 1.5, 3, 3);
        ctx.fillRect(x + 5, y + 1 + bob + Math.sin(t * 5 + Math.PI) * 1.5, 3, 3);
      } else if (isWalking) {
        ctx.fillRect(x - 7, y + bob + Math.sin(walkFrame * 0.4) * 2, 2, 5);
        ctx.fillRect(x + 5, y + bob - Math.sin(walkFrame * 0.4) * 2, 2, 5);
      } else {
        ctx.fillRect(x - 7, y + 2 + bob, 2, 5);
        ctx.fillRect(x + 5, y + 2 + bob, 2, 5);
      }

      // Carrying item (when walking to station)
      if (isWalking && state === 'reading') {
        ctx.fillStyle = '#fbbf24'; ctx.fillRect(x + (facingRight ? 7 : -9), y + 1 + bob, 4, 5); // clipboard
      }
      if (isWalking && state === 'searching') {
        ctx.fillStyle = 'var(--color-purple-light)'; ctx.fillRect(x + (facingRight ? 7 : -9), y - 2 + bob, 3, 3); // magnifier
      }

      // Activity particles
      if (state !== 'idle' && state !== 'done') {
        for (let i = 0; i < 2; i++) {
          const angle = t * 2 + i * Math.PI;
          const r = 12;
          ctx.globalAlpha = 0.3 + Math.sin(t * 2 + i) * 0.2;
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(x + Math.cos(angle) * r, y - 5 + Math.sin(angle) * r * 0.4 + bob, 1, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }

      // Name tag
      ctx.fillStyle = color; ctx.font = 'bold 7px -apple-system, sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(agent.name, x, y + 22 + bob);

      // Status bubble (only when active)
      if (state !== 'idle') {
        ctx.font = '7px -apple-system, sans-serif';
        const tw = ctx.measureText(agent.status).width;
        ctx.fillStyle = '#18181bee'; ctx.strokeStyle = color + '60'; ctx.lineWidth = 0.5;
        ctx.beginPath(); ctx.roundRect(x - tw / 2 - 3, y - 20 + bob + headBob, tw + 6, 10, 3); ctx.fill(); ctx.stroke();
        ctx.fillStyle = color;
        ctx.fillText(agent.status, x, y - 13 + bob + headBob);
      }
      ctx.textAlign = 'start';
    };

    const draw = () => {
      frameRef.current++;
      const t = frameRef.current / 15;
      const agents = [...agentsRef.current.values()];

      ctx.fillStyle = 'var(--color-bg)'; ctx.fillRect(0, 0, w, h);
      drawFurniture(t);

      // Move agents toward targets
      for (const a of agents) {
        const dx = a.targetX - a.x;
        const dy = a.targetY - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > 2) {
          const speed = 1.2;
          a.x += (dx / dist) * speed;
          a.y += (dy / dist) * speed;
          a.facingRight = dx > 0;
          a.walkFrame++;
        }
      }

      // Sort by Y for depth
      const sorted = [...agents].sort((a, b) => a.y - b.y);

      if (sorted.length === 0) {
        drawPixelAgent({
          name: 'TITAN', state: 'idle', status: 'Ready, Sir.', bodyColor: AGENT_BODY_COLORS[0],
          lastSeen: Date.now(), x: w / 2, y: h * 0.5, targetX: w / 2, targetY: h * 0.5,
          deskX: w / 2, deskY: h * 0.5, walkFrame: 0, facingRight: true, atDesk: true,
        }, t);
      } else {
        for (const a of sorted) drawPixelAgent(a, t + [...agentsRef.current.keys()].indexOf(a.name) * 0.3);
      }

      // Title
      ctx.fillStyle = 'var(--color-bg-tertiary)'; ctx.font = 'bold 9px -apple-system, sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(`TITAN Office — ${agents.length || 1} agent${agents.length !== 1 ? 's' : ''}`, w / 2, h - 6);
      ctx.textAlign = 'start';

      animId = requestAnimationFrame(draw);
    };

    draw();
    return () => cancelAnimationFrame(animId);
  }, []);

  return (
    <div className="h-full flex flex-col">
      <canvas ref={canvasRef} className="flex-1 w-full" style={{ imageRendering: 'pixelated' }} />
      {agentList.length > 0 && (
        <div className="px-3 py-1.5 bg-bg-secondary border-t border-border flex items-center gap-3 overflow-x-auto">
          {agentList.map((a) => (
            <div key={a.name} className="flex items-center gap-1.5 shrink-0">
              <div className="w-2 h-2 rounded-full" style={{
                backgroundColor: a.state !== 'idle' ? STATE_COLORS[a.state] : a.bodyColor,
                animation: a.state !== 'idle' && a.state !== 'done' ? 'pulse 1.5s infinite' : 'none'
              }} />
              <span className="text-xs text-text-secondary">{a.name}: {a.status}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
