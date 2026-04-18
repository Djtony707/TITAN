import { lazy, Suspense, useState, useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router';
import { ConfigProvider } from '@/hooks/useConfig';
import { AuthProvider, useAuth } from '@/hooks/useAuth';
import { ToastProvider } from '@/components/shared/Toast';
import { LoginPage } from '@/components/LoginPage';
import { SetupWizard } from '@/components/onboarding/SetupWizard';
import { FirstRunBanner } from '@/components/FirstRunBanner';
import { apiFetch } from '@/api/client';
import AppShell from '@/components/shell/AppShell';

// ── Lazy-loaded views ───────────────────────────────────────
const MissionView = lazy(() => import('@/components/mission/MissionView'));
const CommandPostHub = lazy(() => import('@/components/admin/CommandPostHub'));
const IntelligenceView = lazy(() => import('@/components/intelligence/IntelligenceView'));
const ToolsView = lazy(() => import('@/components/tools/ToolsView'));
const InfraView = lazy(() => import('@/components/infra/InfraView'));
const SettingsView = lazy(() => import('@/components/settings/SettingsView'));
const SomaView = lazy(() => import('@/views/SomaView'));
const WatchView = lazy(() => import('@/views/WatchView'));

const VoiceOverlay = lazy(() =>
  import('@/components/voice/VoiceOverlay').then((m) => ({ default: m.VoiceOverlay })),
);

// ── Legacy panel imports for backward-compat redirects ──────
// These lazy imports support old bookmarks/links to individual panels
const OverviewPanel = lazy(() => import('@/components/admin/OverviewPanel'));
const ActivityPanel = lazy(() => import('@/components/admin/ActivityPanel'));
const AgentsPanel = lazy(() => import('@/components/admin/AgentsPanel'));
const SessionsPanel = lazy(() => import('@/components/admin/SessionsPanel'));
const SettingsPanel = lazy(() => import('@/components/admin/SettingsPanel'));
const ChannelsPanel = lazy(() => import('@/components/admin/ChannelsPanel'));
const SkillsPanel = lazy(() => import('@/components/admin/SkillsPanel'));
const TelemetryPanel = lazy(() => import('@/components/admin/TelemetryPanel'));
const LogsPanel = lazy(() => import('@/components/admin/LogsPanel'));
const MeshPanel = lazy(() => import('@/components/admin/MeshPanel'));
const LearningPanel = lazy(() => import('@/components/admin/LearningPanel'));
const AutopilotPanel = lazy(() => import('@/components/admin/AutopilotPanel'));
const SelfProposalsPanel = lazy(() => import('@/components/admin/SelfProposalsPanel'));
const SecurityPanel = lazy(() => import('@/components/admin/SecurityPanel'));
const WorkflowsPanel = lazy(() => import('@/components/admin/WorkflowsPanel'));
const MemoryGraphPanel = lazy(() => import('@/components/admin/MemoryGraphPanel'));
const PersonasPanel = lazy(() => import('@/components/admin/PersonasPanel'));
const IntegrationsPanel = lazy(() => import('@/components/admin/IntegrationsPanel'));
const SelfImprovePanel = lazy(() => import('@/components/admin/SelfImprovePanel'));
const AutoresearchPanel = lazy(() => import('@/components/admin/AutoresearchPanel'));
const McpPanel = lazy(() => import('@/components/admin/McpPanel'));
const DaemonPanel = lazy(() => import('@/components/admin/DaemonPanel'));
const AuditPanel = lazy(() => import('@/components/admin/AuditPanel'));
const FilesPanel = lazy(() => import('@/components/admin/FilesPanel'));
const NvidiaPanel = lazy(() => import('@/components/admin/NvidiaPanel'));
const HomelabPanel = lazy(() => import('@/components/admin/HomelabPanel'));
const MemoryWikiPanel = lazy(() => import('@/components/admin/MemoryWikiPanel'));

function LoadingFallback() {
  return (
    <div className="flex items-center justify-center h-full">
      <div className="text-text-muted text-sm">Loading...</div>
    </div>
  );
}

/** Wrapper that adds padding for legacy admin panels */
function AdminPage({ children }: { children: React.ReactNode }) {
  return <div className="p-3 md:p-6 h-full overflow-auto">{children}</div>;
}

function AuthenticatedApp() {
  const [voiceOpen, setVoiceOpen] = useState(false);
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
      <Suspense fallback={<LoadingFallback />}>
        <Routes>
          {/* New shell layout with icon rail + status bar */}
          <Route element={<AppShell />}>
            {/* ── Primary views (6 panels) ─────────────────── */}
            <Route index element={<MissionView onVoiceOpen={() => setVoiceOpen(true)} />} />
            <Route path="/command-post" element={<AdminPage><CommandPostHub /></AdminPage>} />
            <Route path="/intelligence" element={<IntelligenceView />} />
            <Route path="/tools" element={<ToolsView />} />
            <Route path="/infra" element={<InfraView />} />
            <Route path="/settings" element={<SettingsView />} />
            <Route path="/soma" element={<SomaView />} />
            <Route path="/watch" element={<WatchView />} />

            {/* ── Legacy routes (redirect to new views) ────── */}
            <Route path="/chat" element={<Navigate to="/" replace />} />
            <Route path="/overview" element={<Navigate to="/" replace />} />

            {/* ── Legacy admin panel routes (backward compat) ── */}
            {/* These still work but are also accessible via consolidated views */}
            <Route path="/activity" element={<AdminPage><ActivityPanel /></AdminPage>} />
            <Route path="/agents" element={<AdminPage><AgentsPanel /></AdminPage>} />
            <Route path="/sessions" element={<AdminPage><SessionsPanel /></AdminPage>} />
            <Route path="/channels" element={<AdminPage><ChannelsPanel /></AdminPage>} />
            <Route path="/skills" element={<AdminPage><SkillsPanel /></AdminPage>} />
            <Route path="/telemetry" element={<AdminPage><TelemetryPanel /></AdminPage>} />
            <Route path="/logs" element={<AdminPage><LogsPanel /></AdminPage>} />
            <Route path="/mesh" element={<AdminPage><MeshPanel /></AdminPage>} />
            <Route path="/learning" element={<AdminPage><LearningPanel /></AdminPage>} />
            <Route path="/autopilot" element={<AdminPage><AutopilotPanel /></AdminPage>} />
            <Route path="/self-proposals" element={<AdminPage><SelfProposalsPanel /></AdminPage>} />
            <Route path="/security" element={<AdminPage><SecurityPanel /></AdminPage>} />
            <Route path="/workflows" element={<AdminPage><WorkflowsPanel /></AdminPage>} />
            <Route path="/memory-graph" element={<AdminPage><MemoryGraphPanel /></AdminPage>} />
            <Route path="/personas" element={<AdminPage><PersonasPanel /></AdminPage>} />
            <Route path="/integrations" element={<AdminPage><IntegrationsPanel /></AdminPage>} />
            <Route path="/self-improve" element={<AdminPage><SelfImprovePanel /></AdminPage>} />
            <Route path="/autoresearch" element={<AdminPage><AutoresearchPanel /></AdminPage>} />
            <Route path="/mcp" element={<AdminPage><McpPanel /></AdminPage>} />
            <Route path="/daemon" element={<AdminPage><DaemonPanel /></AdminPage>} />
            <Route path="/audit" element={<AdminPage><AuditPanel /></AdminPage>} />
            <Route path="/files" element={<AdminPage><FilesPanel /></AdminPage>} />
            <Route path="/nvidia" element={<AdminPage><NvidiaPanel /></AdminPage>} />
            <Route path="/homelab" element={<AdminPage><HomelabPanel /></AdminPage>} />
            <Route path="/memory-wiki" element={<AdminPage><MemoryWikiPanel /></AdminPage>} />
          </Route>
        </Routes>
      </Suspense>

      <FirstRunBanner />

      {/* Voice overlay — rendered outside shell so it covers everything */}
      {voiceOpen && (
        <Suspense fallback={null}>
          <VoiceOverlay onClose={() => setVoiceOpen(false)} />
        </Suspense>
      )}
    </ConfigProvider>
    </ToastProvider>
  );
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
