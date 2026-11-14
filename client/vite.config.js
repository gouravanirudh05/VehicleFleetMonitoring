import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const server = process.env.FLEETWAKE_SERVER || 'http://localhost:4000';

// The dashboard is served under /dashboard/. In development, Vite proxies the API, the
// Socket.IO connection and the landing page (/) to the Express server, so everything works
// from http://localhost:5173 just as it does from the single production origin.
export default defineConfig({
  base: '/dashboard/',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': server,
      '/socket.io': { target: server, ws: true },
      '^/(index\\.html)?$': server,
    },
  },
  worker: { format: 'es' },
  build: { outDir: 'dist', chunkSizeWarningLimit: 1500 },
});
