import { Outlet } from 'react-router';
import IconRail from './IconRail';
import StatusBar from './StatusBar';

export default function AppShell() {
  return (
    <div className="flex flex-col h-screen overflow-hidden">
      <div className="flex flex-1 min-h-0">
        <IconRail />
        <main className="flex-1 min-w-0 overflow-hidden">
          <Outlet />
        </main>
      </div>
      <StatusBar />
    </div>
  );
}
