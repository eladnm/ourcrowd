import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    // The dev server proxies to the API so the app talks to one origin in
    // development and is served directly by Fastify in production.
    proxy: { '/api': 'http://localhost:4000' },
  },
});
