import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API_PORT = process.env.PORT || 8787;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // the dev server serves files straight from the project folder: keep secrets and the database out of reach
    fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '.secrets/**', 'data/**', 'data-real/**'] },
    proxy: {
      '/api': { target: `http://localhost:${API_PORT}`, changeOrigin: true },
      '/uploads': { target: `http://localhost:${API_PORT}`, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
});
