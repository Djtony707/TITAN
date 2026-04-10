import { lazy, Suspense } from 'react';
import PanelTabContainer from '../shared/PanelTabContainer';

const AutopilotTab = lazy(() => import('../admin/AutopilotPanel'));
const WorkflowsTab = lazy(() => import('../admin/WorkflowsPanel'));
const LearningTab = lazy(() => import('../admin/LearningPanel'));
const MemoryTab = lazy(() => import('../admin/MemoryGraphPanel'));
const SelfImproveTab = lazy(() => import('../admin/SelfImprovePanel'));
const PersonasTab = lazy(() => import('../admin/PersonasPanel'));

const Loader = () => <div className="skeleton-shimmer h-40 rounded-lg" />;

const TABS = [
  { id: 'autopilot', label: 'Autopilot', component: () => <Suspense fallback={<Loader />}><AutopilotTab /></Suspense> },
  { id: 'workflows', label: 'Workflows', component: () => <Suspense fallback={<Loader />}><WorkflowsTab /></Suspense> },
  { id: 'learning', label: 'Learning', component: () => <Suspense fallback={<Loader />}><LearningTab /></Suspense> },
  { id: 'memory', label: 'Memory & Graph', component: () => <Suspense fallback={<Loader />}><MemoryTab /></Suspense> },
  { id: 'self-improve', label: 'Self-Improve', component: () => <Suspense fallback={<Loader />}><SelfImproveTab /></Suspense> },
  { id: 'personas', label: 'Personas', component: () => <Suspense fallback={<Loader />}><PersonasTab /></Suspense> },
];

export default function IntelligenceView() {
  return <PanelTabContainer title="Intelligence" tabs={TABS} />;
}
