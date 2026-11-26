const http = require('http');
const fs = require('fs');
const path = require('path');
const { applyCors, applySecurityHeaders } = require('./lib/http-security');
const { getGeminiStatus, getConfiguredModel, processGeminiProxyRequest } = require('./lib/gemini');

// Safe .env loader (supports Node 20+ built-in loadEnvFile with graceful fallback)
function loadEnv() {
  try {
    if (typeof process.loadEnvFile === 'function') {
      process.loadEnvFile();
    } else {
      const envPath = path.join(__dirname, '.env');
      if (fs.existsSync(envPath)) {
        const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const idx = trimmed.indexOf('=');
          if (idx > 0) {
            const key = trimmed.slice(0, idx).trim();
            const val = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
            if (!process.env[key]) {
              process.env[key] = val;
            }
          }
        }
      }
    }
  } catch (e) {
    // Non-fatal if .env does not exist
  }
}

loadEnv();

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = __dirname;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json'
};

// Sensitive files and internal directories that must NEVER be served over HTTP
const BLOCKED_FILENAMES = new Set([
  'server.js',
  'dockerfile',
  '.dockerignore',
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'vercel.json',
  'supabase_setup.md',
  'deployment.md'
]);

const BLOCKED_PREFIXES = ['/supabase/', '/lib/', '/scripts/', '/tests/', '/api/'];

async function handleRequest(req, res) {
  const [reqPath] = (req.url || '/').split('?');

  applySecurityHeaders(res);
  const cors = applyCors(req, res, 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(cors.allowed ? 204 : 403);
    return res.end();
  }

  // --- API Routes ---

  if (req.method === 'GET' && (reqPath === '/api/gemini/status' || reqPath === '/api/gemini')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(getGeminiStatus()));
  }

  if (req.method === 'GET' && reqPath === '/api/supabase/config') {
    const supabaseUrl = process.env.SUPABASE_URL?.trim() || '';
    const supabaseAnonKey = (process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || '').trim();
    const isConfigured = Boolean(supabaseUrl && supabaseAnonKey);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      configured: isConfigured,
      url: supabaseUrl,
      anonKey: supabaseAnonKey
    }));
  }

  if (req.method === 'POST' && reqPath === '/api/gemini') {
    if (!cors.allowed) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'ORIGIN_NOT_ALLOWED', message: 'Cross-origin request blocked.' }));
    }

    let body = '';
    let aborted = false;
    req.on('data', chunk => {
      if (aborted) return;
      body += chunk;
      // Guard against oversized payload (> 64KB)
      if (body.length > 64 * 1024) {
        aborted = true;
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'PAYLOAD_TOO_LARGE' }));
        req.destroy();
      }
    });

    req.on('end', async () => {
      if (aborted) return;
      try {
        const parsedBody = JSON.parse(body || '{}');
        const result = await processGeminiProxyRequest(req, parsedBody);
        res.writeHead(result.status, {
          'Content-Type': 'application/json',
          ...(result.headers || {})
        });
        res.end(JSON.stringify(result.data));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'INVALID_JSON',
          message: err.message || 'Invalid JSON payload'
        }));
      }
    });
    return;
  }

  // Strict API route isolation: any unmatched /api/* route returns JSON 404
  if (reqPath.startsWith('/api/')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'NOT_FOUND', path: reqPath }));
  }

  // --- Static Files Serving & Security Hardening ---

  const segments = reqPath.split('/').filter(Boolean);
  if (segments.some(seg => seg.startsWith('.'))) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('404 Not Found');
  }

  const baseName = path.basename(reqPath).toLowerCase();
  const lowerPath = reqPath.toLowerCase();
  if (BLOCKED_FILENAMES.has(baseName) || BLOCKED_PREFIXES.some(p => lowerPath.startsWith(p))) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('404 Not Found');
  }

  const normalizedReqPath = path.normalize(reqPath).replace(/^(\.\.[\/\\])+/, '');
  const trimmedPath = normalizedReqPath.replace(/[\/\\]+$/, '');
  const relativePath = trimmedPath === '' || trimmedPath === '/'
    ? 'index.html'
    : (trimmedPath === '/admin' || trimmedPath === '\\admin')
      ? 'admin.html'
      : normalizedReqPath.replace(/^[\/\\]+/, '');

  const filePath = path.resolve(PUBLIC_DIR, relativePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('403 Forbidden');
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        const fallbackPath = path.join(PUBLIC_DIR, 'index.html');
        fs.readFile(fallbackPath, (fallbackErr, fallbackContent) => {
          if (fallbackErr) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            return res.end('404 Not Found');
          }
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache'
          });
          res.end(fallbackContent);
        });
      } else {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`Server Error: ${err.code}`);
      }
    } else {
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache'
      });
      res.end(content);
    }
  });
}

const server = http.createServer(handleRequest);

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n[AifyCycle Server Error] Port ${PORT} is already in use by another process.`);
    console.error(`Please stop the existing process or set a different PORT in .env (e.g., PORT=3000).\n`);
  } else {
    console.error('[AifyCycle Server Error]', err);
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    const hasKey = Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim());
    const model = getConfiguredModel();
    console.log(`\n🚀 AifyCycle server running at http://${HOST}:${PORT}`);
    console.log(`📡 Gemini API Proxy: ${hasKey ? `Configured (${model} with cascade)` : 'Not set in .env (Local Mode)'}`);
    console.log(`🛡️  Security Shield: CSP + CORS allowlist + rate limiting active\n`);
  });

  if (!process.env.PORT && PORT === 3000) {
    try {
      const fallbackServer = http.createServer(handleRequest);
      fallbackServer.on('error', () => {});
      fallbackServer.listen(4180, HOST, () => {
        console.log(`🚀 Dual-port fallback active at http://${HOST}:4180`);
      });
    } catch (e) {}
  }
}

module.exports = server;
