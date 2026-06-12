import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import manifest from './src/manifest';

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  server: {
    port: 5173,
    strictPort: true,
    hmr: { port: 5174 },
  },
  build: {
    target: 'esnext',
    // Disable Vite's module-preload helper. It calls
    // `document.getElementsByTagName('link')` to inject <link rel=modulepreload>
    // tags — meaningless in a service worker (no DOM) and a hard crash:
    // any dynamic `import()` in the SW (e.g. the eval/backtest RPC handlers
    // do `await import('../ml/eval')`) threw "document is not defined".
    // Disabling it makes dynamic imports load deps on demand instead, which
    // is correct in every context including the SW. The only cost is a
    // negligible loss of dashboard preload prefetching.
    modulePreload: false,
    rollupOptions: {
      input: { dashboard: 'src/dashboard/index.html' },
    },
  },
});
