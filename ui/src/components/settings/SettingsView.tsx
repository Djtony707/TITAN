import { lazy, Suspense } from 'react';
import PanelTabContainer from '../shared/PanelTabContainer';

const GeneralTab = lazy(() => import('../admin/SettingsPanel'));
const SecurityTab = lazy(() => import('../admin/SecurityPanel'));
const AuditTab = lazy(() => import('../admin/AuditPanel'));

const TABS = [
  { id: 'general', label: 'General', component: () => <Suspense fallback={<div className="skeleton-shimmer h-40 rounded-lg" />}><GeneralTab /></Suspense> },
  { id: 'security', label: 'Security', component: () => <Suspense fallback={<div className="skeleton-shimmer h-40 rounded-lg" />}><SecurityTab /></Suspense> },
  { id: 'audit', label: 'Audit Log', component: () => <Suspense fallback={<div className="skeleton-shimmer h-40 rounded-lg" />}><AuditTab /></Suspense> },
];

export default function SettingsView() {
  return <PanelTabContainer title="Settings" tabs={TABS} />;
}
