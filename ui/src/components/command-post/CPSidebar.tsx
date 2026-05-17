import { TitanShellSidebar } from '@/components/shell/TitanShell';

/**
 * Command Post sidebar migration shim.
 *
 * The canonical sidebar now lives at the authenticated App shell level.
 * This component stays import-compatible for any /command-post/* migration
 * path that still expects CPSidebar, but it delegates to the shared shell.
 */
export function CPSidebar() {
  return <TitanShellSidebar className="flex" />;
}
