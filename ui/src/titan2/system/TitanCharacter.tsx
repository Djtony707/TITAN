/**
 * TITAN Character Avatar
 * Animated SVG robot entity for chat and on-screen presence.
 * States: idle | thinking | executing | error
 */

import React from 'react';

type TitanState = 'idle' | 'thinking' | 'executing' | 'error';

interface Props {
  state?: TitanState;
  size?: number;
  className?: string;
}

export function TitanCharacter({ state = 'idle', size = 28, className = '' }: Props) {
  const isThinking = state === 'thinking';
  const isExecuting = state === 'executing';
  const isError = state === 'error';
  const isIdle = state === 'idle';

  const eyeColor = isError ? '#ef4444' : isExecuting ? '#34d399' : '#6366f1';
  const glowColor = isError ? '#ef4444' : isExecuting ? '#34d399' : '#818cf8';
  const ringColor = isError ? '#ef4444' : isExecuting ? '#34d399' : '#6366f1';

  return (
    <div
      className={`relative inline-flex items-center justify-center ${className}`}
      style={{ width: size, height: size }}
    >
      <style>{`
        @keyframes titan-float {
          0%, 100% { transform: translateY(0px); }
          50% { transform: translateY(-2px); }
        }
        @keyframes titan-pulse {
          0%, 100% { opacity: 0.6; transform: scale(1); }
          50% { opacity: 1; transform: scale(1.08); }
        }
        @keyframes titan-scan {
          0% { transform: translateX(-3px); }
          50% { transform: translateX(3px); }
          100% { transform: translateX(-3px); }
        }
        @keyframes titan-ring-spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        @keyframes titan-ring-pulse {
          0%, 100% { opacity: 0.3; stroke-width: 1; }
          50% { opacity: 0.7; stroke-width: 1.5; }
        }
        @keyframes titan-error-shake {
          0%, 100% { transform: translateX(0); }
          25% { transform: translateX(-1px); }
          75% { transform: translateX(1px); }
        }
        .titan-avatar {
          animation: titan-float 3s ease-in-out infinite;
        }
        .titan-avatar.thinking {
          animation: titan-float 2s ease-in-out infinite;
        }
        .titan-avatar.executing {
          animation: titan-pulse 0.8s ease-in-out infinite;
        }
        .titan-avatar.error {
          animation: titan-error-shake 0.4s ease-in-out infinite;
        }
        .titan-eye {
          transition: fill 0.3s ease;
        }
        .titan-eye.thinking {
          animation: titan-scan 1.2s ease-in-out infinite;
        }
        .titan-ring {
          transform-origin: center;
          transition: stroke 0.3s ease;
        }
        .titan-ring.spinning {
          animation: titan-ring-spin 3s linear infinite;
        }
        .titan-ring.pulsing {
          animation: titan-ring-pulse 1.5s ease-in-out infinite;
        }
        .titan-glow {
          transition: stop-color 0.3s ease;
        }
      `}</style>

      <svg
        viewBox="0 0 32 32"
        width={size}
        height={size}
        className={`titan-avatar ${state}`}
      >
        <defs>
          <radialGradient id={`titan-glow-${state}`} cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor={glowColor} stopOpacity={isExecuting ? 0.5 : 0.25} />
            <stop offset="100%" stopColor={glowColor} stopOpacity={0} />
          </radialGradient>
          <linearGradient id={`titan-body-${state}`} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor={isError ? '#3f1818' : '#1e1b4b'} />
            <stop offset="50%" stopColor={isError ? '#2a1212' : '#0f0a1a'} />
            <stop offset="100%" stopColor={isError ? '#1a0a0a' : '#0a0614'} />
          </linearGradient>
          <filter id={`titan-shadow-${state}`}>
            <feDropShadow dx="0" dy="0.5" stdDeviation="1" floodColor={ringColor} floodOpacity={isExecuting ? 0.4 : 0.15} />
          </filter>
        </defs>

        {/* Outer glow ring */}
        <circle
          cx="16"
          cy="16"
          r="15"
          fill={`url(#titan-glow-${state})`}
          className={`titan-ring ${isExecuting ? 'pulsing' : ''}`}
        />

        {/* Orbital ring */}
        <ellipse
          cx="16"
          cy="16"
          rx="14"
          ry="5"
          fill="none"
          stroke={ringColor}
          strokeWidth="0.6"
          strokeOpacity={isIdle ? 0.2 : 0.4}
          className={`titan-ring ${isThinking ? 'spinning' : ''}`}
          style={{ transformOrigin: 'center' }}
        />

        {/* Main body — hexagonal orb */}
        <path
          d="M16 4 L25.5 9.5 L25.5 22.5 L16 28 L6.5 22.5 L6.5 9.5 Z"
          fill={`url(#titan-body-${state})`}
          stroke={ringColor}
          strokeWidth="0.8"
          strokeOpacity={0.5}
          filter={`url(#titan-shadow-${state})`}
        />

        {/* Inner hex detail */}
        <path
          d="M16 8 L21.5 11.5 L21.5 20.5 L16 24 L10.5 20.5 L10.5 11.5 Z"
          fill="none"
          stroke={ringColor}
          strokeWidth="0.4"
          strokeOpacity={0.25}
        />

        {/* Eye / face */}
        <g className={`titan-eye ${state}`}>
          {/* Eye socket */}
          <ellipse cx="16" cy="15" rx="5" ry="3.5" fill="#0a0a0f" stroke={ringColor} strokeWidth="0.5" strokeOpacity={0.4} />
          {/* Eye core */}
          <ellipse cx="16" cy="15" rx="3" ry="2" fill={eyeColor} opacity={isThinking ? 0.9 : 1}>
            {isExecuting && (
              <animate attributeName="rx" values="3;3.5;3" dur="0.8s" repeatCount="indefinite" />
            )}
          </ellipse>
          {/* Eye highlight */}
          <circle cx="15" cy="14" r="0.8" fill="#ffffff" opacity="0.6" />
        </g>

        {/* Bottom chin vent */}
        <rect x="13" y="23" width="6" height="1.2" rx="0.3" fill={ringColor} opacity={0.3} />
        <rect x="14" y="23.3" width="4" height="0.6" rx="0.15" fill={glowColor} opacity={isExecuting ? 0.8 : 0.4}>
          {isExecuting && (
            <animate attributeName="opacity" values="0.4;0.9;0.4" dur="0.6s" repeatCount="indefinite" />
          )}
        </rect>

        {/* Side antenna dots (thinking indicator) */}
        {(isThinking || isExecuting) && (
          <>
            <circle cx="5" cy="12" r="0.6" fill={glowColor} opacity="0.6">
              <animate attributeName="opacity" values="0.3;0.8;0.3" dur="1s" begin="0s" repeatCount="indefinite" />
            </circle>
            <circle cx="27" cy="12" r="0.6" fill={glowColor} opacity="0.6">
              <animate attributeName="opacity" values="0.3;0.8;0.3" dur="1s" begin="0.33s" repeatCount="indefinite" />
            </circle>
            <circle cx="5" cy="20" r="0.6" fill={glowColor} opacity="0.6">
              <animate attributeName="opacity" values="0.3;0.8;0.3" dur="1s" begin="0.66s" repeatCount="indefinite" />
            </circle>
            <circle cx="27" cy="20" r="0.6" fill={glowColor} opacity="0.6">
              <animate attributeName="opacity" values="0.3;0.8;0.3" dur="1s" begin="0.5s" repeatCount="indefinite" />
            </circle>
          </>
        )}

        {/* Error X mark */}
        {isError && (
          <>
            <line x1="12" y1="12" x2="20" y2="20" stroke="#ef4444" strokeWidth="1.2" strokeLinecap="round" opacity="0.8" />
            <line x1="20" y1="12" x2="12" y2="20" stroke="#ef4444" strokeWidth="1.2" strokeLinecap="round" opacity="0.8" />
          </>
        )}
      </svg>
    </div>
  );
}
