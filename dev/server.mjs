// Zero-dependency local server: serves the static app and mounts api/*.js handlers.
// Usage: npm start  (PORT=3000 by default). Reads a local .env if present.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Lives in dev/ so Vercel doesn't mistake it for a server entrypoint; serves the repo root.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 3000;

// Minimal .env loader (does not override real env vars).
const envFile = path.join(ROOT, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
};
// Only these top-level paths are public.
const PUBLIC = [/^\/index\.html$/, /^\/styles\.css$/, /^\/main\.js$/, /^\/src\/(?:[\w-]+\/)*[\w.-]+\.(?:js|mjs|css|json)$/, /^\/data\/[\w.-]+\.json$/, /^\/docs\/screens\/[\w.-]+\.png$/, /^\/favicon\.svg$/];

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 1_000_000) throw new Error('Body too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function handleApi(req, res, name) {
  const file = path.join(ROOT, 'api', `${name}.js`);
  if (!/^[a-z0-9-]+$/.test(name) || !existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Not found' }));
  }
  try {
    const mod = await import(pathToFileURL(file).href);
    if (req.method === 'POST' || req.method === 'PUT') {
      const raw = await readBody(req);
      try {
        req.body = raw ? JSON.parse(raw) : {};
      } catch {
        req.body = raw;
      }
    }
    await mod.default(req, res);
  } catch (err) {
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String(err?.message || err) }));
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let pathname = decodeURIComponent(url.pathname);
  const api = /^\/api\/([^/]+?)\/?$/.exec(pathname);
  if (api) return handleApi(req, res, api[1]);

  if (pathname === '/') pathname = '/index.html';
  if (!PUBLIC.some((re) => re.test(pathname))) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  const file = path.join(ROOT, pathname);
  if (!file.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end();
  }
  try {
    await stat(file);
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`Bouncer running at http://localhost:${PORT}  (AI ${process.env.ANTHROPIC_API_KEY ? 'on' : 'offline: cached scores'})`);
});
