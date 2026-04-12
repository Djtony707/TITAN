import { useState, useEffect, useCallback, useRef } from 'react';
import {
  FolderOpen, File, ChevronRight, Home, RefreshCw, ArrowLeft, Download,
  FileText, Database, Settings as SettingsIcon, Clock, Plus, FolderPlus,
  Pencil, Trash2, Save, X, Check,
} from 'lucide-react';
import { listFiles, readFile, getFileRoots, writeFile, createDirectory, renameFile, deleteFile } from '@/api/client';
import type { FileEntry, FileContent } from '@/api/types';

function FilesPanel() {
  // ── State ──
  const [roots, setRoots] = useState<Array<{ label: string; path: string }>>([]);
  const [activeRoot, setActiveRoot] = useState<string>('');
  const [currentPath, setCurrentPath] = useState('');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [selectedFile, setSelectedFile] = useState<FileContent | null>(null);
  const [loading, setLoading] = useState(true);
  const [fileLoading, setFileLoading] = useState(false);

  // Edit mode
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);

  // Create modals
  const [showNewFile, setShowNewFile] = useState(false);
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newName, setNewName] = useState('');

  // Inline rename
  const [renamingEntry, setRenamingEntry] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameRef = useRef<HTMLInputElement>(null);

  // Delete confirm
  const [deleteTarget, setDeleteTarget] = useState<FileEntry | null>(null);

  // Error toast
  const [error, setError] = useState('');

  // ── Load roots on mount ──
  useEffect(() => {
    getFileRoots().then(r => {
      setRoots(r.roots);
      if (r.roots.length > 0 && !activeRoot) setActiveRoot(r.roots[0].path);
    }).catch(() => {});
  }, []);

  // ── Refresh directory listing ──
  const refresh = useCallback(async (path?: string) => {
    setLoading(true);
    try {
      const result = await listFiles(path ?? currentPath, activeRoot || undefined);
      setEntries(result.entries);
    } catch { /* ignore */ }
    setLoading(false);
  }, [currentPath, activeRoot]);

  useEffect(() => { if (activeRoot) refresh(currentPath); }, [currentPath, activeRoot]);

  const navigateTo = (path: string) => {
    setCurrentPath(path);
    setSelectedFile(null);
    setEditing(false);
  };

  const goUp = () => {
    const parts = currentPath.split('/').filter(Boolean);
    parts.pop();
    navigateTo(parts.join('/'));
  };

  const openFile = async (entry: FileEntry) => {
    if (entry.type === 'directory') { navigateTo(entry.path); return; }
    setFileLoading(true);
    setEditing(false);
    try {
      const content = await readFile(entry.path, activeRoot || undefined);
      setSelectedFile(content);
    } catch { /* ignore */ }
    setFileLoading(false);
  };

  // ── Write operations ──
  const handleSave = async () => {
    if (!selectedFile) return;
    setSaving(true);
    setError('');
    try {
      await writeFile(selectedFile.path, editContent, activeRoot || undefined);
      setSelectedFile({ ...selectedFile, content: editContent, size: new Blob([editContent]).size });
      setEditing(false);
    } catch (e) { setError((e as Error).message); }
    setSaving(false);
  };

  const handleCreateFile = async () => {
    if (!newName.trim()) return;
    setError('');
    try {
      const path = currentPath ? `${currentPath}/${newName.trim()}` : newName.trim();
      await writeFile(path, '', activeRoot || undefined);
      setShowNewFile(false);
      setNewName('');
      refresh();
    } catch (e) { setError((e as Error).message); }
  };

  const handleCreateFolder = async () => {
    if (!newName.trim()) return;
    setError('');
    try {
      const path = currentPath ? `${currentPath}/${newName.trim()}` : newName.trim();
      await createDirectory(path, activeRoot || undefined);
      setShowNewFolder(false);
      setNewName('');
      refresh();
    } catch (e) { setError((e as Error).message); }
  };

  const handleRename = async (entry: FileEntry) => {
    if (!renameValue.trim() || renameValue === entry.name) { setRenamingEntry(null); return; }
    setError('');
    try {
      const parentPath = entry.path.split('/').slice(0, -1).join('/');
      const newPath = parentPath ? `${parentPath}/${renameValue.trim()}` : renameValue.trim();
      await renameFile(entry.path, newPath, activeRoot || undefined);
      setRenamingEntry(null);
      refresh();
    } catch (e) { setError((e as Error).message); }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setError('');
    try {
      await deleteFile(deleteTarget.path, activeRoot || undefined);
      setDeleteTarget(null);
      if (selectedFile?.path === deleteTarget.path) setSelectedFile(null);
      refresh();
    } catch (e) { setError((e as Error).message); setDeleteTarget(null); }
  };

  // Focus rename input
  useEffect(() => { if (renamingEntry && renameRef.current) renameRef.current.focus(); }, [renamingEntry]);

  // ── Formatters ──
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
      const diff = Date.now() - d.getTime();
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

  const pathParts = currentPath ? currentPath.split('/').filter(Boolean) : [];
  const activeRootLabel = roots.find(r => r.path === activeRoot)?.label || '~/.titan';

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <FolderOpen className="w-6 h-6 text-[var(--accent)]" />
          <div>
            <h1 className="text-xl font-bold text-[var(--text)]">File Manager</h1>
            <p className="text-sm text-[var(--text-muted)]">Browse, edit, and manage TITAN files</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => { setShowNewFile(true); setNewName(''); }} className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-[var(--border)] text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] transition-colors" title="New File">
            <Plus size={12} /> File
          </button>
          <button onClick={() => { setShowNewFolder(true); setNewName(''); }} className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-[var(--border)] text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] transition-colors" title="New Folder">
            <FolderPlus size={12} /> Folder
          </button>
          <button onClick={() => refresh()} className="p-2 rounded-md border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] transition-colors">
            <RefreshCw size={14} />
          </button>
        </div>
      </div>

      {/* Error toast */}
      {error && (
        <div className="flex items-center justify-between px-3 py-2 bg-red-500/10 border border-red-500/20 rounded-lg text-sm text-red-400">
          <span>{error}</span>
          <button onClick={() => setError('')}><X size={14} /></button>
        </div>
      )}

      {/* Root selector + Breadcrumb */}
      <div className="flex items-center gap-2 text-sm">
        {roots.length > 1 && (
          <select
            value={activeRoot}
            onChange={e => { setActiveRoot(e.target.value); setCurrentPath(''); setSelectedFile(null); }}
            className="px-2 py-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--text)] text-xs"
          >
            {roots.map(r => <option key={r.path} value={r.path}>{r.label}</option>)}
          </select>
        )}
        <div className="flex-1 flex items-center gap-1 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg px-3 py-2 overflow-x-auto">
          <button onClick={() => navigateTo('')} className="flex items-center gap-1 text-[var(--accent)] hover:underline flex-shrink-0">
            <Home size={14} /> {activeRootLabel}
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
      </div>

      <div className="flex gap-4" style={{ height: 'calc(100vh - 280px)' }}>
        {/* File list */}
        <div className={`${selectedFile ? 'w-1/3' : 'w-full'} bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg overflow-hidden flex flex-col transition-all`}>
          {currentPath && (
            <button onClick={goUp} className="flex items-center gap-2 px-4 py-2 text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] border-b border-[var(--border)] transition-colors">
              <ArrowLeft size={14} /> Back
            </button>
          )}

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
                <div
                  key={entry.path}
                  className={`group w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-[var(--bg-tertiary)] border-b border-[var(--border)]/30 transition-colors cursor-pointer ${
                    selectedFile?.path === entry.path ? 'bg-[var(--accent)]/10 border-l-2 border-l-[var(--accent)]' : ''
                  }`}
                  onClick={() => renamingEntry !== entry.path && openFile(entry)}
                >
                  {entry.type === 'directory' ? (
                    <FolderOpen size={14} className="text-[var(--accent)] flex-shrink-0" />
                  ) : (
                    getFileIcon(entry.name)
                  )}
                  <div className="flex-1 min-w-0">
                    {renamingEntry === entry.path ? (
                      <input
                        ref={renameRef}
                        value={renameValue}
                        onChange={e => setRenameValue(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') handleRename(entry);
                          if (e.key === 'Escape') setRenamingEntry(null);
                        }}
                        onBlur={() => handleRename(entry)}
                        className="text-sm bg-[var(--bg-tertiary)] border border-[var(--accent)] rounded px-1.5 py-0.5 text-[var(--text)] w-full outline-none"
                        onClick={e => e.stopPropagation()}
                      />
                    ) : (
                      <>
                        <p className={`text-sm truncate ${entry.type === 'directory' ? 'text-[var(--accent)] font-medium' : 'text-[var(--text)]'}`}>
                          {entry.name}
                        </p>
                        <div className="flex items-center gap-3 text-[10px] text-[var(--text-muted)]">
                          {entry.type === 'file' && <span>{formatSize(entry.size)}</span>}
                          {entry.modified && (
                            <span className="flex items-center gap-1"><Clock size={10} /> {formatTime(entry.modified)}</span>
                          )}
                        </div>
                      </>
                    )}
                  </div>

                  {/* Action buttons on hover */}
                  {renamingEntry !== entry.path && (
                    <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                      <button
                        onClick={e => { e.stopPropagation(); setRenamingEntry(entry.path); setRenameValue(entry.name); }}
                        className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--bg-secondary)]"
                        title="Rename"
                      >
                        <Pencil size={12} />
                      </button>
                      <button
                        onClick={e => { e.stopPropagation(); setDeleteTarget(entry); }}
                        className="p-1 rounded text-[var(--text-muted)] hover:text-red-400 hover:bg-red-500/10"
                        title="Delete"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  )}

                  {entry.type === 'directory' && renamingEntry !== entry.path && (
                    <ChevronRight size={14} className="text-[var(--text-muted)] flex-shrink-0" />
                  )}
                </div>
              ))
            )}
          </div>
        </div>

        {/* File viewer / editor */}
        {selectedFile && (
          <div className="flex-1 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg overflow-hidden flex flex-col">
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
                {editing && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--accent)]/15 text-[var(--accent)] border border-[var(--accent)]/20 flex-shrink-0">
                    Editing
                  </span>
                )}
              </div>
              <div className="flex gap-1.5">
                {editing ? (
                  <>
                    <button onClick={handleSave} disabled={saving} className="flex items-center gap-1 px-2 py-1 rounded text-xs bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-50">
                      <Save size={12} /> {saving ? 'Saving...' : 'Save'}
                    </button>
                    <button onClick={() => { setEditing(false); setEditContent(''); }} className="flex items-center gap-1 px-2 py-1 rounded text-xs text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--bg-secondary)]">
                      <X size={12} /> Cancel
                    </button>
                  </>
                ) : (
                  <>
                    {!selectedFile.truncated && (
                      <button
                        onClick={() => { setEditing(true); setEditContent(selectedFile.content); }}
                        className="flex items-center gap-1 p-1.5 rounded text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--bg-secondary)] transition-colors"
                        title="Edit"
                      >
                        <Pencil size={14} />
                      </button>
                    )}
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
                    <button onClick={() => { setSelectedFile(null); setEditing(false); }} className="text-xs text-[var(--text-muted)] hover:text-[var(--text)] px-1">
                      Close
                    </button>
                  </>
                )}
              </div>
            </div>

            <div className="flex-1 overflow-auto">
              {fileLoading ? (
                <div className="p-4 text-[var(--text-muted)] text-sm">Loading file...</div>
              ) : editing ? (
                <textarea
                  value={editContent}
                  onChange={e => setEditContent(e.target.value)}
                  className="w-full h-full p-4 text-xs font-mono text-[var(--text-secondary)] bg-transparent resize-none outline-none leading-relaxed"
                  spellCheck={false}
                />
              ) : getLanguage(selectedFile.path) === 'json' ? (
                <pre className="p-4 text-xs font-mono text-[var(--text-secondary)] whitespace-pre-wrap break-words leading-relaxed">
                  {(() => { try { return JSON.stringify(JSON.parse(selectedFile.content), null, 2); } catch { return selectedFile.content; } })()}
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

      {/* ── Modals ── */}

      {/* New File Modal */}
      {showNewFile && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowNewFile(false)}>
          <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-xl p-5 w-80 space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-[var(--text)]">New File</h3>
            <input
              autoFocus
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleCreateFile()}
              placeholder="filename.txt"
              className="w-full px-3 py-2 rounded-md border border-[var(--border)] bg-[var(--bg-tertiary)] text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
            />
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowNewFile(false)} className="px-3 py-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text)]">Cancel</button>
              <button onClick={handleCreateFile} className="flex items-center gap-1 px-3 py-1.5 text-xs bg-[var(--accent)] text-white rounded-md hover:opacity-90">
                <Check size={12} /> Create
              </button>
            </div>
          </div>
        </div>
      )}

      {/* New Folder Modal */}
      {showNewFolder && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowNewFolder(false)}>
          <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-xl p-5 w-80 space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-[var(--text)]">New Folder</h3>
            <input
              autoFocus
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleCreateFolder()}
              placeholder="folder-name"
              className="w-full px-3 py-2 rounded-md border border-[var(--border)] bg-[var(--bg-tertiary)] text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
            />
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowNewFolder(false)} className="px-3 py-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text)]">Cancel</button>
              <button onClick={handleCreateFolder} className="flex items-center gap-1 px-3 py-1.5 text-xs bg-[var(--accent)] text-white rounded-md hover:opacity-90">
                <Check size={12} /> Create
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteTarget && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setDeleteTarget(null)}>
          <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-xl p-5 w-80 space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-[var(--text)]">Delete {deleteTarget.type === 'directory' ? 'Folder' : 'File'}?</h3>
            <p className="text-xs text-[var(--text-muted)]">
              Are you sure you want to delete <span className="font-mono text-[var(--text)]">{deleteTarget.name}</span>? This cannot be undone.
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setDeleteTarget(null)} className="px-3 py-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text)]">Cancel</button>
              <button onClick={handleDelete} className="flex items-center gap-1 px-3 py-1.5 text-xs bg-red-500 text-white rounded-md hover:opacity-90">
                <Trash2 size={12} /> Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default FilesPanel;
