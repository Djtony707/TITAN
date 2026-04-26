import { useState } from 'react';
import { Send, Clock, User, Bot, MessageSquare } from 'lucide-react';
import type { CPApproval, CPComment } from '@/api/types';
import { replyToApproval } from '@/api/client';
import { useToast } from '@/components/shared/Toast';

interface ApprovalThreadProps {
  approval: CPApproval;
  onReply?: () => void;
}

function formatTime(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function ApprovalThread({ approval, onReply }: ApprovalThreadProps) {
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);
  const { toast } = useToast();
  const thread = approval.thread || [];

  const handleSend = async () => {
    if (!reply.trim()) return;
    setSending(true);
    try {
      await replyToApproval(approval.id, 'user', reply.trim());
      setReply('');
      onReply?.();
      toast('success', 'Reply sent');
    } catch (e) {
      toast('error', 'Failed to send reply');
    }
    setSending(false);
  };

  return (
    <div className="space-y-3 mt-3">
      {thread.length === 0 && (
        <div className="text-xs text-text-muted italic flex items-center gap-1">
          <MessageSquare size={12} />
          No replies yet. Start the conversation below.
        </div>
      )}
      {thread.map((msg: CPComment) => (
        <div
          key={msg.id}
          className={`flex gap-2 ${msg.authorUser ? 'flex-row' : 'flex-row-reverse'}`}
        >
          <div className={`w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 ${msg.authorUser ? 'bg-accent/20 text-accent' : 'bg-warning/20 text-warning'}`}>
            {msg.authorUser ? <User size={12} /> : <Bot size={12} />}
          </div>
          <div className={`max-w-[80%] rounded-lg px-3 py-2 text-xs ${msg.authorUser ? 'bg-bg-tertiary text-text' : 'bg-warning/10 text-text border border-warning/20'}`}>
            <div className="flex items-center gap-1.5 mb-1">
              <span className="font-semibold">{msg.authorUser || msg.authorAgentId || 'Agent'}</span>
              <Clock size={10} className="text-text-muted" />
              <span className="text-text-muted">{formatTime(msg.createdAt)}</span>
            </div>
            <div className="whitespace-pre-wrap">{msg.body}</div>
          </div>
        </div>
      ))}

      <div className="flex items-end gap-2 pt-2">
        <textarea
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          placeholder="Reply to this agent..."
          className="flex-1 min-h-[60px] rounded-lg border border-border bg-bg px-3 py-2 text-xs text-text outline-none focus:border-accent resize-none"
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
        />
        <button
          onClick={handleSend}
          disabled={sending || !reply.trim()}
          className="h-8 w-8 rounded-lg bg-accent text-white flex items-center justify-center disabled:opacity-40 hover:bg-accent/90 transition-colors"
        >
          <Send size={14} />
        </button>
      </div>
    </div>
  );
}
