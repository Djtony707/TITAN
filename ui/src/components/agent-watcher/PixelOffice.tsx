import { useRef, useEffect, useState } from 'react';
import type { AgentEvent } from '@/api/types';

type AgentState = 'idle' | 'thinking' | 'typing' | 'searching' | 'reading' | 'executing' | 'error' | 'done';

const STATE_COLORS: Record<AgentState, string> = {
  idle: '#6366f1',
  thinking: '#f59e0b',
  typing: '#22d3ee',
  searching: '#a78bfa',
  reading: '#34d399',
  executing: '#22d3ee',
  error: '#ef4444',
  done: '#22c55e',
};

const STATE_LABELS: Record<AgentState, string> = {
  idle: 'Ready, Sir.',
  thinking: 'Analyzing...',
  typing: 'Writing...',
  searching: 'Searching...',
  reading: 'Reading...',
  executing: 'Executing...',
  error: 'Error occurred',
  done: 'Task complete!',
};

function toolToState(toolName?: string): AgentState {
  if (!toolName) return 'thinking';
  const name = toolName.toLowerCase();
  if (name.includes('search') || name.includes('browse') || name.includes('web')) return 'searching';
  if (name.includes('write') || name.includes('edit') || name.includes('shell')) return 'typing';
  if (name.includes('read') || name.includes('list')) return 'reading';
  if (name.includes('code_exec') || name.includes('exec')) return 'executing';
  if (name.includes('memory') || name.includes('graph')) return 'thinking';
  return 'typing';
}

