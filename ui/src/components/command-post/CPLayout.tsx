import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router';
import { CPSidebar } from './CPSidebar';

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

function CPLoading() {
  return <div className="flex items-center justify-center h-full text-sm text-text-muted">Loading...</div>;
}

export function CPLayout() {
  return (
    <div className="flex h-screen bg-bg">
      <CPSidebar />
      <div className="flex-1 overflow-auto">
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

            {/* Fallback */}
            <Route path="*" element={<Navigate to="/command-post" replace />} />
          </Routes>
        </Suspense>
      </div>
    </div>
  );
}

export default CPLayout;