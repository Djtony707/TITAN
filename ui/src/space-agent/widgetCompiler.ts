import type { Widget } from './types';

let babelLoaded = false;
let babelLoadPromise: Promise<void> | null = null;

async function loadBabel(): Promise<void> {
  if (babelLoaded) return;
  if (babelLoadPromise) return babelLoadPromise;

  babelLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://unpkg.com/@babel/standalone@7.26.0/babel.min.js';
    script.onload = () => { babelLoaded = true; resolve(); };
    script.onerror = () => reject(new Error('Failed to load Babel'));
    document.head.appendChild(script);
  });

  return babelLoadPromise;
}

export async function compileWidgetCode(code: string, language: 'jsx' | 'javascript' = 'jsx'): Promise<string> {
  await loadBabel();

  const Babel = (window as any).Babel;
  if (!Babel) {
    throw new Error('Babel not loaded');
  }

  // Extract component name from export default BEFORE Babel processing
  const exportMatch = code.match(/export\s+default\s+(?:function\s+)?(\w+)/);
  const componentName = exportMatch ? exportMatch[1] : null;

  // Strip export default statement so Babel doesn't see module syntax
  const cleanedCode = code.replace(/export\s+default\s+(?:function\s+)?\w+\s*;?/, '');

  // Compile JSX with Babel (no return here — Babel would reject it)
  const result = Babel.transform(cleanedCode, {
    presets: ['react'],
    filename: 'widget.tsx',
  });

  // Append return AFTER Babel compilation — this goes into new Function() body
  if (componentName) {
    return result.code + `\nreturn ${componentName};`;
  }

  return result.code;
}

export function executeWidgetCode(compiledCode: string, globals: Record<string, any> = {}): React.FC<any> {
  const sandboxKeys = Object.keys(globals);
  const sandboxValues = Object.values(globals);

  try {
    const fn = new Function(...sandboxKeys, compiledCode);
    const Component = fn(...sandboxValues);

    if (!Component || typeof Component !== 'function') {
      throw new Error('Widget code did not export a valid React component');
    }

    return Component;
  } catch (err: any) {
    throw new Error(`Widget execution failed: ${err.message}`);
  }
}

/* ═══════════════════════════════════════
   WIDGET TEMPLATES — TITAN BRANDED
   Colors: indigo #6366f1, purple #a855f7
   Surfaces: zinc #18181b, #27272a
   Text: #fafafa, #a1a1aa
   ═══════════════════════════════════════ */

