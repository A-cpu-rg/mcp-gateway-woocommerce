import { defineConfig } from 'vite';

// `pnpm dev` proxies API and MCP calls to a gateway on :8080 so the dashboard runs same-origin.
export default defineConfig({
  oxc: { jsx: { runtime: 'automatic' } },
  server: { proxy: { '/api': 'http://localhost:8080', '/mcp': 'http://localhost:8080' } },
  build: { outDir: 'dist', sourcemap: false },
});
