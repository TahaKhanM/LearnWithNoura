/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': process.env.NOURA_BACKEND_URL ?? `http://localhost:${process.env.NOURA_BACKEND_PORT ?? '8787'}`,
      '/healthz': process.env.NOURA_BACKEND_URL ?? `http://localhost:${process.env.NOURA_BACKEND_PORT ?? '8787'}`,
      '/version': process.env.NOURA_BACKEND_URL ?? `http://localhost:${process.env.NOURA_BACKEND_PORT ?? '8787'}`,
      '/ws': { target: (process.env.NOURA_BACKEND_URL ?? `http://localhost:${process.env.NOURA_BACKEND_PORT ?? '8787'}`).replace(/^http/, 'ws'), ws: true },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
  },
})