const SYSTEM_MONITOR_CODE = `function SystemMonitor({ runtime }) {
  const [stats, setStats] = React.useState({
    cpu: 34, memory: 62, disk: 45, network: 78,
    uptime: '3d 14h 22m', processes: 247, threads: 1843
  });
  const [history, setHistory] = React.useState(Array(20).fill(30));

  React.useEffect(() => {
    const interval = setInterval(() => {
      setStats(prev => ({
        cpu: Math.min(100, Math.max(5, prev.cpu + (Math.random() - 0.5) * 20)),
        memory: Math.min(100, Math.max(20, prev.memory + (Math.random() - 0.5) * 10)),
        disk: prev.disk, network: Math.min(100, Math.max(10, prev.network + (Math.random() - 0.5) * 30)),
        uptime: prev.uptime, processes: prev.processes + Math.floor(Math.random() * 3 - 1),
        threads: prev.threads + Math.floor(Math.random() * 5 - 2)
      }));
      setHistory(prev => [...prev.slice(1), Math.floor(Math.random() * 60 + 20)]);
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  const sparkline = history.map((v, i) => \`\${i * 5},\${100 - v}\`).join(' ');

  return React.createElement('div', { className: 'p-4 h-full flex flex-col' },
    React.createElement('div', { className: 'flex items-center justify-between mb-3' },
      React.createElement('h3', { className: 'text-xs font-bold uppercase tracking-wider text-[#818cf8]' }, 'System Monitor'),
      React.createElement('div', { className: 'flex items-center gap-1.5' },
        React.createElement('div', { className: 'w-1.5 h-1.5 rounded-full bg-[#34d399] animate-pulse' }),
        React.createElement('span', { className: 'text-[10px] text-[#34d399]' }, 'LIVE')
      )
    ),
    React.createElement('svg', { viewBox: '0 0 100 30', className: 'w-full h-16 mb-3' },
      React.createElement('polyline', {
        fill: 'none', stroke: '#6366f1', strokeWidth: 0.8, opacity: 0.8,
        points: sparkline
      }),
      React.createElement('polygon', {
        fill: '#6366f1', opacity: 0.1,
        points: \`0,100 \${sparkline} 100,100\`
      })
    ),
    React.createElement('div', { className: 'grid grid-cols-2 gap-2 flex-1' },
      ['cpu', 'memory', 'disk', 'network'].map(key =>
        React.createElement('div', { key, className: 'bg-[#18181b]/60 rounded-lg p-2 border border-[#27272a]/50' },
          React.createElement('div', { className: 'flex justify-between text-[10px] mb-1' },
            React.createElement('span', { className: 'text-[#71717a] uppercase' }, key),
            React.createElement('span', { className: 'text-[#fafafa] font-mono font-bold' }, Math.round(stats[key]) + '%')
          ),
          React.createElement('div', { className: 'w-full bg-[#27272a] rounded-full h-1' },
            React.createElement('div', {
              className: 'h-1 rounded-full transition-all duration-1000',
              style: {
                width: Math.round(stats[key]) + '%',
                background: stats[key] > 80 ? '#ef4444' : stats[key] > 60 ? '#f59e0b' : '#6366f1'
              }
            })
          )
        )
      )
    ),
    React.createElement('div', { className: 'flex justify-between text-[10px] text-[#52525b] mt-2 pt-2 border-t border-[#27272a]/40' },
      React.createElement('span', null, 'Uptime: ' + stats.uptime),
      React.createElement('span', null, stats.processes + ' procs / ' + stats.threads + ' threads')
    )
  );
}
export default SystemMonitor;`;

const CHART_CODE = `function DataChart({ runtime }) {
  const [data, setData] = React.useState([
    { label: 'Mon', value: 45 }, { label: 'Tue', value: 72 },
    { label: 'Wed', value: 58 }, { label: 'Thu', value: 90 },
    { label: 'Fri', value: 65 }, { label: 'Sat', value: 85 },
    { label: 'Sun', value: 55 }
  ]);
  const max = Math.max(...data.map(d => d.value));

  React.useEffect(() => {
    const interval = setInterval(() => {
      setData(prev => prev.map(d => ({
        ...d,
        value: Math.min(100, Math.max(10, d.value + (Math.random() - 0.5) * 20))
      })));
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  return React.createElement('div', { className: 'p-4 h-full flex flex-col' },
    React.createElement('div', { className: 'flex items-center justify-between mb-3' },
      React.createElement('h3', { className: 'text-xs font-bold uppercase tracking-wider text-[#818cf8]' }, 'Weekly Activity'),
      React.createElement('span', { className: 'text-[10px] text-[#52525b]' }, 'Last 7 days')
    ),
    React.createElement('div', { className: 'flex items-end gap-2 flex-1 mb-2' },
      data.map((d, i) =>
        React.createElement('div', { key: i, className: 'flex-1 flex flex-col items-center gap-1' },
          React.createElement('span', { className: 'text-[9px] text-[#6366f1] font-mono opacity-0 hover:opacity-100 transition-opacity' },
            Math.round(d.value)
          ),
          React.createElement('div', {
            className: 'w-full rounded-t-md transition-all duration-700',
            style: {
              height: (d.value / max * 100) + '%',
              background: \`linear-gradient(180deg, #6366f1 \${100 - d.value}%, #4f46e5 100%)\`,
              opacity: 0.4 + (d.value / max * 0.6),
              minHeight: 4
            }
          })
        )
      )
    ),
    React.createElement('div', { className: 'flex justify-between' },
      data.map((d, i) =>
        React.createElement('span', { key: i, className: 'flex-1 text-center text-[9px] text-[#52525b]' }, d.label)
      )
    )
  );
}
export default DataChart;`;

