import { useState, useEffect, useRef, useCallback } from 'react';
import { Network, Trash2, RefreshCw, ZoomIn, ZoomOut, Maximize2 } from 'lucide-react';
import { apiFetch } from '@/api/client';

interface GraphNode {
  id: string;
  label: string;
  type: string;
  size: number;
  facts: string[];
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
}

interface GraphEdge {
  from: string;
  to: string;
  label: string;
}

interface GraphData {
  graphReady: boolean;
  episodeCount: number;
  nodeCount: number;
  edgeCount: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

const TYPE_COLORS: Record<string, string> = {
  person: '#818cf8',
  topic: '#22d3ee',
  project: '#34d399',
  place: '#fbbf24',
  fact: '#f472b6',
  tool: '#fb923c',
  preference: '#a78bfa',
};

const TYPE_LABELS: Record<string, string> = {
  person: 'Person',
  topic: 'Topic',
  project: 'Project',
  place: 'Place',
  fact: 'Fact',
  tool: 'Tool',
  preference: 'Preference',
};

function getColor(type: string): string {
  return TYPE_COLORS[type?.toLowerCase()] ?? '#64748b';
}

function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

// Force-directed layout with smoother convergence
function layoutNodes(nodes: GraphNode[], edges: GraphEdge[], width: number, height: number) {
  const cx = width / 2, cy = height / 2;
  // Distribute in a circle initially for more organic look
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.x === undefined) {
      const angle = (i / nodes.length) * Math.PI * 2 + (Math.random() - 0.5) * 0.5;
      const r = Math.min(width, height) * 0.25 + Math.random() * Math.min(width, height) * 0.1;
      n.x = cx + Math.cos(angle) * r;
      n.y = cy + Math.sin(angle) * r;
      n.vx = 0;
      n.vy = 0;
    }
  }

  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const iterations = 120;
  const repulsion = 4000;
  const attraction = 0.004;
  const centerGravity = 0.008;

  for (let iter = 0; iter < iterations; iter++) {
    const damping = 0.92 - (iter / iterations) * 0.2; // Slow down over time

    // Repulsion between all pairs
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        let dx = a.x! - b.x!, dy = a.y! - b.y!;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const force = repulsion / (dist * dist);
        dx = (dx / dist) * force;
        dy = (dy / dist) * force;
        a.vx! += dx; a.vy! += dy;
        b.vx! -= dx; b.vy! -= dy;
      }
    }

    // Attraction along edges
    for (const e of edges) {
      const a = nodeMap.get(e.from), b = nodeMap.get(e.to);
      if (!a || !b) continue;
      const dx = b.x! - a.x!, dy = b.y! - a.y!;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = dist * attraction;
      const fx = (dx / dist) * force, fy = (dy / dist) * force;
      a.vx! += fx; a.vy! += fy;
      b.vx! -= fx; b.vy! -= fy;
    }

    // Center gravity
    for (const n of nodes) {
      n.vx! += (cx - n.x!) * centerGravity;
      n.vy! += (cy - n.y!) * centerGravity;
    }

    // Apply velocity with damping
    for (const n of nodes) {
      n.vx! *= damping;
      n.vy! *= damping;
      n.x! += n.vx!;
      n.y! += n.vy!;
      n.x = Math.max(60, Math.min(width - 60, n.x!));
      n.y = Math.max(60, Math.min(height - 60, n.y!));
    }
  }
}

// Curved edge control point for bezier
function getControlPoint(ax: number, ay: number, bx: number, by: number, offset: number) {
  const mx = (ax + bx) / 2;
  const my = (ay + by) / 2;
  const dx = bx - ax;
  const dy = by - ay;
  const nx = -dy;
  const ny = dx;
  const len = Math.sqrt(nx * nx + ny * ny) || 1;
  return { cx: mx + (nx / len) * offset, cy: my + (ny / len) * offset };
}

