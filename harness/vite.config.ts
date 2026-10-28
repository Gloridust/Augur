// `npm run harness` — the real dashboard + the real service-worker module in
// one ordinary page, on the test suite's chrome mock and the browser's own
// IndexedDB, seeded with synthetic browsing. For checking the UI end to end
// (suggestions, tab wall, export/import, refresh gating) without loading the
// extension. No crx plugin: this page is not an extension.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'harness',
  plugins: [react()],
  server: { port: 5180, strictPort: true, fs: { allow: ['..'] } },
});