const TERMINAL_CODE = `function TerminalWidget({ runtime }) {
  const [lines, setLines] = React.useState([
    { text: 'TITAN Canvas v2.0.0', type: 'info' },
    { text: 'Initializing panel runtime...', type: 'success' },
    { text: 'Connected to TITAN backend [192.168.1.11]', type: 'info' },
    { text: 'Loading extensions... OK', type: 'success' },
    { text: 'Ready for commands', type: 'prompt' }
  ]);
  const [input, setInput] = React.useState('');
  const scrollRef = React.useRef(null);

  React.useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [lines]);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!input.trim()) return;
    setLines(prev => [...prev, { text: '> ' + input, type: 'input' }]);
    setTimeout(() => {
      const responses = [
        'Command executed successfully',
        'Panel created: "New Monitor"',
        'Data fetched from API endpoint',
        'Extension loaded: intel_tools',
        'Error: Unknown command (simulated)'
      ];
      setLines(prev => [...prev, { text: responses[Math.floor(Math.random() * responses.length)], type: 'output' }]);
    }, 500);
    setInput('');
  };

  return React.createElement('div', { className: 'h-full flex flex-col bg-[#09090b]' },
    React.createElement('div', { className: 'flex items-center justify-between px-3 py-2 border-b border-[#27272a]/50' },
      React.createElement('div', { className: 'flex items-center gap-2' },
        React.createElement('div', { className: 'w-2.5 h-2.5 rounded-full bg-[#ef4444]' }),
        React.createElement('div', { className: 'w-2.5 h-2.5 rounded-full bg-[#f59e0b]' }),
        React.createElement('div', { className: 'w-2.5 h-2.5 rounded-full bg-[#22c55e]' })
      ),
      React.createElement('span', { className: 'text-[10px] text-[#52525b] font-mono' }, 'titan@canvas:~')
    ),
    React.createElement('div', { ref: scrollRef, className: 'flex-1 overflow-y-auto p-3 space-y-1 font-mono text-[11px]' },
      lines.map((line, i) =>
        React.createElement('div', {
          key: i,
          className: line.type === 'info' ? 'text-[#818cf8]' :
                     line.type === 'success' ? 'text-[#34d399]' :
                     line.type === 'prompt' ? 'text-[#f59e0b]' :
                     line.type === 'input' ? 'text-[#fafafa]' :
                     'text-[#a1a1aa]'
        }, line.text)
      )
    ),
    React.createElement('form', { onSubmit: handleSubmit, className: 'p-2 border-t border-[#27272a]/50' },
      React.createElement('div', { className: 'flex items-center gap-2' },
        React.createElement('span', { className: 'text-[#34d399] font-mono text-xs' }, '$'),
        React.createElement('input', {
          value: input,
          onChange: e => setInput(e.target.value),
          placeholder: 'Type command...',
          className: 'flex-1 bg-transparent text-[#fafafa] text-xs font-mono outline-none placeholder:text-[#3f3f46]'
        })
      )
    )
  );
}
export default TerminalWidget;`;

const CLOCK_CODE = `function ClockWidget({ runtime }) {
  const [time, setTime] = React.useState(new Date());
  React.useEffect(() => {
    const interval = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  const pad = n => n.toString().padStart(2, '0');
  const hours = pad(time.getHours());
  const minutes = pad(time.getMinutes());
  const seconds = pad(time.getSeconds());

  return React.createElement('div', { className: 'h-full flex flex-col items-center justify-center p-4' },
    React.createElement('div', { className: 'flex items-baseline gap-1' },
      React.createElement('span', { className: 'text-5xl font-bold text-[#fafafa] font-mono tracking-tight' }, hours),
      React.createElement('span', { className: 'text-5xl font-bold text-[#6366f1] animate-pulse' }, ':'),
      React.createElement('span', { className: 'text-5xl font-bold text-[#fafafa] font-mono tracking-tight' }, minutes),
      React.createElement('span', { className: 'text-2xl font-bold text-[#52525b] font-mono ml-1' }, seconds)
    ),
    React.createElement('div', { className: 'text-xs text-[#52525b] mt-2 uppercase tracking-widest' },
      time.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })
    )
  );
}
export default ClockWidget;`;

