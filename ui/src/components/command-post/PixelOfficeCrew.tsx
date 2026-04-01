/**
 * PixelOfficeCrew — Multi-agent pixel art visualization for Command Post.
 * Shows each registered agent as a pixel robot at their own desk.
 * Status-driven animations: idle, active, paused, error, stopped.
 */
import { useRef, useEffect } from 'react';
import type { RegisteredAgent, CPActivityEntry } from '@/api/types';

type PixelState = 'idle' | 'active' | 'paused' | 'error' | 'stopped';

const COLORS: Record<PixelState, string> = {
  idle: '#a1a1aa',
  active: '#22c55e',
  paused: '#f59e0b',
  error: '#ef4444',
  stopped: '#52525b',
};

const ROLE_ICONS: Record<string, string> = {
  ceo: 'C', manager: 'M', engineer: 'E', researcher: 'R', general: 'G',
};

interface Props {
  agents: RegisteredAgent[];
  activity: CPActivityEntry[];
}

export function PixelOfficeCrew({ agents, activity }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const agentsRef = useRef(agents);
  const activityRef = useRef(activity);
  agentsRef.current = agents;
  activityRef.current = activity;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    let animId: number;
    let frame = 0;

    const resize = () => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener('resize', resize);

    const draw = () => {
      frame++;
      const t = frame / 15;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      const agentsList = agentsRef.current;
      const recentActivity = activityRef.current;

      // Clear
      ctx.fillStyle = '#09090b';
      ctx.fillRect(0, 0, w, h);

      // Floor grid
      ctx.strokeStyle = '#141418';
      ctx.lineWidth = 0.5;
      for (let i = 0; i < w; i += 24) { ctx.beginPath(); ctx.moveTo(i, h * 0.72); ctx.lineTo(i, h); ctx.stroke(); }
      for (let j = h * 0.72; j < h; j += 24) { ctx.beginPath(); ctx.moveTo(0, j); ctx.lineTo(w, j); ctx.stroke(); }

      if (agentsList.length === 0) {
        // Empty state
        ctx.fillStyle = '#27272a';
        ctx.font = '12px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('No agents registered', w / 2, h / 2 - 10);
        ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.fillStyle = '#3f3f46';
        ctx.fillText('Spawn agents to see them here', w / 2, h / 2 + 10);
        ctx.textAlign = 'start';
        animId = requestAnimationFrame(draw);
        return;
      }

      // Calculate layout — agents evenly spaced
      const count = Math.min(agentsList.length, 8); // max 8 visible
      const slotW = Math.min(120, (w - 20) / count);
      const startX = (w - slotW * count) / 2 + slotW / 2;

      for (let i = 0; i < count; i++) {
        const agent = agentsList[i];
        const cx = startX + i * slotW;
        const cy = h * 0.55;
        const state = (agent.status === 'active' ? 'active' : agent.status) as PixelState;
        const color = COLORS[state] || COLORS.idle;
        const bobY = Math.sin(t * 0.8 + i * 1.5) * 1.5;

        // Is this agent doing something? Check recent activity
        const isWorking = recentActivity.some(a =>
          a.agentId === agent.id && (Date.now() - new Date(a.timestamp).getTime()) < 30000
        );

        // Desk
        const deskW = Math.min(70, slotW - 10);
        const deskH = 10;
        const deskX = cx - deskW / 2;
        const deskY = cy + 16;
        ctx.fillStyle = '#3f3f46';
        ctx.fillRect(deskX, deskY, deskW, deskH);
        ctx.fillStyle = '#52525b';
        ctx.fillRect(deskX + 1, deskY + 1, deskW - 2, deskH - 2);
        // Legs
        ctx.fillStyle = '#3f3f46';
        ctx.fillRect(deskX + 3, deskY + deskH, 3, 14);
        ctx.fillRect(deskX + deskW - 6, deskY + deskH, 3, 14);

        // Monitor
        const monW = 26;
        const monH = 18;
        const monX = cx - monW / 2;
        const monY = deskY - monH;
        ctx.fillStyle = '#27272a';
        ctx.fillRect(monX, monY, monW, monH);
        const screenColor = state === 'error' ? '#ef4444' : state === 'active' ? '#22c55e' : '#6366f1';
        ctx.fillStyle = screenColor + '30';
        ctx.fillRect(monX + 2, monY + 2, monW - 4, monH - 4);
        // Screen lines when active
        if (state === 'active' || isWorking) {
          ctx.fillStyle = screenColor + '60';
          const lines = 2 + Math.floor(t % 3);
          for (let l = 0; l < lines; l++) {
            const lw = 6 + Math.sin(t * 2 + l + i) * 5;
            ctx.fillRect(monX + 3, monY + 3 + l * 4, lw, 1.5);
          }
        }
        // Stand
        ctx.fillStyle = '#3f3f46';
        ctx.fillRect(cx - 2, deskY - 1, 4, 3);

        // Chair
        ctx.fillStyle = '#1e1e22';
        ctx.fillRect(cx - 10, cy + 10 + bobY, 20, 8);
        ctx.fillRect(cx - 11, cy - 2 + bobY, 3, 20);

        // Body
        ctx.fillStyle = '#3f3f46';
        ctx.fillRect(cx - 7, cy + bobY, 14, 12);

        // Head
        const headBob = state === 'active' && isWorking ? Math.sin(t * 1.5 + i) * 1.5 : 0;
        ctx.fillStyle = '#52525b';
        ctx.fillRect(cx - 6, cy - 10 + bobY + headBob, 12, 10);

        // Eyes
        const blinkPhase = Math.sin(t * 0.3 + i * 2);
        const eyeH = blinkPhase > 0.95 ? 1 : 2;
        ctx.fillStyle = color;
        if (state === 'stopped') {
          // X eyes
          ctx.fillRect(cx - 4, cy - 7 + bobY + headBob, 2, 1);
          ctx.fillRect(cx - 3, cy - 6 + bobY + headBob, 2, 1);
          ctx.fillRect(cx + 1, cy - 7 + bobY + headBob, 2, 1);
          ctx.fillRect(cx + 2, cy - 6 + bobY + headBob, 2, 1);
        } else {
          ctx.fillRect(cx - 4, cy - 7 + bobY + headBob, 2, eyeH);
          ctx.fillRect(cx + 2, cy - 7 + bobY + headBob, 2, eyeH);
        }

        // Antenna
        ctx.fillStyle = '#52525b';
        ctx.fillRect(cx - 1, cy - 14 + bobY + headBob, 2, 4);
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(cx, cy - 15 + bobY + headBob, 2, 0, Math.PI * 2);
        ctx.fill();
        // Antenna glow for active
        if (state === 'active') {
          ctx.globalAlpha = 0.3 + Math.sin(t * 3 + i) * 0.2;
          ctx.beginPath();
          ctx.arc(cx, cy - 15 + bobY + headBob, 5, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = 1;
        }

        // Arms
        if (state === 'active' && isWorking) {
          const armL = Math.sin(t * 6 + i) * 2;
          const armR = Math.sin(t * 6 + i + Math.PI) * 2;
          ctx.fillStyle = '#3f3f46';
          ctx.fillRect(cx - 11, cy + 3 + bobY + armL, 4, 3);
          ctx.fillRect(cx + 7, cy + 3 + bobY + armR, 4, 3);
        } else {
          ctx.fillStyle = '#3f3f46';
          ctx.fillRect(cx - 10, cy + 5 + bobY, 3, 6);
          ctx.fillRect(cx + 7, cy + 5 + bobY, 3, 6);
        }

        // Status particles
        if (state === 'active' && isWorking) {
          for (let p = 0; p < 2; p++) {
            const angle = t * 1.5 + p * Math.PI + i;
            const radius = 14 + Math.sin(t + p) * 4;
            const px = cx + Math.cos(angle) * radius;
            const py = cy - 3 + Math.sin(angle) * radius * 0.4 + bobY;
            ctx.globalAlpha = 0.25 + Math.sin(t * 2 + p) * 0.15;
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(px, py, 1, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.globalAlpha = 1;
        }

        // Error sparks
        if (state === 'error') {
          for (let p = 0; p < 3; p++) {
            const sparkX = cx + Math.sin(t * 4 + p * 2) * 12;
            const sparkY = cy - 5 + Math.cos(t * 3 + p) * 8 + bobY;
            ctx.globalAlpha = 0.4 + Math.sin(t + p) * 0.3;
            ctx.fillStyle = '#ef4444';
            ctx.fillRect(sparkX - 1, sparkY - 1, 2, 2);
          }
          ctx.globalAlpha = 1;
        }

        // Name label
        ctx.fillStyle = state === 'stopped' ? '#3f3f46' : '#71717a';
        ctx.font = '9px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.textAlign = 'center';
        const label = agent.name.length > 10 ? agent.name.slice(0, 9) + '...' : agent.name;
        ctx.fillText(label, cx, deskY + deskH + 24);

        // Role badge
        const roleChar = ROLE_ICONS[agent.role] || 'G';
        ctx.fillStyle = color + '60';
        ctx.font = 'bold 7px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.fillText(roleChar, cx, deskY + deskH + 33);

        ctx.textAlign = 'start';
      }

      // Title
      ctx.fillStyle = '#27272a';
      ctx.font = 'bold 9px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('COMMAND POST', w / 2, h - 6);
      ctx.textAlign = 'start';

      // Activity ticker at top
      if (recentActivity.length > 0) {
        const latest = recentActivity[recentActivity.length - 1];
        const age = Date.now() - new Date(latest.timestamp).getTime();
        if (age < 60000) {
          ctx.fillStyle = '#6366f1' + '40';
          ctx.fillRect(0, 0, w, 16);
          ctx.fillStyle = '#a5b4fc';
          ctx.font = '8px -apple-system, BlinkMacSystemFont, sans-serif';
          const tickerText = latest.message.length > 60 ? latest.message.slice(0, 57) + '...' : latest.message;
          ctx.textAlign = 'center';
          ctx.fillText(tickerText, w / 2, 11);
          ctx.textAlign = 'start';
        }
      }

      animId = requestAnimationFrame(draw);
    };

    draw();
    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="w-full rounded-xl border border-white/[0.06]"
      style={{ height: 220, imageRendering: 'pixelated' }}
    />
  );
}
