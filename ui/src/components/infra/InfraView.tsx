import { lazy, Suspense } from 'react';
import PanelTabContainer from '../shared/PanelTabContainer';

const HomelabTab = lazy(() => import('../admin/HomelabPanel'));
const GpuTab = lazy(() => import('../admin/NvidiaPanel'));
const FilesTab = lazy(() => import('../admin/FilesPanel'));
const LogsTab = lazy(() => import('../admin/LogsPanel'));
const TelemetryTab = lazy(() => import('../admin/TelemetryPanel'));

const Loader = () => <div className="skeleton-shimmer h-40 rounded-lg" />;

const TABS = [
  { id: 'homelab', label: 'Homelab', component: () => <Suspense fallback={<Loader />}><HomelabTab /></Suspense> },
  { id: 'gpu', label: 'GPU / NVIDIA', component: () => <Suspense fallback={<Loader />}><GpuTab /></Suspense> },
  { id: 'files', label: 'Files', component: () => <Suspense fallback={<Loader />}><FilesTab /></Suspense> },
  { id: 'logs', label: 'Logs', component: () => <Suspense fallback={<Loader />}><LogsTab /></Suspense> },
  { id: 'telemetry', label: 'Telemetry', component: () => <Suspense fallback={<Loader />}><TelemetryTab /></Suspense> },
];

export default function InfraView() {
  return <PanelTabContainer title="Infrastructure" tabs={TABS} />;
}