export function PixelOffice({ events }: { events: AgentEvent[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [agentState, setAgentState] = useState<AgentState>('idle');
  const [statusText, setStatusText] = useState('Ready, Sir.');
  const [currentTool, setCurrentTool] = useState('');
  const frameRef = useRef(0);
  const stateRef = useRef<AgentState>('idle');
  const toolRef = useRef('');
  const statusRef = useRef('Ready, Sir.');

  // Update state from events
  useEffect(() => {
    const latest = events[events.length - 1];
    if (!latest) return;

    let newState: AgentState = 'idle';
    let newStatus = STATE_LABELS.idle;
    let newTool = '';

    if (latest.type === 'tool_start') {
      newState = toolToState(latest.toolName);
      newTool = latest.toolName || '';
      newStatus = `${newTool}...`;
    } else if (latest.type === 'tool_end') {
      newState = latest.status === 'error' ? 'error' : 'done';
      newTool = latest.toolName || '';
      newStatus = latest.status === 'error' ? `${newTool} failed` : `${newTool} done (${latest.durationMs}ms)`;
    } else if (latest.type === 'thinking') {
      newState = 'thinking';
      newStatus = 'Thinking...';
    } else if (latest.type === 'token') {
      newState = 'typing';
      newStatus = 'Responding...';
    } else if (latest.type === 'done') {
      newState = 'done';
      newStatus = 'Task complete!';
    }

    setAgentState(newState);
    setStatusText(newStatus);
    setCurrentTool(newTool);
    stateRef.current = newState;
    toolRef.current = newTool;
    statusRef.current = newStatus;
  }, [events]);

  // Canvas rendering loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);

    let animId: number;

    const draw = () => {
      frameRef.current++;
      const t = frameRef.current / 15; // 15fps feel
      const state = stateRef.current;
      const color = STATE_COLORS[state];

      // Clear
      ctx.fillStyle = '#09090b';
      ctx.fillRect(0, 0, w, h);

      const cx = w / 2;
      const cy = h * 0.55;

      // Floor grid (subtle)
      ctx.strokeStyle = '#1a1a1e';
      ctx.lineWidth = 0.5;
      for (let i = 0; i < w; i += 20) {
        ctx.beginPath();
        ctx.moveTo(i, h * 0.7);
        ctx.lineTo(i, h);
        ctx.stroke();
      }
      for (let j = h * 0.7; j < h; j += 20) {
        ctx.beginPath();
        ctx.moveTo(0, j);
        ctx.lineTo(w, j);
        ctx.stroke();
      }

      // Desk
      const deskW = 100;
      const deskH = 16;
      const deskX = cx - deskW / 2;
      const deskY = cy + 20;
      ctx.fillStyle = '#3f3f46';
      ctx.fillRect(deskX, deskY, deskW, deskH);
      ctx.fillStyle = '#52525b';
      ctx.fillRect(deskX + 2, deskY + 2, deskW - 4, deskH - 4);

      // Desk legs
      ctx.fillStyle = '#3f3f46';
      ctx.fillRect(deskX + 5, deskY + deskH, 4, 20);
      ctx.fillRect(deskX + deskW - 9, deskY + deskH, 4, 20);

      // Monitor
      const monW = 40;
      const monH = 28;
      const monX = cx - monW / 2;
      const monY = deskY - monH;
      ctx.fillStyle = '#27272a';
      ctx.fillRect(monX, monY, monW, monH);
      // Screen glow
      const screenColor = state === 'error' ? '#ef4444' : state === 'searching' ? '#a78bfa' : state === 'typing' ? '#22d3ee' : '#6366f1';
      ctx.fillStyle = screenColor + '40';
      ctx.fillRect(monX + 2, monY + 2, monW - 4, monH - 6);
      // Screen lines (typing effect)
      if (state === 'typing' || state === 'executing') {
        ctx.fillStyle = screenColor + '80';
        const lineCount = 3 + Math.floor(t % 3);
        for (let i = 0; i < lineCount; i++) {
          const lw = 10 + Math.sin(t * 2 + i) * 8;
          ctx.fillRect(monX + 4, monY + 4 + i * 5, lw, 2);
        }
      }
      // Monitor stand
      ctx.fillStyle = '#3f3f46';
      ctx.fillRect(cx - 3, deskY - 2, 6, 4);

      // Agent body (simple pixel robot)
      const bodyX = cx;
      const bodyY = cy - 5;
      const bobY = Math.sin(t * 0.8) * 1.5; // Gentle breathing

      // Chair
      ctx.fillStyle = '#27272a';
      ctx.fillRect(bodyX - 14, bodyY + 15 + bobY, 28, 12);
      ctx.fillRect(bodyX - 16, bodyY + 0 + bobY, 4, 28);

      // Body
      ctx.fillStyle = '#3f3f46';
      ctx.fillRect(bodyX - 10, bodyY + 2 + bobY, 20, 16);

      // Head
      const headBob = state === 'thinking' ? Math.sin(t * 1.5) * 2 : 0;
      ctx.fillStyle = '#52525b';
      ctx.fillRect(bodyX - 8, bodyY - 14 + bobY + headBob, 16, 14);

      // Eyes
      const blinkPhase = Math.sin(t * 0.3);
      const eyeH = blinkPhase > 0.95 ? 1 : 3; // Occasional blink
      ctx.fillStyle = color;
      ctx.fillRect(bodyX - 5, bodyY - 10 + bobY + headBob, 3, eyeH);
      ctx.fillRect(bodyX + 2, bodyY - 10 + bobY + headBob, 3, eyeH);

      // Antenna
      ctx.fillStyle = '#52525b';
      ctx.fillRect(bodyX - 1, bodyY - 18 + bobY + headBob, 2, 5);
      // Antenna light
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(bodyX, bodyY - 19 + bobY + headBob, 2.5, 0, Math.PI * 2);
      ctx.fill();
      // Antenna glow
      if (state !== 'idle') {
        ctx.globalAlpha = 0.3 + Math.sin(t * 3) * 0.2;
        ctx.beginPath();
        ctx.arc(bodyX, bodyY - 19 + bobY + headBob, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      // Arms (typing animation)
      if (state === 'typing' || state === 'executing') {
        const armL = Math.sin(t * 6) * 3;
        const armR = Math.sin(t * 6 + Math.PI) * 3;
        ctx.fillStyle = '#3f3f46';
        ctx.fillRect(bodyX - 16, bodyY + 6 + bobY + armL, 6, 4);
        ctx.fillRect(bodyX + 10, bodyY + 6 + bobY + armR, 6, 4);
      } else {
        ctx.fillStyle = '#3f3f46';
        ctx.fillRect(bodyX - 14, bodyY + 8 + bobY, 4, 8);
        ctx.fillRect(bodyX + 10, bodyY + 8 + bobY, 4, 8);
      }

      // Status particles
      if (state !== 'idle' && state !== 'done') {
        const particleCount = state === 'error' ? 5 : 3;
        for (let i = 0; i < particleCount; i++) {
          const angle = (t * 1.5 + i * (Math.PI * 2 / particleCount));
          const radius = 20 + Math.sin(t + i) * 5;
          const px = bodyX + Math.cos(angle) * radius;
          const py = bodyY - 5 + Math.sin(angle) * radius * 0.5 + bobY;
          const alpha = 0.3 + Math.sin(t * 2 + i) * 0.2;
          ctx.globalAlpha = alpha;
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(px, py, 1.5, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }

      // Done sparkles
      if (state === 'done') {
        for (let i = 0; i < 6; i++) {
          const angle = t * 0.5 + i * (Math.PI / 3);
          const radius = 25 + Math.sin(t * 2 + i) * 10;
          const px = bodyX + Math.cos(angle) * radius;
          const py = bodyY - 5 + Math.sin(angle) * radius * 0.6;
          const alpha = Math.max(0, Math.sin(t + i * 0.5));
          ctx.globalAlpha = alpha * 0.6;
          ctx.fillStyle = '#22c55e';
          ctx.fillRect(px - 1, py - 1, 2, 2);
        }
        ctx.globalAlpha = 1;
      }

      // Speech bubble
      const bubbleText = statusRef.current;
      if (bubbleText) {
        const bubbleX = bodyX + 25;
        const bubbleY = bodyY - 30 + bobY;
        ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
        const textWidth = ctx.measureText(bubbleText).width;
        const padX = 8;
        const padY = 4;
        const bw = textWidth + padX * 2;
        const bh = 16 + padY;

        // Bubble background
        ctx.fillStyle = '#18181b';
        ctx.strokeStyle = '#3f3f46';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(bubbleX, bubbleY, bw, bh, 6);
        ctx.fill();
        ctx.stroke();

        // Bubble tail
        ctx.fillStyle = '#18181b';
        ctx.beginPath();
        ctx.moveTo(bubbleX, bubbleY + bh / 2 - 3);
        ctx.lineTo(bubbleX - 6, bubbleY + bh / 2);
        ctx.lineTo(bubbleX, bubbleY + bh / 2 + 3);
        ctx.fill();

        // Text
        ctx.fillStyle = color;
        ctx.fillText(bubbleText, bubbleX + padX, bubbleY + padY + 10);
      }

      // TITAN label at bottom
      ctx.fillStyle = '#27272a';
      ctx.font = 'bold 10px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('TITAN', cx, h - 8);
      ctx.textAlign = 'start';

      animId = requestAnimationFrame(draw);
    };

    draw();
    return () => cancelAnimationFrame(animId);
  }, []);

  return (
    <div className="h-full flex flex-col">
      <canvas
        ref={canvasRef}
        className="flex-1 w-full"
        style={{ imageRendering: 'pixelated' }}
      />
      {/* Current tool bar */}
      {currentTool && (
        <div className="px-3 py-1.5 bg-[#18181b] border-t border-[#3f3f46] flex items-center gap-2">
          <div
            className="w-2 h-2 rounded-full animate-pulse"
            style={{ backgroundColor: STATE_COLORS[agentState] }}
          />
          <span className="text-xs text-[#a1a1aa] truncate">{statusText}</span>
        </div>
      )}
    </div>
  );
}
