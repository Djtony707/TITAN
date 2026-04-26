import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Network, Trash2, RefreshCw, ZoomIn, ZoomOut, Maximize2, Search, X } from 'lucide-react';
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

// Full color palette for all known entity types
const TYPE_COLORS: Record<string, string> = {
  person: '#818cf8',
  topic: '#22d3ee',
  project: '#34d399',
  place: '#fbbf24',
  fact: '#f472b6',
  tool: '#fb923c',
  preference: '#a78bfa',
  software: '#38bdf8',
  system: '#e879f9',
  event: '#fb7185',
  product: '#4ade80',
  company: '#facc15',
  file: '#94a3b8',
  technology: '#2dd4bf',
  hardware: '#f97316',
  component: '#c084fc',
  feature: '#67e8f9',
  directory: '#a1a1aa',
  social_post: '#ec4899',
};

const TYPE_LABELS: Record<string, string> = {
  person: 'Person',
  topic: 'Topic',
  project: 'Project',
  place: 'Place',
  fact: 'Fact',
  tool: 'Tool',
  preference: 'Preference',
  software: 'Software',
  system: 'System',
  event: 'Event',
  product: 'Product',
  company: 'Company',
  file: 'File',
  technology: 'Technology',
  hardware: 'Hardware',
  component: 'Component',
  feature: 'Feature',
  directory: 'Directory',
  social_post: 'Social Post',
};

// Fallback colors for types we haven't seen yet — cycle through distinct hues
const FALLBACK_COLORS = ['#f0abfc', '#86efac', '#fda4af', '#7dd3fc', '#d9f99d', '#fcd34d'];

function getColor(type: string): string {
  const key = type?.toLowerCase();
  if (TYPE_COLORS[key]) return TYPE_COLORS[key];
  // Deterministic fallback based on type string hash
  let hash = 0;
  for (let i = 0; i < (key?.length ?? 0); i++) hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  return FALLBACK_COLORS[Math.abs(hash) % FALLBACK_COLORS.length];
}

function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

