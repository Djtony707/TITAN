import { lazy, Suspense, useState, useEffect, type ReactNode } from 'react';
import { Routes, Route, Navigate, useLocation, Link } from 'react-router';
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
import { StarOnGitHubFooter } from '@/components/StarOnGitHubFooter';

import { DeskSurface } from '@/components/desk/DeskSurface';
import { TitanShell } from '@/components/shell/TitanShell';
// v6.1.0-beta.2 Phase 0a — bridges the existing DeskTheme context to a
// `:root[data-theme=…]` attribute so CSS variables in
// `./styles/theme-variables.css` re-skin the UI on theme change.
import { useThemeVariables } from '@/hooks/useThemeVariables';
// v6.1.0-beta.2 Phase 0b — fixed top-right pill: Office/Workshop/Observatory.
import { TopbarThemePicker } from '@/components/TopbarThemePicker';

// ── Titan 3.0 Canvas ────────────────────────────────────────
const TitanCanvas = lazy(() => import('@/titan2/canvas/TitanCanvas'));
const CPLayout = lazy(() => import('@/components/command-post/CPLayout'));
const CPDashboard = lazy(() => import('@/components/command-post/CPDashboard'));
const CPIssues = lazy(() => import('@/components/command-post/CPIssues'));
const CPApprovals = lazy(() => import('@/components/command-post/CPApprovals'));
const CPActivity = lazy(() => import('@/components/command-post/CPActivity'));
const CPGoals = lazy(() => import('@/components/command-post/CPGoals'));
const CPRuns = lazy(() => import('@/components/command-post/CPRuns'));
const CPAgents = lazy(() => import('@/components/command-post/CPAgents'));
const CPOrg = lazy(() => import('@/components/command-post/CPOrg'));
const CPFiles = lazy(() => import('@/components/command-post/CPFiles'));
const CPVoice = lazy(() => import('@/components/command-post/CPVoice'));
const CPCosts = lazy(() => import('@/components/command-post/CPCosts'));

// ── Canonical shell section pages ────────────────────────────
const PersonasPanel = lazy(() => import('@/components/admin/PersonasPanel'));
const MemoryGraphPanel = lazy(() => import('@/components/admin/MemoryGraphPanel'));
const MemoryWikiPanel = lazy(() => import('@/components/admin/MemoryWikiPanel'));
const MemoryTaxonomyPanel = lazy(() => import('@/components/admin/MemoryTaxonomyPanel'));
const AutoresearchPanel = lazy(() => import('@/components/admin/AutoresearchPanel'));
const SelfImprovePanel = lazy(() => import('@/components/admin/SelfImprovePanel'));
const DreamPanel = lazy(() => import('@/components/admin/DreamPanel'));
const TrainingPanel = lazy(() => import('@/components/admin/TrainingPanel'));
const EvalHarnessPanel = lazy(() => import('@/components/admin/EvalHarnessPanel'));
const TracesPanel = lazy(() => import('@/components/admin/TracesPanel'));
const WorkflowBuilderPanel = lazy(() => import('@/components/admin/WorkflowBuilderPanel'));
const LiveStudio = lazy(() => import('@/views/LiveStudio'));
const SkillsPanel = lazy(() => import('@/components/admin/SkillsPanel'));
const McpPanel = lazy(() => import('@/components/admin/McpPanel'));
const IntegrationsPanel = lazy(() => import('@/components/admin/IntegrationsPanel'));
const ChannelsPanel = lazy(() => import('@/components/admin/ChannelsPanel'));
const MeshPanel = lazy(() => import('@/components/admin/MeshPanel'));
const BrowserPanel = lazy(() => import('@/components/admin/BrowserPanel'));
const RecipesPanel = lazy(() => import('@/components/admin/RecipesPanel'));
const SettingsPanel = lazy(() => import('@/components/admin/SettingsPanel'));
const SecurityPanel = lazy(() => import('@/components/admin/SecurityPanel'));
const AuditPanel = lazy(() => import('@/components/admin/AuditPanel'));
const BackupPanel = lazy(() => import('@/components/admin/BackupPanel'));
const LogsPanel = lazy(() => import('@/components/admin/LogsPanel'));
const HomelabPanel = lazy(() => import('@/components/admin/HomelabPanel'));
const NvidiaPanel = lazy(() => import('@/components/admin/NvidiaPanel'));
const VramPanel = lazy(() => import('@/components/admin/VramPanel'));
const FleetPanel = lazy(() => import('@/components/admin/FleetPanel'));
const CronPanel = lazy(() => import('@/components/admin/CronPanel'));
const EvalPanel = lazy(() => import('@/components/admin/EvalPanel'));
const PhoneDeskPanel = lazy(() => import('@/components/admin/PhoneDeskPanel'));

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

