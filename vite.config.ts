import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// sqlocal's OPFS-backed SQLite requires cross-origin isolation.
function crossOriginIsolation(): Plugin {
  const setHeaders = (res: { setHeader(k: string, v: string): void }) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  };
  return {
    name: 'cross-origin-isolation',
    configureServer(server) {
      server.middlewares.use((_req, res, next) => {
        setHeaders(res);
        next();
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((_req, res, next) => {
        setHeaders(res);
        next();
      });
    },
  };
}

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// cache busting: assets are content-hashed already; version.json lets the
// running app NOTICE a new deployment (index.html may be cached by proxies)
const buildId = Date.now().toString(36);
function versionStamp(): Plugin {
  return {
    name: 'version-stamp',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ build: buildId }) });
    },
  };
}

export default defineConfig({
  plugins: [svelte(), crossOriginIsolation(), versionStamp()],
  define: {
    __BUILD_ID__: JSON.stringify(buildId),
  },
  base: './',
  resolve: {
    alias: {
      '@engine': r('./src/engine'),
      '@ai': r('./src/ai'),
      '@protocol': r('./src/protocol'),
      '@storage': r('./src/storage'),
      '@ui': r('./src/ui'),
      '@vendor': r('./vendor'),
    },
  },
  optimizeDeps: {
    exclude: ['sqlocal'],
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  preview: {
    port: 4173,
    strictPort: true,
  },
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
})
