import { lazy, Suspense } from 'react';
import PanelTabContainer from '../shared/PanelTabContainer';

const SkillsTab = lazy(() => import('../admin/SkillsPanel'));
const McpTab = lazy(() => import('../admin/McpPanel'));
const IntegrationsTab = lazy(() => import('../admin/IntegrationsPanel'));
const ChannelsTab = lazy(() => import('../admin/ChannelsPanel'));
const MeshTab = lazy(() => import('../admin/MeshPanel'));

const Loader = () => <div className="skeleton-shimmer h-40 rounded-lg" />;

const TABS = [
  { id: 'skills', label: 'Skills', component: () => <Suspense fallback={<Loader />}><SkillsTab /></Suspense> },
  { id: 'mcp', label: 'MCP Servers', component: () => <Suspense fallback={<Loader />}><McpTab /></Suspense> },
  { id: 'integrations', label: 'Integrations', component: () => <Suspense fallback={<Loader />}><IntegrationsTab /></Suspense> },
  { id: 'channels', label: 'Channels', component: () => <Suspense fallback={<Loader />}><ChannelsTab /></Suspense> },
  { id: 'mesh', label: 'Mesh Network', component: () => <Suspense fallback={<Loader />}><MeshTab /></Suspense> },
];

export default function ToolsView() {
  return <PanelTabContainer title="Tools & Connections" tabs={TABS} />;
}
