import { useState, useEffect } from 'react';
import { FolderOpen, File, ChevronRight, Home, RefreshCw, ArrowLeft, Download, FileText, Database, Settings as SettingsIcon, Clock } from 'lucide-react';
import { listFiles, readFile } from '@/api/client';
import type { FileEntry, FileContent } from '@/api/types';

function FilesPanel() {
  const [currentPath, setCurrentPath] = useState('');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [selectedFile, setSelectedFile] = useState<FileContent | null>(null);
  const [loading, setLoading] = useState(true);
  const [fileLoading, setFileLoading] = useState(false);

  const refresh = async (path?: string) => {
    setLoading(true);
    try {
      const result = await listFiles(path ?? currentPath);
      setEntries(result.entries);
    } catch { /* ignore */ }
    setLoading(false);
  };

  useEffect(() => { refresh(currentPath); }, [currentPath]);

  const navigateTo = (path: string) => {
    setCurrentPath(path);
    setSelectedFile(null);
  };

  const goUp = () => {
    const parts = currentPath.split('/').filter(Boolean);
    parts.pop();
    navigateTo(parts.join('/'));
  };

  const openFile = async (entry: FileEntry) => {
    if (entry.type === 'directory') {
      navigateTo(entry.path);
      return;
    }
    setFileLoading(true);
    try {
      const content = await readFile(entry.path);
      setSelectedFile(content);
    } catch { /* ignore */ }
    setFileLoading(false);
  };

  const formatSize = (bytes: number) => {
    if (bytes === 0) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
  };

  const formatTime = (ts: string) => {
    if (!ts) return '';
    try {
      const d = new Date(ts);
      const now = new Date();
      const diff = now.getTime() - d.getTime();
      if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
      if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`;
      if (diff < 604800000) return `${Math.round(diff / 86400000)}d ago`;
      return d.toLocaleDateString();
    } catch { return ''; }
  };

  const getFileIcon = (name: string) => {
    if (name.endsWith('.json') || name.endsWith('.jsonl')) return <Database size={14} className="text-yellow-400" />;
    if (name.endsWith('.md')) return <FileText size={14} className="text-blue-400" />;
    if (name.endsWith('.db')) return <Database size={14} className="text-purple-400" />;
    if (name.endsWith('.log')) return <FileText size={14} className="text-[var(--text-muted)]" />;
    if (name === 'titan.json') return <SettingsIcon size={14} className="text-[var(--accent)]" />;
    return <File size={14} className="text-[var(--text-muted)]" />;
  };

  const getLanguage = (path: string) => {
    if (path.endsWith('.json') || path.endsWith('.jsonl')) return 'json';
    if (path.endsWith('.md')) return 'markdown';
    if (path.endsWith('.ts') || path.endsWith('.tsx')) return 'typescript';
    if (path.endsWith('.js')) return 'javascript';
    if (path.endsWith('.yaml') || path.endsWith('.yml')) return 'yaml';
    return 'text';
  };

  // Breadcrumb parts
  const pathParts = currentPath ? currentPath.split('/').filter(Boolean) : [];

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <FolderOpen className="w-6 h-6 text-[var(--accent)]" />
          <div>
            <h1 className="text-xl font-bold text-[var(--text)]">Files</h1>
            <p className="text-sm text-[var(--text-muted)]">Browse TITAN workspace and generated documents</p>
          </div>
        </div>
        <button onClick={() => refresh()} className="p-2 rounded-md border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] transition-colors">
          <RefreshCw size={14} />
        </button>
      </div>

      {/* Breadcrumb */}
      <div className="flex items-center gap-1 text-sm bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg px-3 py-2 overflow-x-auto">
        <button onClick={() => navigateTo('')} className="flex items-center gap-1 text-[var(--accent)] hover:underline flex-shrink-0">
          <Home size={14} /> ~/.titan
        </button>
        {pathParts.map((part, i) => (
          <span key={i} className="flex items-center gap-1 flex-shrink-0">
            <ChevronRight size={12} className="text-[var(--text-muted)]" />
            <button
              onClick={() => navigateTo(pathParts.slice(0, i + 1).join('/'))}
              className={i === pathParts.length - 1 ? 'text-[var(--text)] font-medium' : 'text-[var(--accent)] hover:underline'}
            >
              {part}
            </button>
          </span>
        ))}
      </div>

      <div className="flex gap-4" style={{ height: 'calc(100vh - 260px)' }}>
        {/* File list */}
        <div className={`${selectedFile ? 'w-1/3' : 'w-full'} bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg overflow-hidden flex flex-col transition-all`}>
          {/* Back button */}
          {currentPath && (
            <button onClick={goUp} className="flex items-center gap-2 px-4 py-2 text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] border-b border-[var(--border)] transition-colors">
              <ArrowLeft size={14} /> Back
            </button>
          )}

          {/* Entries */}
          <div className="flex-1 overflow-y-auto">
            {loading ? (
              <div className="p-4 text-[var(--text-muted)] text-sm">Loading...</div>
            ) : entries.length === 0 ? (
              <div className="p-8 text-center text-[var(--text-muted)]">
                <FolderOpen className="w-10 h-10 mx-auto mb-2 opacity-50" />
                <p className="text-sm">Empty directory</p>
              </div>
            ) : (
              entries.map(entry => (
                <button
                  key={entry.path}
                  onClick={() => openFile(entry)}
                  className={`w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-[var(--bg-tertiary)] border-b border-[var(--border)]/30 transition-colors ${
                    selectedFile?.path === entry.path ? 'bg-[var(--accent)]/10 border-l-2 border-l-[var(--accent)]' : ''
                  }`}
                >
                  {entry.type === 'directory' ? (
                    <FolderOpen size={14} className="text-[var(--accent)] flex-shrink-0" />
                  ) : (
                    getFileIcon(entry.name)
                  )}
                  <div className="flex-1 min-w-0">
                    <p className={`text-sm truncate ${entry.type === 'directory' ? 'text-[var(--accent)] font-medium' : 'text-[var(--text)]'}`}>
                      {entry.name}
                    </p>
                    <div className="flex items-center gap-3 text-[10px] text-[var(--text-muted)]">
                      {entry.type === 'file' && <span>{formatSize(entry.size)}</span>}
                      {entry.modified && (
                        <span className="flex items-center gap-1">
                          <Clock size={10} /> {formatTime(entry.modified)}
                        </span>
                      )}
                    </div>
                  </div>
                  {entry.type === 'directory' && <ChevronRight size={14} className="text-[var(--text-muted)] flex-shrink-0" />}
                </button>
              ))
            )}
          </div>
        </div>

        {/* File viewer */}
        {selectedFile && (
          <div className="flex-1 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg overflow-hidden flex flex-col">
            {/* File header */}
            <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--border)] bg-[var(--bg-tertiary)]">
              <div className="flex items-center gap-2 min-w-0">
                {getFileIcon(selectedFile.path)}
                <span className="text-sm font-medium text-[var(--text)] truncate">{selectedFile.path.split('/').pop()}</span>
                <span className="text-[10px] text-[var(--text-muted)] flex-shrink-0">{formatSize(selectedFile.size)}</span>
                {selectedFile.truncated && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--warning)]/15 text-[var(--warning)] border border-[var(--warning)]/20 flex-shrink-0">
                    Truncated (1MB limit)
                  </span>
                )}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    const blob = new Blob([selectedFile.content], { type: 'text/plain' });
                    const a = document.createElement('a');
                    a.href = URL.createObjectURL(blob);
                    a.download = selectedFile.path.split('/').pop() || 'file.txt';
                    a.click();
                  }}
                  className="p-1.5 rounded text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--bg-secondary)] transition-colors"
                  title="Download"
                >
                  <Download size={14} />
                </button>
                <button onClick={() => setSelectedFile(null)} className="text-xs text-[var(--text-muted)] hover:text-[var(--text)]">
                  Close
                </button>
              </div>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-auto">
              {fileLoading ? (
                <div className="p-4 text-[var(--text-muted)] text-sm">Loading file...</div>
              ) : getLanguage(selectedFile.path) === 'json' ? (
                <pre className="p-4 text-xs font-mono text-[var(--text-secondary)] whitespace-pre-wrap break-words leading-relaxed">
                  {(() => {
                    try { return JSON.stringify(JSON.parse(selectedFile.content), null, 2); }
                    catch { return selectedFile.content; }
                  })()}
                </pre>
              ) : (
                <pre className="p-4 text-xs font-mono text-[var(--text-secondary)] whitespace-pre-wrap break-words leading-relaxed">
                  {selectedFile.content}
                </pre>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default FilesPanel;