// beta.22 — `legacyToSpace()` removed. It mapped old top-level routes
// (/soma, /command-post, /intelligence, /infra, /tools, /settings, /dashboard,
// /watch, /projects, /issues, /goals, /approvals, /activity) to canvas space
// IDs, but was never called — the JSX <Route> entries below already do the
// redirects directly. Codex flagged it as dead code that signalled
// unfinished route consolidation. The proper consolidation lands in beta.23
// (one canonical 6-section sidebar) and beta.24 (collapse the dead-end
// redirects into real Command Post destinations).

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
      <TitanShell>
        <Suspense fallback={<LoadingFallback />}>
          <Routes>
            {/* Canonical 6-section shell */}
            <Route path="/" element={<MissionStart />} />
            <Route path="/dashboard" element={<Navigate to="/missions" replace />} />

            <Route path="/missions" element={<MissionStart />} />
            <Route path="/missions/library" element={<MissionLibrary />} />
            <Route path="/missions/goals" element={<CommandPostRoute title="Goals"><CPGoals /></CommandPostRoute>} />
            <Route path="/missions/workflow-builder" element={<WorkflowBuilderPanel />} />
            <Route path="/studio" element={<LiveStudio />} />
            <Route path="/studio/:sessionId" element={<LiveStudio />} />
            <Route path="/missions/issues" element={<CommandPostRoute title="Issues"><CPIssues /></CommandPostRoute>} />
            <Route path="/missions/approvals" element={<CommandPostRoute title="Approvals"><CPApprovals /></CommandPostRoute>} />
            <Route path="/missions/activity" element={<CommandPostRoute title="Activity"><CPActivity /></CommandPostRoute>} />
            <Route path="/missions/work" element={<CommandPostRoute title="Work"><CPRuns /></CommandPostRoute>} />

            <Route path="/team" element={<Navigate to="/team/agents" replace />} />
            <Route path="/team/agents" element={<CommandPostRoute title="Agents"><CPAgents /></CommandPostRoute>} />
            <Route path="/team/org-chart" element={<CommandPostRoute title="Org Chart"><CPOrg /></CommandPostRoute>} />
            <Route path="/team/personas" element={<PersonasPanel />} />

            <Route path="/knowledge" element={<MemoryGraphPanel />} />
            <Route path="/knowledge/memory-graph" element={<MemoryGraphPanel />} />
            <Route path="/knowledge/wiki" element={<MemoryWikiPanel />} />
            <Route path="/knowledge/memory-taxonomy" element={<MemoryTaxonomyPanel />} />
            <Route path="/knowledge/autoresearch" element={<AutoresearchPanel />} />
            <Route path="/knowledge/self-improve" element={<SelfImprovePanel />} />
            <Route path="/knowledge/dreams" element={<DreamPanel />} />
            <Route path="/knowledge/training" element={<TrainingPanel />} />

            {/* v6.4.1 — kill ToolsView (double PageHeader render). Sidebar already exposes each tool sub-route directly. */}
            <Route path="/tools" element={<Navigate to="/tools/skills" replace />} />
            <Route path="/tools/skills" element={<SkillsPanel />} />
            <Route path="/tools/evals" element={<EvalHarnessPanel />} />
            <Route path="/tools/observability" element={<TracesPanel />} />
            <Route path="/tools/mcp" element={<McpPanel />} />
            <Route path="/tools/integrations" element={<IntegrationsPanel />} />
            <Route path="/tools/channels" element={<ChannelsPanel />} />
            <Route path="/tools/mesh" element={<MeshPanel />} />
            <Route path="/tools/browser" element={<BrowserPanel />} />
            <Route path="/tools/recipes" element={<RecipesPanel />} />
            <Route path="/tools/files" element={<CPFiles />} />
            <Route path="/tools/voice" element={<CPVoice />} />
            <Route path="/tools/phone-desk" element={<PhoneDeskPanel />} />

            <Route path="/system" element={<SettingsPanel />} />
            <Route path="/system/settings" element={<SettingsPanel />} />
            <Route path="/system/security" element={<SecurityPanel />} />
            <Route path="/system/costs" element={<CommandPostRoute title="Costs"><CPCosts /></CommandPostRoute>} />
            <Route path="/system/audit" element={<AuditPanel />} />
            <Route path="/system/backup-recovery" element={<BackupPanel />} />
            <Route path="/system/logs" element={<LogsPanel />} />
            <Route path="/system/homelab" element={<HomelabPanel />} />
            <Route path="/system/gpu" element={<NvidiaPanel />} />
            <Route path="/system/vram" element={<VramPanel />} />
            <Route path="/system/fleet" element={<FleetPanel />} />
            <Route path="/system/cron" element={<CronPanel />} />
            <Route path="/system/quality-lab" element={<EvalPanel />} />

            {/* Legacy routes → canonical sections */}
            <Route path="/soma" element={<Navigate to="/knowledge" replace />} />
            <Route path="/intelligence" element={<Navigate to="/knowledge" replace />} />
            <Route path="/infra" element={<Navigate to="/system" replace />} />
            <Route path="/settings" element={<Navigate to="/system/settings" replace />} />
            <Route path="/watch" element={<Navigate to="/missions/activity" replace />} />
            <Route path="/projects" element={<Navigate to="/missions/work" replace />} />
            <Route path="/issues" element={<Navigate to="/missions/issues" replace />} />
            <Route path="/goals" element={<Navigate to="/missions/goals" replace />} />
            <Route path="/approvals" element={<Navigate to="/missions/approvals" replace />} />
            <Route path="/activity" element={<Navigate to="/missions/activity" replace />} />

            {/* Command Post keeps working inside the canonical shell */}
            <Route path="/command-post/*" element={<CommandPostRoute title="Command Post"><CPLayout /></CommandPostRoute>} />

            {/* Mission flow routes keep their legacy singular paths */}
            <Route path="/mission" element={<MissionStart />} />
            <Route path="/mission/library" element={<MissionLibrary />} />
            <Route path="/mission/:id" element={<MissionChat />} />
            <Route path="/mission/:id/canvas" element={<MissionCanvas />} />

            {/* Canvas workspaces remain opt-in */}
            <Route path="/space" element={<Navigate to="/space/home" replace />} />
            <Route path="/space/:spaceId" element={<TitanCanvas />} />

            {/* Catch-all */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </TitanShell>

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
        nothing can be in front of it." On phone-width screens the pill is
        hidden so it does not cover lists, drawers, or bottom action chrome.
        This remains the single desktop/tablet placement for support links.
      */}
      <div
        className="fixed bottom-1.5 left-0 right-0 hidden justify-center pointer-events-none sm:flex"
        style={{ zIndex: 2147483647 }}
      >
        {/* v6.3.3 — Sponsor + Star share a single bottom-center pill so
            users see both support options on every page without doubling
            up the floating chrome. Thin vertical separator distinguishes
            them; both open in new tabs so the user never loses context. */}
        <div className="pointer-events-auto px-3 py-1 rounded-full bg-black/55 backdrop-blur-md shadow-lg inline-flex items-center gap-3">
          <SponsorFooter />
          <span aria-hidden className="h-3 w-px bg-white/20" />
          <StarOnGitHubFooter />
        </div>
      </div>
    </ConfigProvider>
    </ToastProvider>
    </DeskSurface>
  );
}

