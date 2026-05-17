import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router';

// Eager-load lightweight landing views; lazy-load heavier tabs
const CommandPostHub = lazy(() => import('@/components/admin/CommandPostHub'));
const CPIssues = lazy(() => import('@/components/command-post/CPIssues'));
const CPIssueDetail = lazy(() => import('@/components/command-post/CPIssueDetail'));
const CPAgents = lazy(() => import('@/components/command-post/CPAgents'));
const CPAgentDetail = lazy(() => import('@/components/command-post/CPAgentDetail'));
const CPApprovals = lazy(() => import('@/components/command-post/CPApprovals'));
const CPActivity = lazy(() => import('@/components/command-post/CPActivity'));
const CPGoals = lazy(() => import('@/components/command-post/CPGoals'));
const CPRuns = lazy(() => import('@/components/command-post/CPRuns'));
const CPCosts = lazy(() => import('@/components/command-post/CPCosts'));
const CPOrg = lazy(() => import('@/components/command-post/CPOrg'));
const CPFiles = lazy(() => import('@/components/command-post/CPFiles'));

function CPLoading() {
  return <div className="flex items-center justify-center h-full text-sm" style={{ color: '#c4b49a' }}>Loading...</div>;
}

export function CPLayout() {
  return (
    <div className="h-full overflow-hidden">
      <div className="h-full overflow-auto">
        <Suspense fallback={<CPLoading />}>
          <Routes>
            {/* Default → full hub with tabbed interface */}
            <Route index element={<CommandPostHub />} />
            <Route path="dashboard" element={<CommandPostHub />} />

            {/* Dedicated pages */}
            <Route path="issues" element={<CPIssues />} />
            <Route path="issues/:id" element={<CPIssueDetail />} />
            <Route path="agents" element={<CPAgents />} />
            <Route path="agents/:id" element={<CPAgentDetail />} />
            <Route path="approvals" element={<CPApprovals />} />
            <Route path="activity" element={<CPActivity />} />
            <Route path="goals" element={<CPGoals />} />
            <Route path="runs" element={<CPRuns />} />
            <Route path="costs" element={<CPCosts />} />
            <Route path="org" element={<CPOrg />} />
            <Route path="files" element={<CPFiles />} />

            {/* Fallback */}
            <Route path="*" element={<Navigate to="/command-post" replace />} />
          </Routes>
        </Suspense>
      </div>
    </div>
  );
}

export default CPLayout;
