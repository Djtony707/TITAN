import { lazy, Suspense, useState, useEffect } from 'react';
import { Routes, Route } from 'react-router';
import { Layout } from '@/components/layout/Layout';
import { ConfigProvider } from '@/hooks/useConfig';
import { AuthProvider, useAuth } from '@/hooks/useAuth';
import { LoginPage } from '@/components/LoginPage';
import { SetupWizard } from '@/components/onboarding/SetupWizard';
import { apiFetch } from '@/api/client';

const ChatView = lazy(() => import('@/components/chat/ChatView'));
const ActivityPanel = lazy(() => import('@/components/admin/ActivityPanel'));
const OverviewPanel = lazy(() => import('@/components/admin/OverviewPanel'));
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
const CommandPostPanel = lazy(() => import('@/components/admin/CommandPostPanel'));
const CommandPostHub = lazy(() => import('@/components/admin/CommandPostHub'));
const VoiceOverlay = lazy(() =>
  import('@/components/voice/VoiceOverlay').then((m) => ({ default: m.VoiceOverlay })),
);

function LoadingFallback() {
  return (
    <div className="flex items-center justify-center h-full">
      <div className="text-[var(--text-secondary)] text-sm">Loading...</div>
    </div>
  );
}

/** Wrapper that adds padding for admin panels (ChatView manages its own layout) */
function AdminPage({ children }: { children: React.ReactNode }) {
  return <div className="p-6 h-full overflow-auto">{children}</div>;
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
      <div className="flex items-center justify-center h-screen bg-[#09090b]">
        <div className="text-[#71717a] text-sm">Loading...</div>
      </div>
    );
  }

  if (!onboarded) {
    return <SetupWizard onComplete={() => setOnboarded(true)} />;
  }

  return (
    <ConfigProvider>
      <Layout>
        <Suspense fallback={<LoadingFallback />}>
          <Routes>
            <Route path="/" element={<ChatView onVoiceOpen={() => setVoiceOpen(true)} />} />
            <Route path="/activity" element={<AdminPage><ActivityPanel /></AdminPage>} />
            <Route path="/overview" element={<AdminPage><OverviewPanel /></AdminPage>} />
            <Route path="/agents" element={<AdminPage><AgentsPanel /></AdminPage>} />
            <Route path="/sessions" element={<AdminPage><SessionsPanel /></AdminPage>} />
            <Route path="/settings" element={<AdminPage><SettingsPanel /></AdminPage>} />
            <Route path="/channels" element={<AdminPage><ChannelsPanel /></AdminPage>} />
            <Route path="/skills" element={<AdminPage><SkillsPanel /></AdminPage>} />
            <Route path="/telemetry" element={<AdminPage><TelemetryPanel /></AdminPage>} />
            <Route path="/logs" element={<AdminPage><LogsPanel /></AdminPage>} />
            <Route path="/mesh" element={<AdminPage><MeshPanel /></AdminPage>} />
            <Route path="/learning" element={<AdminPage><LearningPanel /></AdminPage>} />
            <Route path="/autopilot" element={<AdminPage><AutopilotPanel /></AdminPage>} />
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
            <Route path="/command-post" element={<AdminPage><CommandPostPanel /></AdminPage>} />
            <Route path="/paperclip" element={<AdminPage><CommandPostHub /></AdminPage>} />
          </Routes>
        </Suspense>
      </Layout>

      {/* Voice overlay — rendered outside Layout so it covers everything */}
      {voiceOpen && (
        <Suspense fallback={null}>
          <VoiceOverlay onClose={() => setVoiceOpen(false)} />
        </Suspense>
      )}
    </ConfigProvider>
  );
}

function AuthGate() {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen bg-[#09090b]">
        <div className="text-[#71717a] text-sm">Loading...</div>
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
