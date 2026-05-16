import { lazy, Suspense, useState, useEffect } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router';
import { trackEvent } from '@/api/telemetry';
import { ConfigProvider } from '@/hooks/useConfig';
import { AuthProvider, useAuth } from '@/hooks/useAuth';
import { ToastProvider } from '@/components/shared/Toast';
import { LoginPage } from '@/components/LoginPage';
import { SetupWizard } from '@/components/onboarding/SetupWizard';
import { FirstRunBanner } from '@/components/FirstRunBanner';
import { OpenAuthBanner } from '@/components/OpenAuthBanner';
import { apiFetch } from '@/api/client';
import { VoiceProvider, useVoice } from '@/context/VoiceContext';
import { SponsorFooter } from '@/components/SponsorFooter';

import { DeskSurface } from '@/components/desk/DeskSurface';
// v6.1.0-beta.2 Phase 0a — bridges the existing DeskTheme context to a
// `:root[data-theme=…]` attribute so CSS variables in
// `./styles/theme-variables.css` re-skin the UI on theme change.
import { useThemeVariables } from '@/hooks/useThemeVariables';
// v6.1.0-beta.2 Phase 0b — fixed top-right pill: Office/Workshop/Observatory.
import { TopbarThemePicker } from '@/components/TopbarThemePicker';

// ── Titan 3.0 Canvas ────────────────────────────────────────
const TitanCanvas = lazy(() => import('@/titan2/canvas/TitanCanvas'));
const CPLayout = lazy(() => import('@/components/command-post/CPLayout'));

// ── v6.1.0 Mission Chat ────────────────────────────────────
const MissionStart = lazy(() => import('@/pages/MissionStart'));
const MissionChat = lazy(() => import('@/pages/MissionChat'));
const MissionCanvas = lazy(() => import('@/pages/MissionCanvas'));
const MissionLibrary = lazy(() => import('@/pages/MissionLibrary'));

const VoiceOverlay = lazy(() =>
  import('@/components/voice/VoiceOverlay').then((m) => ({ default: m.VoiceOverlay })),
);

function LoadingFallback() {
  return (
    <div className="flex items-center justify-center h-full">
      <div className="text-sm font-serif" style={{ color: '#c4b49a' }}>Loading...</div>
    </div>
  );
}

/** Maps legacy routes to space IDs */
function legacyToSpace(path: string): string {
  const map: Record<string, string> = {
    '/soma': 'soma',
    '/command-post': 'command',
    '/intelligence': 'intelligence',
    '/infra': 'infra',
    '/tools': 'tools',
    '/settings': 'settings',
    '/dashboard': 'home',
    '/space': 'home',
    '/': 'home',
    '/watch': 'home',
    '/projects': 'home',
    '/issues': 'home',
    '/goals': 'home',
    '/approvals': 'home',
    '/activity': 'home',
  };
  // Check exact match first
  if (map[path]) return map[path];
  // Check prefix match for nested routes
  for (const [prefix, space] of Object.entries(map)) {
    if (path.startsWith(prefix + '/')) return space;
  }
  return 'home';
}