function CommandPostRoute({ children, title }: { children: ReactNode; title: string }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/config')
      .then((r) => r.json())
      .then((cfg) => {
        if (!cancelled) setEnabled(Boolean(cfg.commandPost?.enabled));
      })
      .catch(() => {
        if (!cancelled) setEnabled(false);
      });
    return () => { cancelled = true; };
  }, []);

  if (enabled === null) {
    return <LoadingFallback />;
  }

  if (!enabled) {
    return (
      <div className="flex min-h-full items-center justify-center px-6 py-16">
        <div className="max-w-md rounded-md border border-border bg-bg-secondary/80 p-6 text-center shadow-lg">
          <div className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-text-muted">
            Command Post is off
          </div>
          <h1 className="mb-3 text-2xl font-semibold text-text">{title} is not active yet</h1>
          <p className="mb-5 text-sm leading-relaxed text-text-secondary">
            This view uses Command Post governance. Enable Command Post when you want managed agents,
            approval queues, activity tracking, and budget controls.
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            <Link
              to="/missions"
              className="rounded-md border border-border bg-bg-tertiary px-4 py-2 text-sm font-medium text-text hover:border-border-light"
            >
              Start a mission
            </Link>
            <Link
              to="/system/settings"
              className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover"
            >
              Open settings
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return <>{children}</>;
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
