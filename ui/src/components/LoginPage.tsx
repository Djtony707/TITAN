import { useState, useCallback, type FormEvent } from 'react';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';

export function LoginPage() {
  const { login } = useAuth();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [focused, setFocused] = useState(false);

  const handleSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!password.trim()) return;

      setError('');
      setLoading(true);
      try {
        await login(password);
      } catch {
        setError('Incorrect access token. Please try again.');
      } finally {
        setLoading(false);
      }
    },
    [password, login],
  );

  const canSubmit = password.trim().length > 0 && !loading;

  return (
    <div
      className="relative flex items-center justify-center min-h-screen overflow-hidden px-6"
      style={{
        background:
          'linear-gradient(135deg, var(--theme-bg-base) 0%, var(--theme-bg-grain) 55%, var(--theme-leather-edge) 100%)',
        fontFamily: 'var(--theme-font-display)',
      }}
    >
      {/* Vignette */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            'radial-gradient(ellipse at center, transparent 40%, var(--theme-bg-vignette) 100%)',
        }}
      />

      {/* Lamp glow — centered behind the login card, intimate radius */}
      <div
        className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[420px] h-[420px] rounded-full pointer-events-none"
        style={{
          background:
            'radial-gradient(circle, var(--theme-accent) 0%, transparent 65%)',
          opacity: 0.2,
          filter: 'blur(60px)',
        }}
      />

      <div className="relative z-10 w-[360px] max-w-full">
        {/* Brand */}
        <div className="text-center mb-8">
          <div
            className="inline-flex items-center justify-center w-16 h-16 rounded-2xl mb-5"
            style={{
              background:
                'linear-gradient(135deg, var(--theme-metal) 0%, var(--theme-metal-dark) 100%)',
              border: '1px solid var(--theme-metal-dark)',
              boxShadow:
                '0 0 40px color-mix(in srgb, var(--theme-accent) 30%, transparent), inset 0 1px 0 var(--theme-metal-bright)',
            }}
          >
            <svg viewBox="0 0 32 32" fill="none" className="w-9 h-9">
              <path
                d="M16 3L4 9.5v13L16 29l12-6.5v-13L16 3z"
                stroke="var(--theme-bolt)"
                strokeWidth={1.5}
                strokeLinejoin="round"
              />
              <path
                d="M16 3v26M4 9.5L28 22.5M28 9.5L4 22.5"
                stroke="var(--theme-bolt)"
                strokeWidth={1}
                opacity={0.4}
              />
              <circle cx={16} cy={16} r={4} fill="var(--theme-bolt)" opacity={0.85} />
            </svg>
          </div>

          <h1
            className="text-5xl font-bold"
            style={{
              color: 'var(--theme-paper)',
              fontFamily: 'var(--theme-font-display)',
              letterSpacing: '0.05em',
              textShadow:
                '0 0 24px color-mix(in srgb, var(--theme-accent) 45%, transparent), 0 2px 12px var(--theme-shadow)',
            }}
          >
            TITAN
          </h1>
          <p
            className="text-sm mt-3 italic"
            style={{
              color: 'var(--theme-ink-soft)',
              letterSpacing: '0.04em',
            }}
          >
            Mission Control awaits
          </p>
        </div>

        {/* Login card */}
        <div
          className="rounded-2xl"
          style={{
            padding: '40px',
            background:
              'linear-gradient(180deg, var(--theme-leather) 0%, var(--theme-leather-edge) 100%)',
            border: '1px solid var(--theme-metal-dark)',
            boxShadow:
              '0 18px 60px var(--theme-shadow), inset 0 1px 0 color-mix(in srgb, var(--theme-metal-bright) 18%, transparent), inset 0 -1px 0 var(--theme-leather-edge)',
          }}
        >
          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label
                htmlFor="password"
                className="block text-xs font-medium mb-2 uppercase"
                style={{
                  color: 'var(--theme-ink-soft)',
                  letterSpacing: '0.12em',
                }}
              >
                Access Token
              </label>

              <div className="relative">
                <input
                  id="password"
                  type={revealed ? 'text' : 'password'}
                  autoFocus
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    if (error) setError('');
                  }}
                  onFocus={() => setFocused(true)}
                  onBlur={() => setFocused(false)}
                  placeholder="Enter your TITAN access token"
                  className="w-full rounded-xl focus:outline-none transition-all"
                  style={{
                    padding: '12px 44px 12px 14px',
                    fontFamily: 'var(--theme-font-mono)',
                    fontSize: '14px',
                    letterSpacing: revealed ? '0.02em' : '0.18em',
                    color: 'var(--theme-paper)',
                    background:
                      'color-mix(in srgb, var(--theme-paper) 10%, transparent)',
                    border: error
                      ? '1px solid var(--theme-accent)'
                      : focused
                        ? '1px solid var(--theme-metal-bright)'
                        : '1px solid var(--theme-metal-dark)',
                    boxShadow: error
                      ? '0 0 0 4px color-mix(in srgb, var(--theme-accent) 18%, transparent), inset 0 2px 4px var(--theme-shadow)'
                      : focused
                        ? '0 0 0 4px color-mix(in srgb, var(--theme-metal-bright) 20%, transparent), inset 0 2px 4px var(--theme-shadow)'
                        : 'inset 0 2px 4px var(--theme-shadow)',
                  }}
                />

                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => setRevealed((v) => !v)}
                  aria-label={revealed ? 'Hide token' : 'Show token'}
                  className="absolute top-1/2 -translate-y-1/2 right-3 inline-flex items-center justify-center w-7 h-7 rounded-md transition-colors"
                  style={{
                    color: 'var(--theme-ink-soft)',
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.color = 'var(--theme-paper)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.color = 'var(--theme-ink-soft)';
                  }}
                >
                  {revealed ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>

              {/* Inline error — calm, color via accent */}
              {error && (
                <p
                  className="mt-2 text-xs"
                  style={{
                    color: 'var(--theme-accent)',
                    fontFamily: 'var(--theme-font-mono)',
                    letterSpacing: '0.02em',
                  }}
                  role="alert"
                >
                  {error}
                </p>
              )}
            </div>

            {/* Primary CTA */}
            <button
              type="submit"
              disabled={!canSubmit}
              className="w-full rounded-xl transition-all"
              style={{
                padding: '12px 16px',
                fontFamily: 'var(--theme-font-display)',
                fontWeight: 600,
                fontSize: '15px',
                letterSpacing: '0.04em',
                color: 'var(--theme-bolt)',
                background: canSubmit
                  ? 'linear-gradient(180deg, var(--theme-metal-bright) 0%, var(--theme-metal) 55%, var(--theme-metal-dark) 100%)'
                  : 'linear-gradient(180deg, color-mix(in srgb, var(--theme-metal) 40%, transparent), color-mix(in srgb, var(--theme-metal-dark) 40%, transparent))',
                border: '1px solid var(--theme-metal-dark)',
                boxShadow: canSubmit
                  ? '0 4px 14px var(--theme-shadow), inset 0 1px 0 color-mix(in srgb, var(--theme-metal-bright) 60%, transparent)'
                  : 'none',
                opacity: canSubmit ? 1 : 0.55,
                cursor: canSubmit ? 'pointer' : 'not-allowed',
              }}
              onMouseEnter={(e) => {
                if (!canSubmit) return;
                e.currentTarget.style.background =
                  'linear-gradient(180deg, var(--theme-metal-bright) 0%, var(--theme-metal-bright) 50%, var(--theme-metal) 100%)';
                e.currentTarget.style.boxShadow =
                  '0 8px 22px color-mix(in srgb, var(--theme-accent) 35%, transparent), 0 4px 14px var(--theme-shadow), inset 0 1px 0 var(--theme-paper)';
                e.currentTarget.style.transform = 'translateY(-1px)';
              }}
              onMouseLeave={(e) => {
                if (!canSubmit) return;
                e.currentTarget.style.background =
                  'linear-gradient(180deg, var(--theme-metal-bright) 0%, var(--theme-metal) 55%, var(--theme-metal-dark) 100%)';
                e.currentTarget.style.boxShadow =
                  '0 4px 14px var(--theme-shadow), inset 0 1px 0 color-mix(in srgb, var(--theme-metal-bright) 60%, transparent)';
                e.currentTarget.style.transform = 'translateY(0)';
              }}
            >
              {loading ? (
                <span className="inline-flex items-center justify-center gap-2">
                  <Loader2 size={16} className="animate-spin" />
                  Signing in
                </span>
              ) : (
                'Sign In'
              )}
            </button>
          </form>
        </div>

        {/* Attribution footer */}
        <p
          className="text-center mt-8 text-xs"
          style={{
            color: 'var(--theme-ink-soft)',
            fontFamily: 'var(--theme-font-mono)',
            opacity: 0.5,
            letterSpacing: '0.04em',
          }}
        >
          Built by Tony Elliott · github.com/Djtony707
        </p>
      </div>
    </div>
  );
}