function AuthenticatedAppInner() {
  const { isOpen: voiceOpen, close: closeVoice } = useVoice();
  const [onboarded, setOnboarded] = useState<boolean | null>(null);

  useEffect(() => {
    apiFetch('/api/onboarding/status')
      .then(r => r.json())
      .then(d => setOnboarded(d.onboarded !== false))
      .catch(() => setOnboarded(true));
  }, []);

  if (onboarded === null) {
    return (
      <DeskSurface noMotes>
        <div className="flex items-center justify-center h-full">
          <div className="text-sm font-serif" style={{ color: '#c4b49a' }}>Loading...</div>
        </div>
      </DeskSurface>
    );
  }

  if (!onboarded) {
    return <SetupWizard onComplete={() => setOnboarded(true)} />;
  }

  return (
    <DeskSurface noMotes>
    <ToastProvider>
    <ConfigProvider>
      <RouteTracker />
      <Suspense fallback={<LoadingFallback />}>
        <Routes>
          {/* Titan 3.0: Canvas is the only view */}
          <Route path="/space/:spaceId" element={<TitanCanvas />} />

          {/* Legacy routes → redirect to spaces */}
          <Route path="/" element={<Navigate to="/space/home" replace />} />
          <Route path="/dashboard" element={<Navigate to="/space/home" replace />} />
          <Route path="/space" element={<Navigate to="/space/home" replace />} />
          <Route path="/soma" element={<Navigate to="/space/soma" replace />} />
          <Route path="/intelligence" element={<Navigate to="/space/intelligence" replace />} />
          <Route path="/infra" element={<Navigate to="/space/infra" replace />} />
          <Route path="/tools" element={<Navigate to="/space/tools" replace />} />
          <Route path="/settings" element={<Navigate to="/space/settings" replace />} />
          <Route path="/watch" element={<Navigate to="/space/home" replace />} />
          <Route path="/projects" element={<Navigate to="/space/home" replace />} />
          <Route path="/issues" element={<Navigate to="/space/home" replace />} />
          <Route path="/goals" element={<Navigate to="/space/home" replace />} />
          <Route path="/approvals" element={<Navigate to="/space/home" replace />} />
          <Route path="/activity" element={<Navigate to="/space/home" replace />} />

          {/* Command Post — routed page and canvas widget */}
          <Route path="/command-post/*" element={<CPLayout />} />

          {/* v6.1.0 Mission Chat — opt-in chat-style team control */}
          <Route path="/mission" element={<MissionStart />} />
          {/* v6.1.0-alpha.13 — sessions browser */}
          <Route path="/mission/library" element={<MissionLibrary />} />
          <Route path="/mission/:id" element={<MissionChat />} />
          {/* v6.1.0-alpha.8 Mission Canvas — spatial team view (same data, different layout) */}
          <Route path="/mission/:id/canvas" element={<MissionCanvas />} />

          {/* Catch-all */}
          <Route path="*" element={<Navigate to="/space/home" replace />} />
        </Routes>
      </Suspense>

      <OpenAuthBanner />
      <FirstRunBanner />

      {/* Voice overlay */}
      {voiceOpen && (
        <Suspense fallback={null}>
          <VoiceOverlay onClose={closeVoice} />
        </Suspense>
      )}

      {/*
        v6.1.0-alpha.22 — Global sponsor mount.
        Fixed at the bottom-center of the viewport with the highest
        possible z-index so nothing (sidebars, modal backdrops,
        canvas overlays, the voice overlay) can sit in front of it.
        `pointer-events-none` on the wrapper so background clicks
        still pass through; the link itself re-enables pointer events.

        Tony's brief: "Put it center on the bottom of the screen so
        nothing can be in front of it." All the previous in-page /
        in-sidebar placements were removed — this is now the single
        source of truth for the sponsor link in TITAN.
      */}
      <div
        className="fixed bottom-1.5 left-0 right-0 flex justify-center pointer-events-none"
        style={{ zIndex: 2147483647 }}
      >
        <div className="pointer-events-auto px-3 py-1 rounded-full bg-black/55 backdrop-blur-md shadow-lg">
          <SponsorFooter />
        </div>
      </div>
    </ConfigProvider>
    </ToastProvider>
    </DeskSurface>
  );
}

function AuthenticatedApp() {
  return (
    <VoiceProvider>
      <AuthenticatedAppInner />
    </VoiceProvider>
  );
}

function RouteTracker() {
  const location = useLocation();
  useEffect(() => {
    const path = location.pathname;
    trackEvent('feature_opened', { feature: path });
  }, [location.pathname]);
  return null;
}

function AuthGate() {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <DeskSurface noMotes>
        <div className="flex items-center justify-center h-full">
          <div className="text-sm font-serif" style={{ color: '#c4b49a' }}>Loading...</div>
        </div>
      </DeskSurface>
    );
  }

  if (!isAuthenticated) {
    return <LoginPage />;
  }

  return <AuthenticatedApp />;
}

export default function App() {
  // Phase 0a — sync `<html data-theme=…>` to the active DeskTheme so the
  // CSS-variable palettes in `./styles/theme-variables.css` take effect.
  // Pure side-effect; no rendered output.
  useThemeVariables();
  return (
    <AuthProvider>
      <AuthGate />
      {/* Phase 0b — fixed-position theme picker visible on every page
          (sits outside the per-page chrome so adopting it doesn't
          require touching MissionCanvas / MissionChat / etc.). */}
      <TopbarThemePicker />
    </AuthProvider>
  );
}