// Draw arrowhead along bezier curve
function drawArrowhead(ctx: CanvasRenderingContext2D, bx: number, by: number, cx: number, cy: number, radius: number, color: string) {
  const angle = Math.atan2(by - cy, bx - cx);
  const arrowLen = 8;
  const arrowWidth = 4;
  const tipX = bx - Math.cos(angle) * radius;
  const tipY = by - Math.sin(angle) * radius;

  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(
    tipX - Math.cos(angle - Math.PI / 6) * arrowLen,
    tipY - Math.sin(angle - Math.PI / 6) * arrowLen,
  );
  ctx.lineTo(
    tipX - Math.cos(angle) * arrowLen * 0.5,
    tipY - Math.sin(angle) * arrowLen * 0.5,
  );
  ctx.lineTo(
    tipX - Math.cos(angle + Math.PI / 6) * arrowLen,
    tipY - Math.sin(angle + Math.PI / 6) * arrowLen,
  );
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

// Animated demo graph for empty state
function DemoGraph() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    const W = rect.width, H = rect.height;
    const cx = W / 2, cy = H / 2;

    // Demo nodes
    const demoTypes = ['person', 'topic', 'project', 'tool', 'fact', 'preference'];
    const demoNodes = demoTypes.map((t, i) => {
      const angle = (i / demoTypes.length) * Math.PI * 2 - Math.PI / 2;
      const r = Math.min(W, H) * 0.28;
      return { type: t, x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r, baseR: 16 + Math.random() * 8 };
    });

    const demoEdges = [
      [0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 0], [0, 2], [1, 4],
    ];

    let frame = 0;
    const animate = () => {
      frame++;
      ctx.clearRect(0, 0, W, H);

      // Subtle grid
      ctx.fillStyle = 'rgba(255,255,255,0.015)';
      for (let gx = 0; gx < W; gx += 30) {
        for (let gy = 0; gy < H; gy += 30) {
          ctx.fillRect(gx, gy, 1, 1);
        }
      }

      // Floating particle effect
      for (let i = 0; i < 20; i++) {
        const px = ((frame * 0.3 + i * 97) % W);
        const py = ((frame * 0.2 + i * 137) % H);
        const alpha = 0.03 + Math.sin(frame * 0.01 + i) * 0.02;
        ctx.beginPath();
        ctx.arc(px, py, 1.5, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(99,102,241,${alpha})`;
        ctx.fill();
      }

      // Edges with gradient
      for (const [fi, ti] of demoEdges) {
        const a = demoNodes[fi], b = demoNodes[ti];
        const pulse = 0.06 + Math.sin(frame * 0.02 + fi) * 0.03;

        const { cx: cpx, cy: cpy } = getControlPoint(a.x, a.y, b.x, b.y, 15);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.quadraticCurveTo(cpx, cpy, b.x, b.y);
        ctx.strokeStyle = `rgba(148,163,184,${pulse})`;
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // Nodes with breathing glow
      for (let i = 0; i < demoNodes.length; i++) {
        const n = demoNodes[i];
        const color = getColor(n.type);
        const [cr, cg, cb] = hexToRgb(color);
        const breathe = Math.sin(frame * 0.03 + i * 1.2) * 0.12;
        const r = n.baseR + breathe * 4;

        // Outer glow
        const glow = ctx.createRadialGradient(n.x, n.y, r * 0.3, n.x, n.y, r * 3);
        glow.addColorStop(0, `rgba(${cr},${cg},${cb},${0.08 + breathe})`);
        glow.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(n.x, n.y, r * 3, 0, Math.PI * 2);
        ctx.fill();

        // Node body with gradient
        const grad = ctx.createRadialGradient(n.x - r * 0.3, n.y - r * 0.3, 0, n.x, n.y, r);
        grad.addColorStop(0, `rgba(${cr},${cg},${cb},0.35)`);
        grad.addColorStop(1, `rgba(${cr},${cg},${cb},0.12)`);
        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.fillStyle = grad;
        ctx.fill();

        // Ring
        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${cr},${cg},${cb},${0.5 + breathe})`;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      frameRef.current = requestAnimationFrame(animate);
    };

    frameRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frameRef.current);
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: '100%', height: 320 }}
      className="opacity-40"
    />
  );
}

