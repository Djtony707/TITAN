import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';

/**
 * Stamp the service worker with a unique build ID so each deploy gets a
 * fresh CACHE_NAME. Without this, the SW from a previous deploy would
 * keep serving its old cached HTML, leaving users on a black page until
 * they hard-refresh. (Real incident, 2026-05-10.)
 */
function stampServiceWorkerBuildId(): Plugin {
  const buildId = String(Date.now());
  return {
    name: 'titan-sw-build-id',
    apply: 'build',
    closeBundle() {
      const swPath = path.resolve(__dirname, 'dist/sw.js');
      if (!existsSync(swPath)) return;
      let src = readFileSync(swPath, 'utf-8');
      // Replace the placeholder reference with a string literal.
      // Source has: self.__TITAN_BUILD_ID__ || 'dev'
      // After: '<buildId>'
      src = src.replace(/self\.__TITAN_BUILD_ID__\s*\|\|\s*'dev'/g, `'${buildId}'`);
      writeFileSync(swPath, src);
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), stampServiceWorkerBuildId()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:48420',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:48420',
        ws: true,
      },
      '/metrics': {
        target: 'http://localhost:48420',
        changeOrigin: true,
      },
      '/ollama': {
        target: 'http://localhost:11434',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/ollama/, ''),
      },
      '/v1/audio': {
        target: 'http://127.0.0.1:5006',
        changeOrigin: true,
      },
    },
  },
});