const TABLE_CODE = `function DataTable({ runtime }) {
  const [rows, setRows] = React.useState([
    { id: 1, name: 'Alpha Node', status: 'Active', load: 34, region: 'US-East' },
    { id: 2, name: 'Beta Node', status: 'Active', load: 67, region: 'EU-West' },
    { id: 3, name: 'Gamma Node', status: 'Warning', load: 89, region: 'AP-South' },
    { id: 4, name: 'Delta Node', status: 'Active', load: 23, region: 'US-West' },
    { id: 5, name: 'Epsilon Node', status: 'Offline', load: 0, region: 'EU-East' }
  ]);

  React.useEffect(() => {
    const interval = setInterval(() => {
      setRows(prev => prev.map(r => ({
        ...r,
        load: r.status === 'Offline' ? 0 : Math.min(100, Math.max(5, r.load + (Math.random() - 0.5) * 15))
      })));
    }, 2500);
    return () => clearInterval(interval);
  }, []);

  const statusColor = s => s === 'Active' ? '#34d399' : s === 'Warning' ? '#f59e0b' : '#ef4444';

  return React.createElement('div', { className: 'h-full flex flex-col p-3' },
    React.createElement('h3', { className: 'text-xs font-bold uppercase tracking-wider text-[#818cf8] mb-2' }, 'Node Status'),
    React.createElement('div', { className: 'flex-1 overflow-auto' },
      React.createElement('table', { className: 'w-full text-[10px]' },
        React.createElement('thead', null,
          React.createElement('tr', { className: 'text-[#52525b] border-b border-[#27272a]' },
            ['Node', 'Status', 'Load', 'Region'].map(h =>
              React.createElement('th', { key: h, className: 'text-left py-1.5 px-2 font-medium' }, h)
            )
          )
        ),
        React.createElement('tbody', null,
          rows.map(row =>
            React.createElement('tr', { key: row.id, className: 'border-b border-[#27272a]/30 hover:bg-[#18181b]/50' },
              React.createElement('td', { className: 'py-1.5 px-2 text-[#fafafa] font-medium' }, row.name),
              React.createElement('td', { className: 'py-1.5 px-2' },
                React.createElement('span', {
                  className: 'px-1.5 py-0.5 rounded text-[9px] font-bold',
                  style: { color: statusColor(row.status), background: statusColor(row.status) + '15' }
                }, row.status)
              ),
              React.createElement('td', { className: 'py-1.5 px-2' },
                React.createElement('div', { className: 'flex items-center gap-1.5' },
                  React.createElement('div', { className: 'w-12 bg-[#27272a] rounded-full h-1' },
                    React.createElement('div', {
                      className: 'h-1 rounded-full transition-all',
                      style: { width: row.load + '%', background: row.load > 80 ? '#ef4444' : '#6366f1' }
                    })
                  ),
                  React.createElement('span', { className: 'text-[#71717a] font-mono' }, Math.round(row.load) + '%')
                )
              ),
              React.createElement('td', { className: 'py-1.5 px-2 text-[#71717a]' }, row.region)
            )
          )
        )
      )
    )
  );
}
export default DataTable;`;

