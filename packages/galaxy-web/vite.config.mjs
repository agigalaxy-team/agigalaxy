import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/postcss';
import { fileURLToPath } from 'node:url';
import { productMiddleware } from '../../scripts/serve-product.mjs';
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)), base: '/app/',
  resolve: { alias: { '@': fileURLToPath(new URL('../../', import.meta.url)) } },
  css: { postcss: { plugins: [tailwindcss()] } }, plugins: [react(), {
    name: 'galaxy-public-website',
    configureServer(server) { server.middlewares.use(productMiddleware({ development: true })); },
  }],
  server: { host: '127.0.0.1', port: 5179, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
});
