import { useEffect, useState } from 'react';
import { Search, Trash2, X } from 'lucide-react';
import { PageHeader } from '@/components/shared/PageHeader';
import { InlineEditableField } from '@/components/shared';
import { getSessions, getSessionMessages, deleteSession, renameSession } from '@/api/client';
import type { Session, ChatMessage } from '@/api/types';
import { DataTable, type Column } from '@/components/shared/DataTable';

function SessionsPanel() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);

  const fetchSessions = async () => {
    try {
      const data = await getSessions();
      setSessions(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch sessions');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSessions();
  }, []);

  const handleRowClick = async (session: Session) => {
    setSelectedSession(session.id);
    setMessagesLoading(true);
    try {
      const msgs = await getSessionMessages(session.id);
      setMessages(msgs);
    } catch {
      setMessages([]);
    } finally {
      setMessagesLoading(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteSession(id);
      if (selectedSession === id) {
        setSelectedSession(null);
        setMessages([]);
      }
      await fetchSessions();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete session');
    }
  };

  const filtered = sessions.filter((s) => {
    if (!filter) return true;
    const q = filter.toLowerCase();
    return (
      s.id.toLowerCase().includes(q) ||
      s.name?.toLowerCase().includes(q) ||
      s.lastMessage?.toLowerCase().includes(q)
    );
  });

  const columns: Column<Session>[] = [
    {
      key: 'id',
      header: 'ID',
      render: (row) => (
        <span className="font-mono text-xs">{row.id.slice(0, 12)}...</span>
      ),
    },
    {
      key: 'name',
      header: 'Name',
      render: (row) => (
        <span className="text-sm text-text">
          <InlineEditableField
            value={row.name ?? ''}
            onSave={async (v) => { await renameSession(row.id, v); await fetchSessions(); }}
            placeholder="Session name"
            emptyLabel="Untitled"
            hidePencil
          />
        </span>
      ),
    },
    { key: 'messageCount', header: 'Messages' },
    {
      key: 'lastMessage',
      header: 'Last Message',
      render: (row) => (
        <span className="block max-w-xs truncate text-text-secondary">
          {row.lastMessage ?? '-'}
        </span>
      ),
    },
    {
      key: 'createdAt',
      header: 'Created',
      render: (row) => <span>{new Date(row.createdAt).toLocaleString()}</span>,
    },
    {
      key: '_actions',
      header: '',
      className: 'w-16',
      render: (row) => (
        <button
          onClick={(e) => {
            e.stopPropagation();
            handleDelete(row.id);
          }}
          className="rounded-md p-1.5 text-error transition-colors hover:bg-bg-tertiary"
          title="Delete session"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      ),
    },
  ];

  if (loading) {
    return (
      <div className="h-64 animate-pulse rounded-xl border border-border bg-bg-secondary" />
    );
  }

  return (
    <div className="flex gap-4">
      <div className={`space-y-4 ${selectedSession ? 'flex-1' : 'w-full'}`}>
        <PageHeader title="Sessions" breadcrumbs={[{label:'Admin', href:'/overview'}, {label:'Monitoring'}, {label:'Sessions'}]} />

        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search sessions..."
            className="w-full rounded-lg border border-border bg-bg py-2 pl-10 pr-3 text-sm text-text outline-none focus:border-accent"
          />
        </div>

        {error && (
          <div className="rounded-lg border border-error/50 bg-bg-secondary px-4 py-2 text-sm text-error">
            {error}
          </div>
        )}

        <DataTable
          columns={columns}
          data={filtered}
          onRowClick={handleRowClick}
          emptyMessage="No sessions found"
        />
      </div>

      {selectedSession && (
        <div className="w-96 shrink-0 rounded-xl border border-border bg-bg-secondary">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <h3 className="text-sm font-medium text-text">Messages</h3>
            <button
              onClick={() => {
                setSelectedSession(null);
                setMessages([]);
              }}
              className="rounded-md p-1 text-text-muted hover:text-text"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="max-h-[600px] overflow-y-auto p-4">
            {messagesLoading ? (
              <div className="space-y-3">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="h-12 animate-pulse rounded-lg bg-bg-tertiary" />
                ))}
              </div>
            ) : messages.length === 0 ? (
              <p className="text-center text-sm text-text-muted">No messages</p>
            ) : (
              <div className="space-y-3">
                {messages.map((msg, i) => (
                  <div
                    key={i}
                    className={`rounded-lg p-3 text-sm ${
                      msg.role === 'user'
                        ? 'bg-accent/10 text-text'
                        : msg.role === 'assistant'
                          ? 'bg-bg-tertiary text-text'
                          : 'bg-bg text-text-secondary'
                    }`}
                  >
                    <span className="mb-1 block text-xs font-medium uppercase text-text-muted">
                      {msg.role}
                    </span>
                    <p className="whitespace-pre-wrap">{msg.content}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default SessionsPanel;