const WEATHER_CODE = `function WeatherWidget({ runtime }) {
  const [weather, setWeather] = React.useState({
    temp: 72, condition: 'Partly Cloudy', humidity: 45, wind: 12,
    forecast: [
      { day: 'Mon', high: 75, low: 60, icon: '\u2600' },
      { day: 'Tue', high: 73, low: 58, icon: '\u26c5' },
      { day: 'Wed', high: 68, low: 55, icon: '\u2601' },
      { day: 'Thu', high: 70, low: 57, icon: '\u26c5' },
      { day: 'Fri', high: 76, low: 62, icon: '\u2600' }
    ]
  });

  React.useEffect(() => {
    const interval = setInterval(() => {
      setWeather(prev => ({
        ...prev,
        temp: prev.temp + Math.floor(Math.random() * 3 - 1)
      }));
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  return React.createElement('div', { className: 'h-full flex flex-col p-4' },
    React.createElement('div', { className: 'flex items-center justify-between mb-3' },
      React.createElement('h3', { className: 'text-xs font-bold uppercase tracking-wider text-[#818cf8]' }, 'Weather'),
      React.createElement('span', { className: 'text-[10px] text-[#52525b]' }, 'Local')
    ),
    React.createElement('div', { className: 'flex items-center gap-4 mb-3' },
      React.createElement('span', { className: 'text-4xl font-bold text-[#fafafa]' }, weather.temp + '\u00b0'),
      React.createElement('div', { className: 'flex flex-col' },
        React.createElement('span', { className: 'text-sm text-[#a1a1aa]' }, weather.condition),
        React.createElement('span', { className: 'text-[10px] text-[#52525b]' }, 'H: ' + (weather.temp + 5) + '\u00b0  L: ' + (weather.temp - 8) + '\u00b0')
      )
    ),
    React.createElement('div', { className: 'flex gap-3 text-[10px] text-[#52525b] mb-3' },
      React.createElement('span', null, 'Humidity: ' + weather.humidity + '%'),
      React.createElement('span', null, 'Wind: ' + weather.wind + ' mph')
    ),
    React.createElement('div', { className: 'flex gap-2 flex-1' },
      weather.forecast.map((d, i) =>
        React.createElement('div', { key: i, className: 'flex-1 flex flex-col items-center justify-center bg-[#18181b]/50 rounded-lg p-1 border border-[#27272a]/30' },
          React.createElement('span', { className: 'text-lg mb-1' }, d.icon),
          React.createElement('span', { className: 'text-[9px] text-[#a1a1aa]' }, d.day),
          React.createElement('span', { className: 'text-[9px] text-[#6366f1] font-mono' }, d.high + '\u00b0')
        )
      )
    )
  );
}
export default WeatherWidget;`;

const CRYPTO_TICKER_CODE = `function CryptoTicker({ runtime }) {
  const [coins, setCoins] = React.useState([
    { symbol: 'BTC', name: 'Bitcoin', price: 67234.50, change: 2.4 },
    { symbol: 'ETH', name: 'Ethereum', price: 3456.78, change: -1.2 },
    { symbol: 'SOL', name: 'Solana', price: 145.32, change: 5.7 },
    { symbol: 'ADA', name: 'Cardano', price: 0.45, change: -0.8 }
  ]);

  React.useEffect(() => {
    const interval = setInterval(() => {
      setCoins(prev => prev.map(c => ({
        ...c,
        price: c.price * (1 + (Math.random() - 0.5) * 0.02),
        change: c.change + (Math.random() - 0.5) * 0.5
      })));
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  return React.createElement('div', { className: 'h-full flex flex-col p-4' },
    React.createElement('div', { className: 'flex items-center justify-between mb-3' },
      React.createElement('h3', { className: 'text-xs font-bold uppercase tracking-wider text-[#818cf8]' }, 'Crypto Ticker'),
      React.createElement('div', { className: 'flex items-center gap-1.5' },
        React.createElement('div', { className: 'w-1.5 h-1.5 rounded-full bg-[#34d399] animate-pulse' }),
        React.createElement('span', { className: 'text-[10px] text-[#34d399]' }, 'LIVE')
      )
    ),
    React.createElement('div', { className: 'space-y-2 flex-1' },
      coins.map(coin =>
        React.createElement('div', { key: coin.symbol, className: 'flex items-center justify-between bg-[#18181b]/50 rounded-lg p-2.5 border border-[#27272a]/30' },
          React.createElement('div', { className: 'flex items-center gap-2' },
            React.createElement('div', { className: 'w-7 h-7 rounded-full bg-[#6366f1]/10 flex items-center justify-center' },
              React.createElement('span', { className: 'text-[10px] font-bold text-[#6366f1]' }, coin.symbol[0])
            ),
            React.createElement('div', { className: 'flex flex-col' },
              React.createElement('span', { className: 'text-xs font-semibold text-[#fafafa]' }, coin.symbol),
              React.createElement('span', { className: 'text-[9px] text-[#52525b]' }, coin.name)
            )
          ),
          React.createElement('div', { className: 'flex flex-col items-end' },
            React.createElement('span', { className: 'text-xs font-mono text-[#fafafa]' },
              '$' + coin.price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
            ),
            React.createElement('span', {
              className: 'text-[10px] font-bold',
              style: { color: coin.change >= 0 ? '#34d399' : '#ef4444' }
            }, (coin.change >= 0 ? '+' : '') + coin.change.toFixed(1) + '%')
          )
        )
      )
    )
  );
}
export default CryptoTicker;`;