function MemoryGraphPanel() {
  const [data, setData] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [hoverNode, setHoverNode] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const panRef = useRef({ x: 0, y: 0, zoom: 1, dragging: false, startX: 0, startY: 0 });
  const animFrameRef = useRef(0);
  const timeRef = useRef(0);

  const fetchData = useCallback(async () => {
    try {
      const res = await apiFetch('/api/graphiti', { headers: { 'Content-Type': 'application/json' } });
      if (!res.ok) throw new Error(`${res.status}: ${res.statusText}`);
      const d = await res.json();
      if (d.nodes?.length) {
        layoutNodes(d.nodes, d.edges ?? [], 900, 560);
      }
      setData(d);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load graph');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleClear = async () => {
    if (!confirm('Clear the entire memory graph? This cannot be undone.')) return;
    try {
      await apiFetch('/api/graphiti', { method: 'DELETE' });
      fetchData();
      setSelectedNode(null);
    } catch { /* ignore */ }
  };

  const handleZoom = (delta: number) => {
    const pan = panRef.current;
    pan.zoom = Math.max(0.3, Math.min(3, pan.zoom * delta));
    setHoverNode((h) => h); // trigger redraw
  };

  const handleFitView = () => {
    panRef.current = { x: 0, y: 0, zoom: 1, dragging: false, startX: 0, startY: 0 };
    setHoverNode((h) => h);
  };

  // Animated rendering loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !data?.nodes?.length) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const W = rect.width, H = rect.height;
    const { nodes, edges } = data;
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));

    const draw = () => {
      timeRef.current++;
      const t = timeRef.current;
      const pan = panRef.current;

      ctx.clearRect(0, 0, W, H);

      // Dark background with subtle gradient
      const bgGrad = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, W * 0.7);
      bgGrad.addColorStop(0, '#0c0c14');
      bgGrad.addColorStop(1, '#09090b');
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, W, H);

      // Subtle grid dots
      ctx.fillStyle = 'rgba(255,255,255,0.02)';
      const grid = 35 * pan.zoom;
      const offX = (pan.x % grid + grid) % grid;
      const offY = (pan.y % grid + grid) % grid;
      for (let gx = offX; gx < W; gx += grid) {
        for (let gy = offY; gy < H; gy += grid) {
          ctx.fillRect(gx, gy, 1, 1);
        }
      }

      // Floating particles for atmosphere
      for (let i = 0; i < 15; i++) {
        const px = ((t * 0.15 + i * 127) % W);
        const py = ((t * 0.1 + i * 173) % H);
        const alpha = 0.02 + Math.sin(t * 0.008 + i) * 0.01;
        ctx.beginPath();
        ctx.arc(px, py, 1, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(99,102,241,${alpha})`;
        ctx.fill();
      }

      // Connected to selected/hovered
      const highlightSet = new Set<string>();
      const focusId = selectedNode?.id ?? hoverNode;
      if (focusId) {
        highlightSet.add(focusId);
        for (const e of edges) {
          if (e.from === focusId) highlightSet.add(e.to);
          if (e.to === focusId) highlightSet.add(e.from);
        }
      }

      // Edges — curved bezier with arrowheads
      for (const e of edges) {
        const a = nodeMap.get(e.from), b = nodeMap.get(e.to);
        if (!a || !b) continue;
        const ax = a.x! * pan.zoom + pan.x, ay = a.y! * pan.zoom + pan.y;
        const bx = b.x! * pan.zoom + pan.x, by = b.y! * pan.zoom + pan.y;

        const isEdgeHighlighted = focusId && (e.from === focusId || e.to === focusId);
        const isDimmed = focusId && !highlightSet.has(e.from) && !highlightSet.has(e.to);

        // Curve offset — vary per edge to avoid overlap
        const edgeIndex = edges.indexOf(e);
        const curveOffset = 20 + (edgeIndex % 3) * 8;
        const { cx: cpx, cy: cpy } = getControlPoint(ax, ay, bx, by, curveOffset * (edgeIndex % 2 === 0 ? 1 : -1));

        // Edge glow for highlighted
        if (isEdgeHighlighted) {
          ctx.beginPath();
          ctx.moveTo(ax, ay);
          ctx.quadraticCurveTo(cpx, cpy, bx, by);
          ctx.strokeStyle = 'rgba(99,102,241,0.15)';
          ctx.lineWidth = 6;
          ctx.stroke();
        }

        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.quadraticCurveTo(cpx, cpy, bx, by);

        if (isDimmed) {
          ctx.strokeStyle = 'rgba(100,116,139,0.06)';
          ctx.lineWidth = 0.5;
        } else if (isEdgeHighlighted) {
          const edgeColor = getColor(a.type);
          const [r, g, b_] = hexToRgb(edgeColor);
          ctx.strokeStyle = `rgba(${r},${g},${b_},0.5)`;
          ctx.lineWidth = 2;
        } else {
          ctx.strokeStyle = 'rgba(100,116,139,0.15)';
          ctx.lineWidth = 0.8;
        }
        ctx.stroke();

        // Arrowhead
        if (!isDimmed) {
          const bRadius = Math.max(14, Math.min(30, (b.size || 16))) * pan.zoom;
          const arrowColor = isEdgeHighlighted
            ? `rgba(148,163,184,0.7)`
            : `rgba(100,116,139,0.2)`;
          drawArrowhead(ctx, bx, by, cpx, cpy, bRadius + 4, arrowColor);
        }

        // Edge label on highlight
        if (isEdgeHighlighted && e.label) {
          const mt = 0.5;
          const mx = (1 - mt) * (1 - mt) * ax + 2 * (1 - mt) * mt * cpx + mt * mt * bx;
          const my = (1 - mt) * (1 - mt) * ay + 2 * (1 - mt) * mt * cpy + mt * mt * by;

          ctx.font = `${Math.max(9, 10 * pan.zoom)}px "Inter", system-ui, sans-serif`;
          const tw = ctx.measureText(e.label).width + 12;
          ctx.fillStyle = 'rgba(15,15,25,0.85)';
          ctx.beginPath();
          ctx.roundRect(mx - tw / 2, my - 11, tw, 18, 4);
          ctx.fill();
          ctx.strokeStyle = 'rgba(99,102,241,0.3)';
          ctx.lineWidth = 0.5;
          ctx.stroke();

          ctx.fillStyle = '#a5b4fc';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(e.label, mx, my);
        }
      }

      // Nodes
      for (const n of nodes) {
        const color = getColor(n.type);
        const [cr, cg, cb] = hexToRgb(color);
        const baseRadius = Math.max(14, Math.min(30, (n.size || 16)));
        const breathe = Math.sin(t * 0.025 + n.id.charCodeAt(0) * 0.5) * 1.5;
        const radius = (baseRadius + breathe) * pan.zoom;
        const tx = n.x! * pan.zoom + pan.x;
        const ty = n.y! * pan.zoom + pan.y;

        const isHover = hoverNode === n.id;
        const isSelected = selectedNode?.id === n.id;
        const isFocused = isHover || isSelected;
        const isDimmed = focusId && !highlightSet.has(n.id);

        // Outer glow (always, subtle breathing)
        if (!isDimmed) {
          const glowIntensity = isFocused ? 0.2 : 0.06 + Math.sin(t * 0.02 + n.id.charCodeAt(0)) * 0.02;
          const glowSize = isFocused ? radius * 4 : radius * 2.5;
          const glow = ctx.createRadialGradient(tx, ty, radius * 0.3, tx, ty, glowSize);
          glow.addColorStop(0, `rgba(${cr},${cg},${cb},${glowIntensity})`);
          glow.addColorStop(0.5, `rgba(${cr},${cg},${cb},${glowIntensity * 0.3})`);
          glow.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
          ctx.fillStyle = glow;
          ctx.beginPath();
          ctx.arc(tx, ty, glowSize, 0, Math.PI * 2);
          ctx.fill();
        }

        // Node body — gradient fill
        const bodyGrad = ctx.createRadialGradient(
          tx - radius * 0.3, ty - radius * 0.35, 0,
          tx, ty, radius,
        );
        if (isDimmed) {
          bodyGrad.addColorStop(0, `rgba(${cr},${cg},${cb},0.06)`);
          bodyGrad.addColorStop(1, `rgba(${cr},${cg},${cb},0.02)`);
        } else {
          bodyGrad.addColorStop(0, `rgba(${cr},${cg},${cb},${isFocused ? 0.45 : 0.3})`);
          bodyGrad.addColorStop(1, `rgba(${cr},${cg},${cb},${isFocused ? 0.18 : 0.08})`);
        }
        ctx.beginPath();
        ctx.arc(tx, ty, radius, 0, Math.PI * 2);
        ctx.fillStyle = bodyGrad;
        ctx.fill();

        // Ring
        ctx.beginPath();
        ctx.arc(tx, ty, radius, 0, Math.PI * 2);
        if (isDimmed) {
          ctx.strokeStyle = `rgba(${cr},${cg},${cb},0.1)`;
          ctx.lineWidth = 0.5;
        } else if (isFocused) {
          ctx.strokeStyle = `rgba(${cr},${cg},${cb},0.9)`;
          ctx.lineWidth = 2.5;
        } else {
          ctx.strokeStyle = `rgba(${cr},${cg},${cb},0.5)`;
          ctx.lineWidth = 1.2;
        }
        ctx.stroke();

        // Selection ring (animated dash)
        if (isSelected) {
          ctx.beginPath();
          ctx.arc(tx, ty, radius + 5, 0, Math.PI * 2);
          ctx.setLineDash([4, 4]);
          ctx.lineDashOffset = -t * 0.3;
          ctx.strokeStyle = `rgba(${cr},${cg},${cb},0.4)`;
          ctx.lineWidth = 1;
          ctx.stroke();
          ctx.setLineDash([]);
        }

        // Label
        if (!isDimmed) {
          const maxLen = pan.zoom > 0.8 ? 16 : 10;
          const lbl = n.label.length > maxLen ? n.label.slice(0, maxLen - 1) + '\u2026' : n.label;
          const fontSize = Math.max(9, 11 * pan.zoom);

          // Text shadow/background
          ctx.font = `600 ${fontSize}px "Inter", system-ui, sans-serif`;
          const textW = ctx.measureText(lbl).width + 8;
          ctx.fillStyle = 'rgba(9,9,11,0.7)';
          ctx.beginPath();
          ctx.roundRect(tx - textW / 2, ty - fontSize / 2 - 1, textW, fontSize + 2, 3);
          ctx.fill();

          ctx.fillStyle = isFocused ? '#fafafa' : '#e4e4e7';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(lbl, tx, ty);

          // Type label below
          if (pan.zoom > 0.5) {
            const typeFontSize = Math.max(7, 8 * pan.zoom);
            ctx.font = `500 ${typeFontSize}px "Inter", system-ui, sans-serif`;
            ctx.fillStyle = `rgba(${cr},${cg},${cb},${isFocused ? 0.9 : 0.6})`;
            ctx.fillText(n.type, tx, ty + radius + Math.max(10, 12 * pan.zoom));
          }
        }
      }

      // Legend
      const types = [...new Set(nodes.map((n) => n.type))];
      if (types.length > 0) {
        const legendH = 28;
        const legendW = types.length * 85 + 16;
        const legendX = W / 2 - legendW / 2;
        const legendY = H - legendH - 8;

        ctx.fillStyle = 'rgba(9,9,11,0.8)';
        ctx.beginPath();
        ctx.roundRect(legendX, legendY, legendW, legendH, 6);
        ctx.fill();
        ctx.strokeStyle = 'rgba(63,63,70,0.5)';
        ctx.lineWidth = 0.5;
        ctx.stroke();

        let lx = legendX + 12;
        ctx.font = '10px "Inter", system-ui, sans-serif';
        ctx.textBaseline = 'middle';
        for (const tp of types) {
          const c = getColor(tp);
          const [r, g, b_] = hexToRgb(c);

          // Colored dot
          ctx.beginPath();
          ctx.arc(lx + 4, legendY + legendH / 2, 4, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${r},${g},${b_},0.7)`;
          ctx.fill();

          ctx.fillStyle = '#a1a1aa';
          ctx.textAlign = 'left';
          ctx.fillText(TYPE_LABELS[tp] ?? tp, lx + 12, legendY + legendH / 2);
          lx += 85;
        }
      }

      animFrameRef.current = requestAnimationFrame(draw);
    };

    animFrameRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animFrameRef.current);
  }, [data, hoverNode, selectedNode]);

  // Canvas mouse handlers
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !data?.nodes?.length) return;

    const pan = panRef.current;

    const getNodeAt = (clientX: number, clientY: number): GraphNode | null => {
      const rect = canvas.getBoundingClientRect();
      const mx = clientX - rect.left, my = clientY - rect.top;
      for (const n of [...data.nodes].reverse()) { // Reverse so top-drawn nodes are hit first
        const radius = Math.max(14, Math.min(30, (n.size || 16))) * pan.zoom;
        const tx = n.x! * pan.zoom + pan.x;
        const ty = n.y! * pan.zoom + pan.y;
        const dx = mx - tx, dy = my - ty;
        if (dx * dx + dy * dy <= (radius + 4) * (radius + 4)) return n;
      }
      return null;
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      const oldZoom = pan.zoom;
      const delta = e.deltaY > 0 ? 0.92 : 1.08;
      pan.zoom = Math.max(0.3, Math.min(3, pan.zoom * delta));

      // Zoom toward mouse position
      pan.x = mx - (mx - pan.x) * (pan.zoom / oldZoom);
      pan.y = my - (my - pan.y) * (pan.zoom / oldZoom);

      setHoverNode((h) => h);
    };

    const onMouseDown = (e: MouseEvent) => {
      pan.dragging = true;
      pan.startX = e.clientX - pan.x;
      pan.startY = e.clientY - pan.y;
      canvas.style.cursor = 'grabbing';
    };

    const onMouseMove = (e: MouseEvent) => {
      if (pan.dragging) {
        pan.x = e.clientX - pan.startX;
        pan.y = e.clientY - pan.startY;
        setHoverNode((h) => h);
      } else {
        const node = getNodeAt(e.clientX, e.clientY);
        setHoverNode(node?.id ?? null);
        canvas.style.cursor = node ? 'pointer' : 'grab';
      }
    };

    const onMouseUp = () => {
      pan.dragging = false;
      canvas.style.cursor = 'grab';
    };

    const onClick = (e: MouseEvent) => {
      if (pan.dragging) return;
      const node = getNodeAt(e.clientX, e.clientY);
      setSelectedNode((prev) => (prev?.id === node?.id ? null : node ?? null));
    };

    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mouseup', onMouseUp);
    canvas.addEventListener('mouseleave', onMouseUp);
    canvas.addEventListener('click', onClick);

    return () => {
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('mousedown', onMouseDown);
      canvas.removeEventListener('mousemove', onMouseMove);
      canvas.removeEventListener('mouseup', onMouseUp);
      canvas.removeEventListener('mouseleave', onMouseUp);
      canvas.removeEventListener('click', onClick);
    };
  }, [data]);

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-12 animate-pulse rounded-xl bg-[#18181b]" />
        <div className="h-[560px] animate-pulse rounded-xl border border-[#3f3f46] bg-[#09090b]" />
      </div>
    );
  }

  const hasNodes = data && data.nodes.length > 0;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#6366f1]/10">
            <Network className="h-4 w-4 text-[#818cf8]" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-[#fafafa]">Memory Graph</h2>
            <p className="text-xs text-[#52525b]">Temporal knowledge graph powered by entity extraction</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {hasNodes && (
            <>
              <button
                onClick={() => handleZoom(1.2)}
                className="rounded-lg p-1.5 text-[#71717a] hover:bg-[#27272a] hover:text-[#fafafa] transition-colors"
                title="Zoom in"
              >
                <ZoomIn className="h-4 w-4" />
              </button>
              <button
                onClick={() => handleZoom(0.8)}
                className="rounded-lg p-1.5 text-[#71717a] hover:bg-[#27272a] hover:text-[#fafafa] transition-colors"
                title="Zoom out"
              >
                <ZoomOut className="h-4 w-4" />
              </button>
              <button
                onClick={handleFitView}
                className="rounded-lg p-1.5 text-[#71717a] hover:bg-[#27272a] hover:text-[#fafafa] transition-colors"
                title="Fit view"
              >
                <Maximize2 className="h-4 w-4" />
              </button>
              <div className="mx-1 h-4 w-px bg-[#27272a]" />
            </>
          )}
          <button
            onClick={fetchData}
            className="flex items-center gap-1.5 rounded-lg bg-[#27272a] px-3 py-1.5 text-xs text-[#a1a1aa] hover:bg-[#3f3f46] hover:text-[#fafafa] transition-colors"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </button>
          <button
            onClick={handleClear}
            className="flex items-center gap-1.5 rounded-lg bg-[#27272a] px-3 py-1.5 text-xs text-[#ef4444] hover:bg-[#ef4444]/10 transition-colors"
          >
            <Trash2 className="h-3.5 w-3.5" /> Clear
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-[#ef4444]/50 bg-[#ef4444]/5 p-4 text-sm text-[#ef4444]">{error}</div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'Entities', value: data?.nodeCount ?? 0, color: '#818cf8' },
          { label: 'Relationships', value: data?.edgeCount ?? 0, color: '#22d3ee' },
          { label: 'Episodes', value: data?.episodeCount ?? 0, color: '#34d399' },
        ].map(({ label, value, color }) => (
          <div key={label} className="rounded-xl border border-[#3f3f46] bg-[#18181b] px-4 py-3">
            <p className="text-xs text-[#71717a]">{label}</p>
            <div className="flex items-baseline gap-2">
              <p className="text-2xl font-bold" style={{ color }}>{value.toLocaleString()}</p>
              {value > 0 && (
                <div className="h-1.5 w-1.5 rounded-full animate-pulse" style={{ backgroundColor: color }} />
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Graph canvas */}
      {hasNodes ? (
        <div className="relative rounded-xl border border-[#3f3f46] bg-[#09090b] overflow-hidden shadow-2xl shadow-black/50">
          <canvas
            ref={canvasRef}
            style={{ width: '100%', height: 560, cursor: 'grab' }}
          />
          {/* Zoom indicator */}
          <div className="absolute bottom-3 right-3 rounded-md bg-[#09090b]/80 px-2 py-1 text-[10px] text-[#52525b] backdrop-blur-sm border border-[#27272a]">
            {Math.round(panRef.current.zoom * 100)}%
          </div>
        </div>
      ) : (
        <div className="relative rounded-xl border border-[#3f3f46] bg-[#09090b] overflow-hidden">
          <DemoGraph />
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[#6366f1]/10 backdrop-blur-sm border border-[#6366f1]/20 mb-4">
              <Network className="h-7 w-7 text-[#818cf8]" />
            </div>
            <p className="text-sm font-medium text-[#a1a1aa]">No entities in the graph yet</p>
            <p className="mt-1 max-w-sm text-center text-xs text-[#52525b]">
              Start chatting with TITAN to build the knowledge graph. Entities, relationships, and facts are extracted automatically from conversations.
            </p>
          </div>
        </div>
      )}

      {/* Selected node detail */}
      {selectedNode && (
        <div className="rounded-xl border border-[#3f3f46] bg-[#18181b] overflow-hidden">
          <div className="flex items-center gap-3 border-b border-[#27272a] px-4 py-3">
            <div className="h-3.5 w-3.5 rounded-full shadow-lg" style={{
              backgroundColor: getColor(selectedNode.type),
              boxShadow: `0 0 8px ${getColor(selectedNode.type)}40`,
            }} />
            <span className="font-semibold text-[#fafafa]">{selectedNode.label}</span>
            <span className="rounded-md bg-[#27272a] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-[#a1a1aa]">
              {selectedNode.type}
            </span>
          </div>
          <div className="space-y-3 p-4">
            {selectedNode.facts.length > 0 && (
              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-wider text-[#52525b]">Facts</p>
                <div className="space-y-1.5">
                  {selectedNode.facts.map((f, i) => (
                    <p key={i} className="text-xs text-[#d4d4d8] pl-3 border-l-2" style={{ borderColor: getColor(selectedNode.type) + '40' }}>
                      {f}
                    </p>
                  ))}
                </div>
              </div>
            )}
            {data && (() => {
              const related = data.edges.filter((e) => e.from === selectedNode.id || e.to === selectedNode.id);
              if (!related.length) return null;
              const nodeMap = new Map(data.nodes.map((n) => [n.id, n]));
              return (
                <div>
                  <p className="mb-2 text-xs font-medium uppercase tracking-wider text-[#52525b]">Relationships</p>
                  <div className="space-y-1.5">
                    {related.map((e, i) => {
                      const other = nodeMap.get(e.from === selectedNode.id ? e.to : e.from);
                      const otherColor = other ? getColor(other.type) : '#64748b';
                      return (
                        <div key={i} className="flex items-center gap-2 text-xs">
                          <span className="text-[#a1a1aa]">{e.label}</span>
                          <span className="text-[#52525b]">&rarr;</span>
                          <span className="inline-flex items-center gap-1.5">
                            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: otherColor }} />
                            <span className="text-[#d4d4d8]">{other?.label ?? '?'}</span>
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}
          </div>
        </div>
      )}
    </div>
  );
}

export default MemoryGraphPanel;
