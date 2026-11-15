/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The API target uses 127.0.0.1, not localhost: Node 24 resolves localhost to ::1 and uvicorn
// binds IPv4. Worktree builders override it with VITE_API_TARGET (see plan §8).
const apiTarget = process.env.VITE_API_TARGET ?? 'http://127.0.0.1:8000';

export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': { target: apiTarget, changeOrigin: false } } },
  build: { outDir: 'dist', sourcemap: true },
  test: { environment: 'jsdom', include: ['src/**/*.test.{ts,tsx}'] },
});