const TODO_CODE = `function TodoWidget({ runtime }) {
  const [todos, setTodos] = React.useState([
    { id: 1, text: 'Review system metrics', done: false },
    { id: 2, text: 'Update agent configuration', done: true },
    { id: 3, text: 'Deploy new panel', done: false },
    { id: 4, text: 'Check TITAN logs', done: false }
  ]);
  const [newTodo, setNewTodo] = React.useState('');

  const toggle = (id) => setTodos(prev => prev.map(t => t.id === id ? { ...t, done: !t.done } : t));
  const add = (e) => {
    e.preventDefault();
    if (!newTodo.trim()) return;
    setTodos(prev => [...prev, { id: Date.now(), text: newTodo, done: false }]);
    setNewTodo('');
  };
  const remove = (id) => setTodos(prev => prev.filter(t => t.id !== id));

  const doneCount = todos.filter(t => t.done).length;

  return React.createElement('div', { className: 'h-full flex flex-col p-4' },
    React.createElement('div', { className: 'flex items-center justify-between mb-3' },
      React.createElement('h3', { className: 'text-xs font-bold uppercase tracking-wider text-[#818cf8]' }, 'Tasks'),
      React.createElement('span', { className: 'text-[10px] text-[#52525b]' }, doneCount + '/' + todos.length)
    ),
    React.createElement('div', { className: 'flex-1 overflow-auto space-y-1 mb-2' },
      todos.map(todo =>
        React.createElement('div', {
          key: todo.id,
          className: 'flex items-center gap-2 p-2 rounded-lg hover:bg-[#18181b]/50 transition-colors group'
        },
          React.createElement('button', {
            onClick: () => toggle(todo.id),
            className: 'w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 transition-colors',
            style: {
              borderColor: todo.done ? '#34d399' : '#27272a',
              background: todo.done ? '#34d39920' : 'transparent'
            }
          }, todo.done ? React.createElement('span', { className: 'text-[9px] text-[#34d399]' }, '\u2713') : null),
          React.createElement('span', {
            className: 'text-xs flex-1 truncate',
            style: { color: todo.done ? '#52525b' : '#a1a1aa', textDecoration: todo.done ? 'line-through' : 'none' }
          }, todo.text),
          React.createElement('button', {
            onClick: () => remove(todo.id),
            className: 'opacity-0 group-hover:opacity-100 text-[#52525b] hover:text-[#ef4444] text-[10px] transition-opacity'
          }, '\u2715')
        )
      )
    ),
    React.createElement('form', { onSubmit: add, className: 'flex gap-2' },
      React.createElement('input', {
        value: newTodo,
        onChange: e => setNewTodo(e.target.value),
        placeholder: 'Add task...',
        className: 'flex-1 bg-[#18181b] border border-[#27272a] rounded-lg px-2.5 py-1.5 text-xs text-[#fafafa] placeholder:text-[#3f3f46] outline-none focus:border-[#6366f1]/30'
      }),
      React.createElement('button', {
        type: 'submit',
        className: 'px-3 py-1.5 rounded-lg bg-[#6366f1]/10 border border-[#6366f1]/20 text-[#6366f1] text-xs hover:bg-[#6366f1]/20 transition-colors'
      }, '+')
    )
  );
}
export default TodoWidget;`;

