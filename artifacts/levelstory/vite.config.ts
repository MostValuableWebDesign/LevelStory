import path from 'path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

import runtimeErrorOverlay from '@replit/vite-plugin-runtime-error-modal';
import { resolveAllowedHosts } from './vite-hosts.ts';

const rawPort = process.env.PORT;

if (!rawPort) {
  throw new Error(
    'PORT environment variable is required but was not provided.',
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH;

if (!basePath) {
  throw new Error(
    'BASE_PATH environment variable is required but was not provided.',
  );
}

const allowedHosts = resolveAllowedHosts(process.env);
const privateFileDeny = [
  '**/attached_assets/**',
  '**/*.csv',
  '**/manifest.json',
  '**/metadata.json',
  '**/artifacts/api-server/src/**',
  '**/.env*',
];

function isBlockedRequestUrl(requestUrl: string | undefined): boolean {
  let pathname = (requestUrl ?? "").split("?", 1)[0];
  for (let index = 0; index < 3; index += 1) {
    try {
      const decoded = decodeURIComponent(pathname);
      if (decoded === pathname) break;
      pathname = decoded;
    } catch {
      break;
    }
  }
  let path = pathname.replaceAll("\\", "/").toLowerCase();
  const normalizedBasePath = basePath.toLowerCase().replace(/\/+$/, "");
  if (normalizedBasePath && (path === normalizedBasePath || path.startsWith(`${normalizedBasePath}/`))) {
    path = path.slice(normalizedBasePath.length) || "/";
  }
  if (path.startsWith("/")) path = path.slice(1);
  path = `/${path}`;
  return path.includes("/@fs/")
    || path.includes("/attached_assets/")
    || path.includes("/artifacts/api-server/src/")
    || path.includes("/workspace/")
    || path.endsWith(".csv")
    || /(^|\/)\.env(?:$|\.)/.test(path)
    || /(^|\/)(manifest|metadata)\.json$/.test(path);
}

const privatePathGuard = {
  name: "levelstory-private-path-guard",
  configureServer(server: { middlewares: { use: (handler: (req: { url?: string }, res: { statusCode: number; end: (body: string) => void }, next: () => void) => void) => void } }) {
    server.middlewares.use((req, res, next) => {
      if (isBlockedRequestUrl(req.url)) {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }
      next();
    });
  },
  configurePreviewServer(server: { middlewares: { use: (handler: (req: { url?: string }, res: { statusCode: number; end: (body: string) => void }, next: () => void) => void) => void } }) {
    server.middlewares.use((req, res, next) => {
      if (isBlockedRequestUrl(req.url)) {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }
      next();
    });
  },
};

export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    tailwindcss(),
    runtimeErrorOverlay(),
    privatePathGuard,
    ...(process.env.NODE_ENV !== 'production' &&
    process.env.REPL_ID !== undefined
      ? [
          await import('@replit/vite-plugin-cartographer').then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, '..'),
            }),
          ),
          await import('@replit/vite-plugin-dev-banner').then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      '@assets': path.resolve(
        import.meta.dirname,
        '..',
        '..',
        'attached_assets',
      ),
    },
    dedupe: ['react', 'react-dom'],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/public'),
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: '0.0.0.0',
    allowedHosts,
    fs: {
      strict: true,
      allow: [path.resolve(import.meta.dirname)],
      deny: privateFileDeny,
    },
    headers: {
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; frame-ancestors 'none'; base-uri 'self'",
    },
  },
  preview: {
    port,
    host: '0.0.0.0',
    allowedHosts,
    headers: {
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; frame-ancestors 'none'; base-uri 'self'",
    },
  },
});
