import { QueryClient } from '@tanstack/react-query';

/* ═══════════════════════════════════════════════════════════════════
   TITAN Query Client — Global cache & stale-while-revalidate config
   Pattern ported from Space Agent (Paperclip)
   ═══════════════════════════════════════════════════════════════════ */

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 30,        // 30s stale time
      gcTime: 1000 * 60 * 5,       // 5min garbage collection
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      retry: (failureCount, error: any) => {
        // Don't retry on 4xx errors
        if (error?.status >= 400 && error?.status < 500) return false;
        return failureCount < 2;
      },
    },
    mutations: {
      retry: false,
    },
  },
});
