/**
 * TITAN — Command Post Social Media tab
 *
 * Controls Facebook autopilot, shows draft queue, recent posts,
 * and Graphiti-aware composer hints for contextual follow-ups.
 */
import { useState, useEffect, useCallback } from 'react';
import {
  Share2, RefreshCw, Send, CheckCircle2, XCircle,
  Clock, MessageSquare, Zap, AlertCircle, Lightbulb,
  Type,
} from 'lucide-react';
import {
  getSocialState,
  toggleSocialAutopilot,
  postSocial,
  approveSocialDraft,
  rejectSocialDraft,
  getSocialGraphContext,
} from '@/api/client';
import type { SocialState, SocialQueuedPost, SocialRecentPost } from '@/api/types';

function timeSince(d: string): string {
  const s = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

const CONTENT_LABELS: Record<string, string> = {
  activity: 'Activity',
  spotlight: 'Spotlight',
  stats: 'Stats',
  tips: 'Tips',
  promo: 'Promo',
  usecase: 'Use Case',
  eli5: 'ELI5',
};

const CONTENT_COLORS: Record<string, string> = {
  activity: 'var(--color-accent-hover)',
  spotlight: 'var(--color-emerald)',
  stats: 'var(--color-cyan)',
  tips: '#fbbf24',
  promo: '#f472b6',
  usecase: 'var(--color-purple-light)',
  eli5: '#fb923c',
};

export default function CPSocial() {
  const [state, setState] = useState<SocialState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [composerText, setComposerText] = useState('');
  const [posting, setPosting] = useState(false);
  const [graphHint, setGraphHint] = useState<string | null>(null);
  const [processingDraft, setProcessingDraft] = useState<string | null>(null);

  const fetchState = useCallback(async () => {
    try {
      setError(null);
      const s = await getSocialState();
      setState(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load social state');
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchGraphHint = useCallback(async () => {
    try {
      const ctx = await getSocialGraphContext();
      const topics = ctx.recentTopics;
      if (topics.length === 0) {
        setGraphHint(null);
        return;
      }
      // Build a hint from recent post entities / content
      const recent = topics.slice(0, 3);
      const preview = recent.map(t => {
        const words = t.content.split(/\s+/).slice(0, 6).join(' ');
        return `"${words}..."`;
      }).join(', ');
      setGraphHint(`💡 Recent social posts: ${preview}. Consider a follow-up on a related but fresh topic.`);
    } catch {
      setGraphHint(null);
    }
  }, []);

  useEffect(() => {
    fetchState();
    fetchGraphHint();
  }, [fetchState, fetchGraphHint]);

  const handleToggleAutopilot = async () => {
    if (!state) return;
    const next = !state.autopilot.enabled;
    try {
      await toggleSocialAutopilot(next);
      setState(prev => prev ? { ...prev, autopilot: { ...prev.autopilot, enabled: next } } : prev);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Toggle failed');
    }
  };

  const handlePostNow = async () => {
    if (!composerText.trim()) return;
    setPosting(true);
    try {
      const result = await postSocial(composerText.trim());
      if (result.success) {
        setComposerText('');
        await fetchState();
        await fetchGraphHint();
      } else {
        setError(result.error || result.skipped || 'Post failed');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Post failed');
    } finally {
      setPosting(false);
    }
  };

  const handleApprove = async (id: string) => {
    setProcessingDraft(id);
    try {
      await approveSocialDraft(id);
      await fetchState();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Approve failed');
    } finally {
      setProcessingDraft(null);
    }
  };

  const handleReject = async (id: string) => {
    setProcessingDraft(id);
    try {
      await rejectSocialDraft(id);
      await fetchState();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reject failed');
    } finally {
      setProcessingDraft(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-5 h-5 border-2 border-indigo-500/30 border-t-indigo-500 rounded-full animate-spin" />
        <span className="ml-3 text-sm text-text-muted">Loading social media…</span>
      </div>
    );
  }

  const a = state?.autopilot;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-pink-500/10 border border-pink-500/20">
            <Share2 className="h-4 w-4 text-pink-400" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-white">Social Media</h2>
            <p className="text-[11px] text-text-muted">Facebook autopilot, drafts, and post history</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={fetchState}
            className="flex items-center gap-1.5 rounded-lg bg-bg-tertiary px-3 py-1.5 text-[11px] text-text-muted hover:bg-bg-tertiary transition-colors border border-border"
          >
            <RefreshCw className="h-3 w-3" /> Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-xs text-red-300">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {/* Stats + Toggle */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <div className="rounded-xl border border-border bg-bg-tertiary/30 px-4 py-3">
          <div className="flex items-center justify-between">
            <p className="text-[11px] text-text-muted">Autopilot</p>
            <button
              onClick={handleToggleAutopilot}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${a?.enabled ? 'bg-pink-500' : 'bg-white/10'}`}
            >
              <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${a?.enabled ? 'translate-x-4.5' : 'translate-x-1'}`} />
            </button>
          </div>
          <p className={`mt-1 text-sm font-semibold ${a?.enabled ? 'text-pink-400' : 'text-text-muted'}`}>
            {a?.enabled ? 'Enabled' : 'Paused'}
          </p>
        </div>
        <div className="rounded-xl border border-border bg-bg-tertiary/30 px-4 py-3">
          <p className="text-[11px] text-text-muted">Posts Today</p>
          <div className="flex items-baseline gap-2">
            <p className="text-xl font-bold text-white">{a?.postsToday ?? 0}</p>
            <p className="text-[11px] text-text-muted">/ {a?.maxPostsPerDay ?? 6}</p>
          </div>
        </div>
        <div className="rounded-xl border border-border bg-bg-tertiary/30 px-4 py-3">
          <p className="text-[11px] text-text-muted">Replies Today</p>
          <div className="flex items-baseline gap-2">
            <p className="text-xl font-bold text-white">{a?.repliesToday ?? 0}</p>
            <p className="text-[11px] text-text-muted">/ 10</p>
          </div>
        </div>
        <div className="rounded-xl border border-border bg-bg-tertiary/30 px-4 py-3">
          <p className="text-[11px] text-text-muted">Next Type</p>
          <p className="mt-1 text-sm font-semibold" style={{ color: CONTENT_COLORS[a?.nextContentType || 'activity'] || '#fff' }}>
            {CONTENT_LABELS[a?.nextContentType || 'activity'] || a?.nextContentType}
          </p>
        </div>
      </div>

      {/* Composer */}
      <div className="rounded-xl border border-border bg-bg-tertiary/30 p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Type className="h-4 w-4 text-pink-400" />
          <span className="text-sm font-medium text-white">Compose Post</span>
        </div>
        <textarea
          value={composerText}
          onChange={e => setComposerText(e.target.value)}
          placeholder="What's on your mind?"
          rows={3}
          className="w-full rounded-lg border border-border bg-black/20 px-3 py-2 text-sm text-white placeholder:text-text-muted focus:border-pink-500/50 focus:outline-none resize-none"
        />
        <div className="flex items-center justify-between">
          <span className={`text-[11px] ${composerText.length > 280 ? 'text-red-400' : 'text-text-muted'}`}>
            {composerText.length} chars
          </span>
          <button
            onClick={handlePostNow}
            disabled={posting || !composerText.trim()}
            className="flex items-center gap-1.5 rounded-lg bg-pink-500/20 px-4 py-1.5 text-xs font-medium text-pink-300 hover:bg-pink-500/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors border border-pink-500/20"
          >
            {posting ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
            Post Now
          </button>
        </div>
        {graphHint && (
          <div className="flex items-start gap-2 rounded-lg bg-amber-500/5 border border-amber-500/10 px-3 py-2">
            <Lightbulb className="h-3.5 w-3.5 text-amber-400 mt-0.5 shrink-0" />
            <p className="text-[11px] text-amber-200/70 leading-relaxed">{graphHint}</p>
          </div>
        )}
      </div>

      {/* Draft Queue */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Clock className="h-4 w-4 text-text-muted" />
          <span className="text-sm font-medium text-white">Draft Queue</span>
          <span className="text-[11px] text-text-muted ml-1">{state?.queue.length ?? 0} pending</span>
        </div>
        {state?.queue && state.queue.length > 0 ? (
          <div className="space-y-2">
            {state.queue.map((draft: SocialQueuedPost) => (
              <div
                key={draft.id}
                className="flex items-start gap-3 rounded-lg border border-border bg-bg-secondary/30 px-4 py-3"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-text break-words">{draft.content}</p>
                  <p className="mt-1 text-[10px] text-text-muted">
                    {draft.method} · {timeSince(draft.createdAt)} ago
                  </p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    onClick={() => handleApprove(draft.id)}
                    disabled={processingDraft === draft.id}
                    className="flex items-center gap-1 rounded-md bg-emerald-500/10 px-2.5 py-1 text-[11px] text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-40 transition-colors border border-emerald-500/15"
                  >
                    {processingDraft === draft.id ? <RefreshCw className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
                    Approve
                  </button>
                  <button
                    onClick={() => handleReject(draft.id)}
                    disabled={processingDraft === draft.id}
                    className="flex items-center gap-1 rounded-md bg-red-500/10 px-2.5 py-1 text-[11px] text-red-300 hover:bg-red-500/20 disabled:opacity-40 transition-colors border border-red-500/15"
                  >
                    <XCircle className="h-3 w-3" />
                    Reject
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-border bg-bg-secondary/30 px-4 py-6 text-center">
            <p className="text-xs text-text-muted">No pending drafts in the queue.</p>
          </div>
        )}
      </div>

      {/* Recent Posts */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-text-muted" />
          <span className="text-sm font-medium text-white">Recent Posts</span>
          <span className="text-[11px] text-text-muted ml-1">{state?.recentPosts.length ?? 0} tracked</span>
        </div>
        {state?.recentPosts && state.recentPosts.length > 0 ? (
          <div className="space-y-2">
            {state.recentPosts.map((post: SocialRecentPost, i: number) => (
              <div
                key={i}
                className="flex items-start gap-3 rounded-lg border border-border bg-bg-secondary/30 px-4 py-3"
              >
                <div
                  className="mt-0.5 h-2 w-2 rounded-full shrink-0"
                  style={{ backgroundColor: CONTENT_COLORS[post.type] || '#64748b' }}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span
                      className="text-[10px] font-medium px-1.5 py-0.5 rounded"
                      style={{ backgroundColor: (CONTENT_COLORS[post.type] || '#64748b') + '20', color: CONTENT_COLORS[post.type] || '#94a3b8' }}
                    >
                      {CONTENT_LABELS[post.type] || post.type}
                    </span>
                    <span className="text-[10px] text-text-muted">{timeSince(post.date)} ago</span>
                  </div>
                  <p className="text-sm text-text-secondary break-words">{post.content || '(content not stored)'}</p>
                  {post.postId && (
                    <p className="mt-1 text-[10px] text-text-muted font-mono">ID: {post.postId}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-border bg-bg-secondary/30 px-4 py-6 text-center">
            <p className="text-xs text-text-muted">No posts in history yet.</p>
          </div>
        )}
      </div>
    </div>
  );
}
