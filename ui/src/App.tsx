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

// ── Titan 3.0 Canvas ────────────────────────────────────────
const TitanCanvas = lazy(() => import('@/titan2/canvas/TitanCanvas'));
const CPLayout = lazy(() => import('@/components/command-post/CPLayout'));

const VoiceOverlay = lazy(() =>
  import('@/components/voice/VoiceOverlay').then((m) => ({ default: m.VoiceOverlay })),
);

function LoadingFallback() {
  return (
    <div className="flex items-center justify-center h-full">
      <div className="text-text-muted text-sm">Loading...</div>
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
      <div className="flex items-center justify-center h-screen bg-bg">
        <div className="text-text-muted text-sm">Loading...</div>
      </div>
    );
  }

  if (!onboarded) {
    return <SetupWizard onComplete={() => setOnboarded(true)} />;
  }

  return (
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
    </ConfigProvider>
    </ToastProvider>
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
      <div className="flex items-center justify-center h-screen bg-bg">
        <div className="text-text-muted text-sm">Loading...</div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <LoginPage />;
  }

  return <AuthenticatedApp />;
}

export default function App() {
  return (
    <AuthProvider>
      <AuthGate />
    </AuthProvider>
  );
}
