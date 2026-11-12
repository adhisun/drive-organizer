import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

/**
 * Minimal zero-dependency .env parser.
 * Does not overwrite existing environment variables unless override=true.
 */
export function parseEnvContent(content) {
  const result = {};
  if (!content) return result;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;

    const key = line.slice(0, eqIdx).trim();
    let value = line.slice(eqIdx + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) {
      result[key] = value;
    }
  }
  return result;
}

export function loadDotEnv(envPath = path.join(__dirname, '.env')) {
  try {
    if (!fs.existsSync(envPath)) return {};
    const raw = fs.readFileSync(envPath, 'utf8');
    return parseEnvContent(raw);
  } catch {
    return {};
  }
}

function readRequestBody(req, maxBytes = 16384) {
  return new Promise((resolve, reject) => {
    if (!req || typeof req.on !== 'function') {
      resolve(req?.body || '');
      return;
    }
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      total += buf.byteLength;
      if (total > maxBytes) {
        reject(new Error('Payload too large'));
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function createAppServer({ rootDir = __dirname, envPath = path.join(rootDir, '.env') } = {}) {
  let memoryAuthSession = null;

  const securityHeaders = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
    'Cache-Control': 'no-cache'
  };

  return http.createServer(async (req, res) => {
    try {
      const reqUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

      // In-memory loopback session relay so popup -> main tab works even across localhost/127.0.0.1 or partitioned storage
      if (reqUrl.pathname === '/api/auth-session') {
        if (req.method === 'GET') {
          if (memoryAuthSession && memoryAuthSession.expiresAt > Date.now()) {
            res.writeHead(200, { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ session: memoryAuthSession }));
          } else {
            memoryAuthSession = null;
            res.writeHead(200, { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ session: null }));
          }
          return;
        }

        if (req.method === 'POST') {
          const rawBody = await readRequestBody(req);
          const parsed = JSON.parse(rawBody || '{}');
          if (parsed?.accessToken && Number(parsed.expiresAt) > Date.now()) {
            memoryAuthSession = {
              accessToken: String(parsed.accessToken),
              expiresAt: Number(parsed.expiresAt),
              scope: String(parsed.scope || ''),
              hasWriteAccess: Boolean(parsed.hasWriteAccess),
              userProfile: parsed.userProfile || null
            };
          }
          res.writeHead(200, { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        if (req.method === 'DELETE') {
          memoryAuthSession = null;
          res.writeHead(200, { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Method Not Allowed' }));
        return;
      }

      if (reqUrl.pathname === '/api/config') {
        const fileEnv = loadDotEnv(envPath);
        const rawScriptUrl =
          process.env.APPS_SCRIPT_WEBAPP_URL || fileEnv.APPS_SCRIPT_WEBAPP_URL || '';
        const isPlaceholder = rawScriptUrl.includes('YOUR_DEPLOYMENT_ID');

        res.writeHead(200, { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            appsScriptUrl: isPlaceholder ? '' : rawScriptUrl.trim()
          })
        );
        return;
      }

      let relativePath = decodeURIComponent(reqUrl.pathname);
      if (relativePath === '/') {
        relativePath = '/index.html';
      }

      // Block access to hidden dotfiles (such as .env or .git) and directory traversal
      const normalizedRel = path.posix.normalize(relativePath);
      const segments = normalizedRel.split('/').filter(Boolean);
      if (segments.some((seg) => seg === '..' || seg.startsWith('.'))) {
        res.writeHead(403, { ...securityHeaders, 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
      }

      const resolvedPath = path.resolve(rootDir, ...segments);
      if (!resolvedPath.startsWith(path.resolve(rootDir))) {
        res.writeHead(403, { ...securityHeaders, 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
      }

      const stat = await fsp.stat(resolvedPath).catch(() => null);
      if (!stat || !stat.isFile()) {
        res.writeHead(404, { ...securityHeaders, 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }

      const ext = path.extname(resolvedPath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      const body = await fsp.readFile(resolvedPath);

      res.writeHead(200, {
        ...securityHeaders,
        'Content-Type': contentType,
        'Content-Length': body.byteLength
      });

      if (req.method === 'HEAD') {
        res.end();
      } else {
        res.end(body);
      }
    } catch (err) {
      res.writeHead(500, { ...securityHeaders, 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Internal Server Error');
    }
  });
}

// Run server directly when invoked as main entry point
const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  const fileEnv = loadDotEnv();
  const port = Number(process.env.PORT || fileEnv.PORT || 5173);
  const host = process.env.HOST || '127.0.0.1';
  const server = createAppServer();

  server.listen(port, host, () => {
    console.log(`\n  Drive Nano Categorizer running at:`);
    console.log(`  -> http://localhost:${port}\n`);
    console.log(`  Tip: Open in Google Chrome with Built-in AI enabled, or click "Try Sample Data (Demo)".`);
  });
}
