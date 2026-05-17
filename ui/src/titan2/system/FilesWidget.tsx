/**
 * Titan 3.0 Files Widget
 * A simple file explorer widget for the Canvas.
 */

import React, { useState, useEffect } from 'react';
import { FileText, Folder, ChevronRight, RefreshCw } from 'lucide-react';
import { apiFetch } from '@/api/client';

interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
}

export function FilesWidget() {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [path, setPath] = useState('/');
  const [loading, setLoading] = useState(false);
  // v6.1.0-beta.23 — replaced the "prototype mock data" fallback (which
  // showed fabricated `documents/ readme.md config.yaml` entries on any
  // API failure) with a real error string. Tony's mock-data audit
  // (2026-05-17) flagged the fallback as misleading — users couldn't
  // tell the listing was fake.
  const [error, setError] = useState<string | null>(null);

  const loadFiles = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/files?path=${encodeURIComponent(path)}`);
      if (res.ok) {
        const data = await res.json();
        setFiles(data.files || []);
      } else {
        setFiles([]);
        setError(`Couldn't load files (HTTP ${res.status})`);
      }
    } catch (err) {
      setFiles([]);
      setError(`Couldn't reach /api/files — ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadFiles();
  }, [path]);

  return (
    <div className="w-full h-full flex flex-col">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[#27272a]/40">
        <div className="flex items-center gap-1 text-[11px] text-[#71717a]">
          <span className="text-[#6366f1]">~</span>
          <ChevronRight className="w-3 h-3" />
          <span>{path}</span>
        </div>
        <button onClick={loadFiles} className="p-1 text-[#3f3f46] hover:text-[#71717a]">
          <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* File list / error */}
      <div className="flex-1 overflow-auto">
        {error && (
          <div className="px-3 py-2 text-[11px] text-[#ef4444]/80">{error}</div>
        )}
        {!error && !loading && files.length === 0 && (
          <div className="px-3 py-2 text-[11px] text-[#52525b]">No files</div>
        )}
        {files.map(file => (
          <button
            key={file.path}
            onClick={() => file.type === 'directory' && setPath(file.path)}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-[#27272a]/20 transition-colors"
          >
            {file.type === 'directory' ? (
              <Folder className="w-3.5 h-3.5 text-[#f59e0b]" />
            ) : (
              <FileText className="w-3.5 h-3.5 text-[#6366f1]" />
            )}
            <span className="text-[12px] text-[#a1a1aa]">{file.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
