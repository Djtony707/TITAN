import { Link } from 'react-router';
import { ShieldAlert } from 'lucide-react';
import { useConfig } from '@/hooks/useConfig';

type AuthBlock = {
  mode?: string;
  openAccess?: boolean;
  tokenConfigured?: boolean;
};

export function OpenAuthBanner() {
  const { config } = useConfig();
  const auth = (config as unknown as { gateway?: { auth?: AuthBlock } } | null)?.gateway?.auth;
  if (!auth || auth.openAccess !== true) return null;

  const tokenFootgun = auth.mode === 'token' && auth.tokenConfigured === false;
  const bg = tokenFootgun ? 'bg-red-500/15 border-red-500/50 text-red-100' : 'bg-amber-500/15 border-amber-500/40 text-amber-100';
  const iconColor = tokenFootgun ? 'text-red-400' : 'text-amber-400';
  const badge = tokenFootgun
    ? 'Gateway auth is not configured — remote API access is denied, but this instance has no token set.'
    : 'Open access — gateway auth is disabled (auth.mode: "none").';

  return (
    <div
      className={`${bg} border-b px-4 py-2.5 flex items-center gap-3 text-[13px]`}
      role="alert"
    >
      <ShieldAlert size={16} className={`${iconColor} flex-shrink-0`} />
      <div className="flex-1 min-w-0">
        <span className="font-semibold">{badge}</span>{' '}
        <span className="opacity-90">
          Anyone with network access to this gateway can use it. Set a token in
          Settings → Security to lock it down.
        </span>
      </div>
      <Link
        to="/settings"
        className={`px-3 py-1 rounded ${
          tokenFootgun
            ? 'bg-red-500/30 hover:bg-red-500/50 text-red-50'
            : 'bg-amber-500/30 hover:bg-amber-500/50 text-amber-50'
        } font-medium transition-colors flex-shrink-0`}
      >
        Configure auth
      </Link>
    </div>
  );
}
