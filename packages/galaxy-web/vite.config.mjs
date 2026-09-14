import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/postcss';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)), base: '/app/',
  resolve: { alias: { '@': fileURLToPath(new URL('../../', import.meta.url)) } },
  css: { postcss: { plugins: [tailwindcss()] } }, plugins: [react()],
  server: { host: '127.0.0.1', port: 5179, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
});