// Scale-adaptive force-directed layout with type clustering
function layoutNodes(nodes: GraphNode[], edges: GraphEdge[], width: number, height: number) {
  const n = nodes.length;
  if (n === 0) return;

  const cx = width / 2, cy = height / 2;

  // Group nodes by type for cluster positioning
  const typeGroups = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const t = nodes[i].type?.toLowerCase() ?? 'unknown';
    if (!typeGroups.has(t)) typeGroups.set(t, []);
    typeGroups.get(t)!.push(i);
  }

  // Assign cluster centers in a circle
  const typeList = [...typeGroups.keys()];
  const clusterCenters = new Map<string, { x: number; y: number }>();
  const clusterRadius = Math.min(width, height) * 0.3;
  for (let i = 0; i < typeList.length; i++) {
    const angle = (i / typeList.length) * Math.PI * 2 - Math.PI / 2;
    clusterCenters.set(typeList[i], {
      x: cx + Math.cos(angle) * clusterRadius,
      y: cy + Math.sin(angle) * clusterRadius,
    });
  }

  // Initialize positions near cluster centers with jitter (only for new nodes)
  for (let i = 0; i < n; i++) {
    const node = nodes[i];
    if (node.x !== undefined) continue;
    const center = clusterCenters.get(node.type?.toLowerCase() ?? 'unknown') ?? { x: cx, y: cy };
    const jitter = Math.min(width, height) * 0.12;
    node.x = center.x + (Math.random() - 0.5) * jitter;
    node.y = center.y + (Math.random() - 0.5) * jitter;
    node.vx = 0;
    node.vy = 0;
  }

  const nodeMap = new Map(nodes.map((nd) => [nd.id, nd]));

  // Scale parameters with graph size
  const scaleFactor = Math.sqrt(n / 50);
  // Cap iterations for large graphs to prevent UI freeze
  const iterations = Math.min(200, Math.max(80, Math.round(60 + n * 0.2)));
  const repulsion = 4000 * scaleFactor;
  const attraction = 0.003 / scaleFactor;
  const centerGravity = 0.003 / scaleFactor;
  const clusterGravity = 0.015; // Pull toward type cluster center

  // Build adjacency for edge lookup
  const adjacency = new Map<string, Set<string>>();
  for (const e of edges) {
    if (!adjacency.has(e.from)) adjacency.set(e.from, new Set());
    if (!adjacency.has(e.to)) adjacency.set(e.to, new Set());
    adjacency.get(e.from)!.add(e.to);
    adjacency.get(e.to)!.add(e.from);
  }

  for (let iter = 0; iter < iterations; iter++) {
    const damping = 0.9 - (iter / iterations) * 0.35;
    const progress = iter / iterations;

    // Repulsion between all pairs (Coulomb's law)
    // Use a spatial grid for large graphs to skip distant pairs
    if (n > 200) {
      // Approximate: only repel against a random subset + connected neighbors
      for (let i = 0; i < n; i++) {
        const a = nodes[i];
        const neighbors = adjacency.get(a.id) ?? new Set();
        for (let j = i + 1; j < n; j++) {
          // Skip ~80% of distant pairs for large graphs
          if (!neighbors.has(nodes[j].id) && Math.random() > 0.2) continue;
          const b = nodes[j];
          let dx = a.x! - b.x!, dy = a.y! - b.y!;
          const distSq = dx * dx + dy * dy;
          const dist = Math.sqrt(distSq) || 1;
          const force = repulsion / (distSq + 100);
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          a.vx! += fx; a.vy! += fy;
          b.vx! -= fx; b.vy! -= fy;
        }
      }
    } else {
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const a = nodes[i], b = nodes[j];
          let dx = a.x! - b.x!, dy = a.y! - b.y!;
          const distSq = dx * dx + dy * dy;
          const dist = Math.sqrt(distSq) || 1;
          const force = repulsion / (distSq + 100);
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          a.vx! += fx; a.vy! += fy;
          b.vx! -= fx; b.vy! -= fy;
        }
      }
    }

    // Attraction along edges (Hooke's law)
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

    // Cluster gravity — pull nodes toward their type's center
    const clusterStrength = clusterGravity * (1 - progress * 0.5); // Fade over time
    for (const node of nodes) {
      const center = clusterCenters.get(node.type?.toLowerCase() ?? 'unknown');
      if (center) {
        node.vx! += (center.x - node.x!) * clusterStrength;
        node.vy! += (center.y - node.y!) * clusterStrength;
      }
    }

    // Mild center gravity to keep graph centered
    for (const node of nodes) {
      node.vx! += (cx - node.x!) * centerGravity;
      node.vy! += (cy - node.y!) * centerGravity;
    }

    // Apply velocity with damping
    const margin = 40;
    for (const node of nodes) {
      node.vx! *= damping;
      node.vy! *= damping;
      node.x! += node.vx!;
      node.y! += node.vy!;
      node.x = Math.max(margin, Math.min(width - margin, node.x!));
      node.y = Math.max(margin, Math.min(height - margin, node.y!));
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
function drawArrowhead(ctx: CanvasRenderingContext2D, bx: number, by: number, cx_: number, cy_: number, radius: number, color: string) {
  const angle = Math.atan2(by - cy_, bx - cx_);
  const arrowLen = 8;
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

function MemoryGraphPanel() {
  const [data, setData] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [hoverNode, setHoverNode] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set());
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const panRef = useRef({ x: 0, y: 0, zoom: 1, dragging: false, startX: 0, startY: 0 });
  const animFrameRef = useRef(0);
  const timeRef = useRef(0);

  // Preserve node positions across refreshes so the graph doesn't jump
  const positionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());

  const fetchData = useCallback(async () => {
    try {
      const res = await apiFetch('/api/graphiti', { headers: { 'Content-Type': 'application/json' } });
      if (!res.ok) throw new Error(`${res.status}: ${res.statusText}`);
      const d = await res.json();
      if (d.nodes?.length) {
        // Use actual container dimensions for layout
        const container = containerRef.current;
        const w = container?.clientWidth ?? 1200;
        const h = container?.clientHeight ?? 600;
        // Restore saved positions before layout so graph stays stable
        for (const node of d.nodes) {
          const saved = positionsRef.current.get(node.id);
          if (saved) {
            node.x = saved.x;
            node.y = saved.y;
          }
        }
        layoutNodes(d.nodes, d.edges ?? [], w, h);
        // Save new positions
        for (const node of d.nodes) {
          if (node.x !== undefined && node.y !== undefined) {
            positionsRef.current.set(node.id, { x: node.x, y: node.y });
          }
        }
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

  // Filtered nodes/edges based on search and type filters
  const filtered = useMemo(() => {
    if (!data) return { nodes: [], edges: [] };
    const query = searchQuery.toLowerCase().trim();
    let nodes = data.nodes;

    // Filter by hidden types
    if (hiddenTypes.size > 0) {
      nodes = nodes.filter((n) => !hiddenTypes.has(n.type?.toLowerCase()));
    }

    // Filter by search
    if (query) {
      const matchIds = new Set<string>();
      for (const n of nodes) {
        if (n.label.toLowerCase().includes(query) || n.facts.some((f) => f.toLowerCase().includes(query))) {
          matchIds.add(n.id);
        }
      }
      // Include neighbors of matches
      for (const e of data.edges) {
        if (matchIds.has(e.from)) matchIds.add(e.to);
        if (matchIds.has(e.to)) matchIds.add(e.from);
      }
      nodes = nodes.filter((n) => matchIds.has(n.id));
    }

    const nodeIds = new Set(nodes.map((n) => n.id));
    const edges = (data.edges ?? []).filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to));
    return { nodes, edges };
  }, [data, searchQuery, hiddenTypes]);

  // Search match node — auto-focus on first match
  const searchMatchId = useMemo(() => {
    if (!searchQuery.trim() || !data) return null;
    const q = searchQuery.toLowerCase().trim();
    const match = data.nodes.find((n) => n.label.toLowerCase().includes(q));
    return match?.id ?? null;
  }, [searchQuery, data]);

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
    pan.zoom = Math.max(0.2, Math.min(4, pan.zoom * delta));
    setHoverNode((h) => h);
  };

  const handleFitView = () => {
    panRef.current = { x: 0, y: 0, zoom: 1, dragging: false, startX: 0, startY: 0 };
    setHoverNode((h) => h);
  };

  const toggleType = (type: string) => {
    setHiddenTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  // Animated rendering loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !filtered.nodes.length) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const W = rect.width, H = rect.height;
    const { nodes, edges } = filtered;
    const nodeMap = new Map(nodes.map((nd) => [nd.id, nd]));

    const draw = () => {
      timeRef.current++;
      const t = timeRef.current;
      const pan = panRef.current;

      ctx.clearRect(0, 0, W, H);

      // Dark background
      const bgGrad = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, W * 0.7);
      bgGrad.addColorStop(0, '#0c0c14');
      bgGrad.addColorStop(1, '#09090b');
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, W, H);

      // Grid dots
      ctx.fillStyle = 'rgba(255,255,255,0.02)';
      const grid = 35 * pan.zoom;
      const offX = (pan.x % grid + grid) % grid;
      const offY = (pan.y % grid + grid) % grid;
      for (let gx = offX; gx < W; gx += grid) {
        for (let gy = offY; gy < H; gy += grid) {
          ctx.fillRect(gx, gy, 1, 1);
        }
      }

      // Floating particles
      for (let i = 0; i < 15; i++) {
        const px = ((t * 0.15 + i * 127) % W);
        const py = ((t * 0.1 + i * 173) % H);
        const alpha = 0.02 + Math.sin(t * 0.008 + i) * 0.01;
        ctx.beginPath();
        ctx.arc(px, py, 1, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(99,102,241,${alpha})`;
        ctx.fill();
      }

      // Focus set for highlighting
      const highlightSet = new Set<string>();
      const focusId = selectedNode?.id ?? hoverNode ?? searchMatchId;
      if (focusId) {
        highlightSet.add(focusId);
        for (const e of edges) {
          if (e.from === focusId) highlightSet.add(e.to);
          if (e.to === focusId) highlightSet.add(e.from);
        }
      }

      const hasFocus = focusId != null;

      // --- EDGES ---
      // When no focus: draw all edges very faintly
      // When focus: only draw edges connected to focus node
      for (const e of edges) {
        const a = nodeMap.get(e.from), b = nodeMap.get(e.to);
        if (!a || !b) continue;

        const isEdgeHighlighted = hasFocus && (e.from === focusId || e.to === focusId);
        const isDimmed = hasFocus && !isEdgeHighlighted;

        // When focused, skip unrelated edges entirely for clarity
        if (isDimmed && nodes.length > 100) continue;

        const ax = a.x! * pan.zoom + pan.x, ay = a.y! * pan.zoom + pan.y;
        const bx = b.x! * pan.zoom + pan.x, by = b.y! * pan.zoom + pan.y;

        // Skip off-screen edges
        if (ax < -50 && bx < -50) continue;
        if (ay < -50 && by < -50) continue;
        if (ax > W + 50 && bx > W + 50) continue;
        if (ay > H + 50 && by > H + 50) continue;

        const edgeIndex = edges.indexOf(e);
        const curveOffset = 15 + (edgeIndex % 3) * 6;
        const { cx: cpx, cy: cpy } = getControlPoint(ax, ay, bx, by, curveOffset * (edgeIndex % 2 === 0 ? 1 : -1));

        if (isEdgeHighlighted) {
          // Glow
          ctx.beginPath();
          ctx.moveTo(ax, ay);
          ctx.quadraticCurveTo(cpx, cpy, bx, by);
          ctx.strokeStyle = 'rgba(99,102,241,0.12)';
          ctx.lineWidth = 5;
          ctx.stroke();
        }

        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.quadraticCurveTo(cpx, cpy, bx, by);

        if (isEdgeHighlighted) {
          const edgeColor = getColor(a.type);
          const [r, g, b_] = hexToRgb(edgeColor);
          ctx.strokeStyle = `rgba(${r},${g},${b_},0.5)`;
          ctx.lineWidth = 1.8;
        } else {
          // Very faint when no focus, slightly visible
          ctx.strokeStyle = 'rgba(100,116,139,0.04)';
          ctx.lineWidth = 0.5;
        }
        ctx.stroke();

        // Arrowhead only on highlighted edges
        if (isEdgeHighlighted) {
          const bRadius = Math.max(10, Math.min(24, (b.size || 14))) * pan.zoom;
          drawArrowhead(ctx, bx, by, cpx, cpy, bRadius + 3, 'rgba(148,163,184,0.6)');
        }

        // Edge label on highlight
        if (isEdgeHighlighted && e.label && e.label !== 'co_mentioned') {
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

          ctx.fillStyle = 'var(--color-accent-light)';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(e.label, mx, my);
        }
      }

      // --- NODES ---
      for (const n of nodes) {
        const color = getColor(n.type);
        const [cr, cg, cb] = hexToRgb(color);
        const baseRadius = Math.max(8, Math.min(24, (n.size || 12)));
        const breathe = Math.sin(t * 0.025 + n.id.charCodeAt(0) * 0.5) * 1;
        const radius = (baseRadius + breathe) * pan.zoom;
        const tx = n.x! * pan.zoom + pan.x;
        const ty = n.y! * pan.zoom + pan.y;

        // Skip off-screen
        if (tx < -radius * 3 || ty < -radius * 3 || tx > W + radius * 3 || ty > H + radius * 3) continue;

        const isHover = hoverNode === n.id;
        const isSelected = selectedNode?.id === n.id;
        const isSearchMatch = searchMatchId === n.id;
        const isFocused = isHover || isSelected || isSearchMatch;
        const isDimmed = hasFocus && !highlightSet.has(n.id);

        // Outer glow
        if (!isDimmed) {
          const glowIntensity = isFocused ? 0.2 : 0.05 + Math.sin(t * 0.02 + n.id.charCodeAt(0)) * 0.015;
          const glowSize = isFocused ? radius * 3.5 : radius * 2;
          const glow = ctx.createRadialGradient(tx, ty, radius * 0.3, tx, ty, glowSize);
          glow.addColorStop(0, `rgba(${cr},${cg},${cb},${glowIntensity})`);
          glow.addColorStop(0.5, `rgba(${cr},${cg},${cb},${glowIntensity * 0.3})`);
          glow.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
          ctx.fillStyle = glow;
          ctx.beginPath();
          ctx.arc(tx, ty, glowSize, 0, Math.PI * 2);
          ctx.fill();
        }

        // Node body
        const bodyGrad = ctx.createRadialGradient(tx - radius * 0.3, ty - radius * 0.35, 0, tx, ty, radius);
        if (isDimmed) {
          bodyGrad.addColorStop(0, `rgba(${cr},${cg},${cb},0.06)`);
          bodyGrad.addColorStop(1, `rgba(${cr},${cg},${cb},0.02)`);
        } else {
          bodyGrad.addColorStop(0, `rgba(${cr},${cg},${cb},${isFocused ? 0.45 : 0.25})`);
          bodyGrad.addColorStop(1, `rgba(${cr},${cg},${cb},${isFocused ? 0.18 : 0.07})`);
        }
        ctx.beginPath();
        ctx.arc(tx, ty, radius, 0, Math.PI * 2);
        ctx.fillStyle = bodyGrad;
        ctx.fill();

        // Ring
        ctx.beginPath();
        ctx.arc(tx, ty, radius, 0, Math.PI * 2);
        if (isDimmed) {
          ctx.strokeStyle = `rgba(${cr},${cg},${cb},0.08)`;
          ctx.lineWidth = 0.5;
        } else if (isFocused) {
          ctx.strokeStyle = `rgba(${cr},${cg},${cb},0.9)`;
          ctx.lineWidth = 2.5;
        } else {
          ctx.strokeStyle = `rgba(${cr},${cg},${cb},0.4)`;
          ctx.lineWidth = 1;
        }
        ctx.stroke();

        // Selection ring
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

        // --- LABEL LOD ---
        // Show label if: focused, in highlight set, has many facts (important), or zoomed in enough
        const isImportant = n.facts.length >= 3;
        const showLabel = !isDimmed && (
          isFocused ||
          (hasFocus && highlightSet.has(n.id)) ||
          (pan.zoom >= 1.3) ||
          (pan.zoom >= 0.8 && isImportant)
        );

        if (showLabel) {
          const maxLen = pan.zoom > 1 ? 20 : 12;
          const lbl = n.label.length > maxLen ? n.label.slice(0, maxLen - 1) + '\u2026' : n.label;
          const fontSize = Math.max(9, 11 * pan.zoom);

          ctx.font = `600 ${fontSize}px "Inter", system-ui, sans-serif`;
          const textW = ctx.measureText(lbl).width + 8;
          ctx.fillStyle = 'rgba(9,9,11,0.75)';
          ctx.beginPath();
          ctx.roundRect(tx - textW / 2, ty - fontSize / 2 - 1, textW, fontSize + 2, 3);
          ctx.fill();

          ctx.fillStyle = isFocused ? '#fafafa' : '#a1a1aa';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(lbl, tx, ty);

          // Type label below
          if (pan.zoom > 0.7) {
            const typeFontSize = Math.max(7, 8 * pan.zoom);
            ctx.font = `500 ${typeFontSize}px "Inter", system-ui, sans-serif`;
            ctx.fillStyle = `rgba(${cr},${cg},${cb},${isFocused ? 0.9 : 0.5})`;
            ctx.fillText(n.type, tx, ty + radius + Math.max(9, 11 * pan.zoom));
          }
        }
      }

      animFrameRef.current = requestAnimationFrame(draw);
    };

    animFrameRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animFrameRef.current);
  }, [filtered, hoverNode, selectedNode, searchMatchId]);

  // Canvas mouse handlers
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !filtered.nodes.length) return;

    const pan = panRef.current;

    const getNodeAt = (clientX: number, clientY: number): GraphNode | null => {
      const rect = canvas.getBoundingClientRect();
      const mx = clientX - rect.left, my = clientY - rect.top;
      for (const n of [...filtered.nodes].reverse()) {
        const radius = Math.max(8, Math.min(24, (n.size || 12))) * pan.zoom;
        const tx = n.x! * pan.zoom + pan.x;
        const ty = n.y! * pan.zoom + pan.y;
        const dx = mx - tx, dy = my - ty;
        if (dx * dx + dy * dy <= (radius + 6) * (radius + 6)) return n;
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
      pan.zoom = Math.max(0.2, Math.min(4, pan.zoom * delta));

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
  }, [filtered]);

  // All unique types in the data
  const allTypes = useMemo(() => {
    if (!data) return [];
    const counts = new Map<string, number>();
    for (const n of data.nodes) {
      const t = n.type?.toLowerCase() ?? 'unknown';
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([type, count]) => ({ type, count }));
  }, [data]);

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-12 animate-pulse rounded-xl bg-bg-secondary" />
        <div className="animate-pulse rounded-xl border border-border bg-bg" style={{ height: '60vh', minHeight: 400 }} />
      </div>
    );
  }

  const hasNodes = data && data.nodes.length > 0;

  return (
    <div className="space-y-4" ref={containerRef}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10">
            <Network className="h-4 w-4 text-accent-hover" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-text">Memory Graph</h2>
            <p className="text-xs text-text-muted">Temporal knowledge graph powered by entity extraction</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {hasNodes && (
            <>
              <button
                onClick={() => handleZoom(1.2)}
                className="rounded-lg p-1.5 text-text-muted hover:bg-bg-tertiary hover:text-text transition-colors"
                title="Zoom in"
              >
                <ZoomIn className="h-4 w-4" />
              </button>
              <button
                onClick={() => handleZoom(0.8)}
                className="rounded-lg p-1.5 text-text-muted hover:bg-bg-tertiary hover:text-text transition-colors"
                title="Zoom out"
              >
                <ZoomOut className="h-4 w-4" />
              </button>
              <button
                onClick={handleFitView}
                className="rounded-lg p-1.5 text-text-muted hover:bg-bg-tertiary hover:text-text transition-colors"
                title="Fit view"
              >
                <Maximize2 className="h-4 w-4" />
              </button>
              <div className="mx-1 h-4 w-px bg-bg-tertiary" />
            </>
          )}
          <button
            onClick={fetchData}
            className="flex items-center gap-1.5 rounded-lg bg-bg-tertiary px-3 py-1.5 text-xs text-text-secondary hover:bg-border hover:text-text transition-colors"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </button>
          <button
            onClick={handleClear}
            className="flex items-center gap-1.5 rounded-lg bg-bg-tertiary px-3 py-1.5 text-xs text-error hover:bg-error/10 transition-colors"
          >
            <Trash2 className="h-3.5 w-3.5" /> Clear
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-error/50 bg-error/5 p-4 text-sm text-error">{error}</div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'Entities', value: data?.nodeCount ?? 0, color: 'var(--color-accent-hover)' },
          { label: 'Relationships', value: data?.edgeCount ?? 0, color: 'var(--color-cyan)' },
          { label: 'Episodes', value: data?.episodeCount ?? 0, color: 'var(--color-emerald)' },
        ].map(({ label, value, color }) => (
          <div key={label} className="rounded-xl border border-border bg-bg-secondary px-4 py-3">
            <p className="text-xs text-text-muted">{label}</p>
            <div className="flex items-baseline gap-2">
              <p className="text-2xl font-bold" style={{ color }}>{value.toLocaleString()}</p>
              {value > 0 && (
                <div className="h-1.5 w-1.5 rounded-full animate-pulse" style={{ backgroundColor: color }} />
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Search + Type Filters */}
      {hasNodes && (
        <div className="space-y-3">
          {/* Search bar */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-text-muted" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search entities and facts..."
              className="w-full rounded-lg border border-border bg-bg-secondary py-2 pl-9 pr-8 text-sm text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-text-muted hover:text-text"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {/* Type filter chips */}
          <div className="flex flex-wrap gap-1.5">
            {allTypes.map(({ type, count }) => {
              const color = getColor(type);
              const isHidden = hiddenTypes.has(type);
              return (
                <button
                  key={type}
                  onClick={() => toggleType(type)}
                  className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium transition-all ${
                    isHidden
                      ? 'bg-bg-tertiary/50 text-text-muted opacity-40'
                      : 'bg-bg-tertiary text-text-secondary hover:brightness-110'
                  }`}
                >
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: isHidden ? 'var(--color-border-light)' : color }}
                  />
                  {TYPE_LABELS[type] ?? type.charAt(0).toUpperCase() + type.slice(1)}
                  <span className="text-text-muted">{count}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Graph canvas */}
      {hasNodes ? (
        <div className="relative rounded-xl border border-border bg-bg overflow-hidden shadow-2xl shadow-black/50" style={{ height: '60vh', minHeight: 400 }}>
          <canvas
            ref={canvasRef}
            style={{ width: '100%', height: '100%', cursor: 'grab' }}
          />
          {/* Zoom indicator */}
          <div className="absolute bottom-3 right-3 rounded-md bg-bg/80 px-2 py-1 text-[10px] text-text-muted backdrop-blur-sm border border-bg-tertiary">
            {Math.round(panRef.current.zoom * 100)}%
          </div>
          {/* Node count indicator when filtered */}
          {(searchQuery || hiddenTypes.size > 0) && (
            <div className="absolute top-3 left-3 rounded-md bg-bg/80 px-2 py-1 text-[10px] text-text-muted backdrop-blur-sm border border-bg-tertiary">
              Showing {filtered.nodes.length} of {data?.nodes.length ?? 0} entities
            </div>
          )}
        </div>
      ) : (
        <div className="relative rounded-xl border border-border bg-bg-secondary overflow-hidden flex flex-col items-center justify-center" style={{ height: '60vh', minHeight: 400 }}>
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/10 border border-accent/20 mb-4">
            <Network className="h-7 w-7 text-accent-hover" />
          </div>
          <p className="text-sm font-medium text-text-secondary">No entities in the graph yet</p>
          <p className="mt-1 max-w-sm text-center text-xs text-text-muted">
            Start chatting with TITAN to build the knowledge graph. Entities, relationships, and facts are extracted automatically from conversations.
          </p>
        </div>
      )}

      {/* Selected node detail */}
      {selectedNode && (
        <div className="rounded-xl border border-border bg-bg-secondary overflow-hidden">
          <div className="flex items-center gap-3 border-b border-bg-tertiary px-4 py-3">
            <div className="h-3.5 w-3.5 rounded-full shadow-lg" style={{
              backgroundColor: getColor(selectedNode.type),
              boxShadow: `0 0 8px ${getColor(selectedNode.type)}40`,
            }} />
            <span className="font-semibold text-text">{selectedNode.label}</span>
            <span className="rounded-md bg-bg-tertiary px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-text-secondary">
              {selectedNode.type}
            </span>
          </div>
          <div className="space-y-3 p-4">
            {selectedNode.facts.length > 0 && (
              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-wider text-text-muted">Facts</p>
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
              const nodeMap = new Map(data.nodes.map((nd) => [nd.id, nd]));
              return (
                <div>
                  <p className="mb-2 text-xs font-medium uppercase tracking-wider text-text-muted">Relationships ({related.length})</p>
                  <div className="space-y-1.5 max-h-48 overflow-y-auto">
                    {related.slice(0, 30).map((e, i) => {
                      const other = nodeMap.get(e.from === selectedNode.id ? e.to : e.from);
                      const otherColor = other ? getColor(other.type) : '#64748b';
                      return (
                        <div key={i} className="flex items-center gap-2 text-xs">
                          <span className="text-text-secondary">{e.label}</span>
                          <span className="text-text-muted">&rarr;</span>
                          <span className="inline-flex items-center gap-1.5">
                            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: otherColor }} />
                            <span className="text-[#d4d4d8]">{other?.label ?? '?'}</span>
                          </span>
                        </div>
                      );
                    })}
                    {related.length > 30 && (
                      <p className="text-[10px] text-text-muted">+ {related.length - 30} more</p>
                    )}
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
