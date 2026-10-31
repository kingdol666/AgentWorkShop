import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  root: import.meta.dirname,
  plugins: [vue()],
  server: {
    port: 4011,
    proxy: {
      '/api': 'http://127.0.0.1:4010',
      '/sim-http': 'http://127.0.0.1:4010',
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
})