const WELCOME_CODE = `function WelcomeWidget({ runtime }) {
  return React.createElement('div', { className: 'h-full flex flex-col items-center justify-center p-6 text-center' },
    React.createElement('div', { className: 'w-16 h-16 rounded-2xl bg-[#6366f1]/10 border border-[#6366f1]/20 flex items-center justify-center mb-4' },
      React.createElement('span', { className: 'text-3xl' }, '\u2728')
    ),
    React.createElement('h3', { className: 'text-base font-bold text-[#fafafa] mb-1' }, 'TITAN Canvas'),
    React.createElement('p', { className: 'text-xs text-[#52525b] max-w-[200px]' },
      'Create panels, dashboards, and tools by chatting with the AI'
    ),
    React.createElement('div', { className: 'mt-4 flex gap-2 flex-wrap justify-center' },
      ['System', 'Chart', 'Terminal', 'Clock', 'Table', 'Weather', 'Crypto', 'Tasks'].map(label =>
        React.createElement('span', {
          key: label,
          className: 'px-2 py-1 rounded-md bg-[#18181b] border border-[#27272a] text-[10px] text-[#6366f1]'
        }, label)
      )
    )
  );
}
export default WelcomeWidget;`;

/* ═══════════════════════════════════════
   PROMPT MATCHING
   ═══════════════════════════════════════ */

export async function generateWidgetCode(prompt: string): Promise<{ title: string; code: string }> {
  const lower = prompt.toLowerCase();

  if (lower.includes('cpu') || lower.includes('system') || lower.includes('stats') || lower.includes('monitor')) {
    return { title: 'System Monitor', code: SYSTEM_MONITOR_CODE };
  }
  if (lower.includes('chart') || lower.includes('graph') || lower.includes('bar')) {
    return { title: 'Data Chart', code: CHART_CODE };
  }
  if (lower.includes('terminal') || lower.includes('console') || lower.includes('shell') || lower.includes('command')) {
    return { title: 'Terminal', code: TERMINAL_CODE };
  }
  if (lower.includes('clock') || lower.includes('time') || lower.includes('watch')) {
    return { title: 'Canvas Clock', code: CLOCK_CODE };
  }
  if (lower.includes('table') || lower.includes('list') || lower.includes('nodes') || lower.includes('status')) {
    return { title: 'Node Status', code: TABLE_CODE };
  }
  if (lower.includes('weather') || lower.includes('forecast')) {
    return { title: 'Weather', code: WEATHER_CODE };
  }
  if (lower.includes('crypto') || lower.includes('bitcoin') || lower.includes('price') || lower.includes('ticker')) {
    return { title: 'Crypto Ticker', code: CRYPTO_TICKER_CODE };
  }
  if (lower.includes('todo') || lower.includes('task') || lower.includes('checklist')) {
    return { title: 'Task List', code: TODO_CODE };
  }

  return { title: 'Welcome Panel', code: WELCOME_CODE };
}

export function extractWidgetBlocks(text: string): Array<{ language: string; code: string }> {
  const blocks: Array<{ language: string; code: string }> = [];
  const pattern = /_____widget\n([\s\S]*?)(?=\n_____|$)/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    blocks.push({ language: 'jsx', code: match[1].trim() });
  }
  return blocks;
}
