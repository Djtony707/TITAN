import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router';
import { CPSidebar } from './CPSidebar';

const PaperclipEmbed = lazy(() => import('./PaperclipEmbed'));

function CPLoading() {
  return <div className="flex items-center justify-center h-full text-sm text-text-muted">Loading...</div>;
}

export function CPLayout() {
  return (
    <div className="flex h-full">
      <CPSidebar />
      <div className="flex-1 overflow-auto p-6">
        <Suspense fallback={<CPLoading />}>
          <Routes>
            <Route index element={<PaperclipEmbed />} />
            <Route path="paperclip" element={<PaperclipEmbed />} />
            <Route path="*" element={<Navigate to="/command-post" replace />} />
          </Routes>
        </Suspense>
      </div>
    </div>
  );
}

export default CPLayout;
