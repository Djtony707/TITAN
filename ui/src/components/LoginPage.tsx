import { useState, useCallback, type FormEvent } from 'react';
import { useAuth } from '@/hooks/useAuth';

export function LoginPage() {
  const { login } = useAuth();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!password.trim()) return;

      setError('');
      setLoading(true);
      try {
        await login(password);
      } catch {
        setError('Incorrect password. Please try again.');
      } finally {
        setLoading(false);
      }
    },
    [password, login],
  );

  return (
    <div className="relative flex items-center justify-center min-h-screen bg-[var(--color-bg)] overflow-hidden">
      {/* Subtle animated background glow */}
      <div
        className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] rounded-full opacity-[0.07] blur-[120px] pointer-events-none"
        style={{ background: 'radial-gradient(circle, var(--color-accent), var(--color-accent2))' }}
      />

      <div className="relative z-10 w-full max-w-md mx-6">
        {/* Header */}
        <div className="text-center mb-10">
          {/* TITAN Logo Mark */}
          <div className="inline-flex items-center justify-center w-20 h-20 rounded-2xl mb-6" style={{
            background: 'linear-gradient(135deg, rgba(99,102,241,0.15), rgba(168,85,247,0.15))',
            border: '1px solid rgba(99,102,241,0.25)',
            boxShadow: '0 0 40px rgba(99,102,241,0.1), inset 0 1px 0 rgba(255,255,255,0.05)',
          }}>
            <svg viewBox="0 0 32 32" fill="none" className="w-10 h-10">
              <path d="M16 3L4 9.5v13L16 29l12-6.5v-13L16 3z" stroke="url(#titan-grad)" strokeWidth={1.5} strokeLinejoin="round" />
              <path d="M16 3v26M4 9.5L28 22.5M28 9.5L4 22.5" stroke="url(#titan-grad)" strokeWidth={1} opacity={0.4} />
              <circle cx={16} cy={16} r={4} fill="url(#titan-grad)" opacity={0.8} />
              <defs>
                <linearGradient id="titan-grad" x1="4" y1="3" x2="28" y2="29">
                  <stop stopColor="#6366f1" />
                  <stop offset={1} stopColor="#a855f7" />
                </linearGradient>
              </defs>
            </svg>
          </div>

          <h1 className="text-3xl font-bold text-[var(--color-text)] tracking-tight">
            TITAN
          </h1>
          <p className="text-base text-[var(--color-text-muted)] mt-2 tracking-wide">
            Mission Control
          </p>
        </div>

        {/* Login Card */}
        <div className="rounded-2xl p-8" style={{
          background: 'linear-gradient(180deg, rgba(24,24,27,0.95), rgba(24,24,27,0.8))',
          border: '1px solid rgba(63,63,70,0.6)',
          boxShadow: '0 25px 50px -12px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.02)',
          backdropFilter: 'blur(20px)',
        }}>
          <form onSubmit={handleSubmit} className="space-y-6">
            <div>
              <label
                htmlFor="password"
                className="block text-sm font-medium text-[var(--color-text-secondary)] mb-2"
              >
                Gateway Password
              </label>
              <input
                id="password"
                type="password"
                autoFocus
                autoComplete="current-password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  if (error) setError('');
                }}
                placeholder="Enter your password"
                className="w-full px-4 py-3 rounded-xl text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none transition-all text-sm"
                style={{
                  background: 'rgba(9,9,11,0.8)',
                  border: error
                    ? '1px solid var(--color-error)'
                    : '1px solid rgba(63,63,70,0.8)',
                  boxShadow: 'inset 0 2px 4px rgba(0,0,0,0.2)',
                }}
                onFocus={(e) => {
                  if (!error) e.currentTarget.style.border = '1px solid var(--color-accent)';
                  e.currentTarget.style.boxShadow = 'inset 0 2px 4px rgba(0,0,0,0.2), 0 0 0 3px rgba(99,102,241,0.15)';
                }}
                onBlur={(e) => {
                  if (!error) e.currentTarget.style.border = '1px solid rgba(63,63,70,0.8)';
                  e.currentTarget.style.boxShadow = 'inset 0 2px 4px rgba(0,0,0,0.2)';
                }}
              />
            </div>

            {/* Error message */}
            {error && (
              <div className="flex items-center gap-2 text-sm text-[var(--color-error)]">
                <svg className="w-4 h-4 shrink-0" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                </svg>
                {error}
              </div>
            )}

            {/* Submit button */}
            <button
              type="submit"
              disabled={loading || !password.trim()}
              className="w-full py-3 rounded-xl text-white font-semibold text-sm tracking-wide transition-all disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
              style={{
                background: loading || !password.trim()
                  ? 'rgba(99,102,241,0.3)'
                  : 'linear-gradient(135deg, #6366f1, #7c3aed)',
                boxShadow: loading || !password.trim()
                  ? 'none'
                  : '0 4px 14px rgba(99,102,241,0.35), inset 0 1px 0 rgba(255,255,255,0.15)',
              }}
              onMouseEnter={(e) => {
                if (!loading && password.trim()) {
                  e.currentTarget.style.background = 'linear-gradient(135deg, #818cf8, #8b5cf6)';
                  e.currentTarget.style.boxShadow = '0 6px 20px rgba(99,102,241,0.45), inset 0 1px 0 rgba(255,255,255,0.15)';
                  e.currentTarget.style.transform = 'translateY(-1px)';
                }
              }}
              onMouseLeave={(e) => {
                if (!loading && password.trim()) {
                  e.currentTarget.style.background = 'linear-gradient(135deg, #6366f1, #7c3aed)';
                  e.currentTarget.style.boxShadow = '0 4px 14px rgba(99,102,241,0.35), inset 0 1px 0 rgba(255,255,255,0.15)';
                  e.currentTarget.style.transform = 'translateY(0)';
                }
              }}
            >
              {loading ? (
                <span className="inline-flex items-center gap-2">
                  <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx={12} cy={12} r={10} stroke="currentColor" strokeWidth={4} />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Signing in...
                </span>
              ) : (
                'Sign In'
              )}
            </button>
          </form>
        </div>

        {/* Footer */}
        <p className="text-center text-xs text-[var(--color-text-muted)] mt-8 opacity-60">
          TITAN Agent Framework
        </p>
      </div>
    </div>
  );
}
