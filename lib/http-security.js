/**
 * AifyCycle - Shared HTTP Security, CORS, CSP, Auth Verification, and Rate Limiting
 */

const crypto = require('crypto');

const CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self' https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob: https://lh3.googleusercontent.com https://*.googleusercontent.com",
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://cdn.jsdelivr.net",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'"
].join('; ');

const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP_DIRECTIVES,
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
};

function applySecurityHeaders(res) {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    res.setHeader(k, v);
  }
}

function isOriginAllowed(origin, req) {
  if (!origin) return true; // Same-origin requests without Origin header or server health checks
  try {
    const parsed = new URL(origin);
    const host = parsed.host.toLowerCase();

    // Same host as the request itself
    const reqHost = (req.headers['x-forwarded-host'] || req.headers.host || '').toLowerCase();
    if (reqHost && host === reqHost) return true;

    // Local development origins
    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
      return true;
    }

    // Production & preview Vercel URLs for AifyCycle
    if (host === 'aifycycle.vercel.app') return true;
    if (/^aifycycle-[a-z0-9-]+-aka4reals-projects\.vercel\.app$/.test(host)) return true;

    if (process.env.VERCEL_URL && host === process.env.VERCEL_URL.toLowerCase()) {
      return true;
    }

    // Explicit ALLOWED_ORIGINS env override (comma-separated origins)
    const extra = (process.env.ALLOWED_ORIGINS || '')
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean);
    if (extra.includes(origin.toLowerCase()) || extra.includes(host)) {
      return true;
    }
  } catch (e) {
    return false;
  }
  return false;
}

function applyCors(req, res, methods = 'GET, POST, OPTIONS') {
  const origin = req.headers.origin;
  const allowed = isOriginAllowed(origin, req);

  if (origin && allowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  return { allowed, origin };
}

function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    return xff.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

// Sliding-window in-memory rate limiter (per container / server instance)
const rateBuckets = new Map();
let lastPruneAt = Date.now();

function checkRateLimit(key, { limit = 15, windowMs = 10 * 60 * 1000 } = {}) {
  const now = Date.now();

  if (now - lastPruneAt > 60 * 1000) {
    lastPruneAt = now;
    for (const [k, timestamps] of rateBuckets.entries()) {
      const fresh = timestamps.filter(ts => now - ts < windowMs);
      if (fresh.length === 0) rateBuckets.delete(k);
      else rateBuckets.set(k, fresh);
    }
  }

  const recent = (rateBuckets.get(key) || []).filter(ts => now - ts < windowMs);
  if (recent.length >= limit) {
    const oldest = recent[0];
    const retryAfterSec = Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000));
    return { allowed: false, remaining: 0, retryAfterSec };
  }

  recent.push(now);
  rateBuckets.set(key, recent);
  return { allowed: true, remaining: Math.max(0, limit - recent.length), retryAfterSec: 0 };
}

// Short-lived JWT verification cache (60s) to avoid extra round-trips on rapid chat turns
const verifiedTokenCache = new Map();

async function verifySupabaseUser(req) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7).trim();
  if (!token || token.length < 20) return null;

  const supabaseUrl = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const supabaseKey = (process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || '').trim();
  if (!supabaseUrl || !supabaseKey) return null;

  const cacheKey = crypto.createHash('sha256').update(token).digest('hex');
  const cached = verifiedTokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.user;
  }

  try {
    const res = await fetch(`${supabaseUrl}/auth/v1/user`, {
      method: 'GET',
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${token}`
      },
      signal: AbortSignal.timeout(3000)
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.id) return null;

    const user = { id: data.id, email: data.email || null };
    verifiedTokenCache.set(cacheKey, { user, expiresAt: Date.now() + 60 * 1000 });
    if (verifiedTokenCache.size > 500) {
      verifiedTokenCache.clear();
    }
    return user;
  } catch (e) {
    return null;
  }
}

module.exports = {
  CSP_DIRECTIVES,
  SECURITY_HEADERS,
  applySecurityHeaders,
  isOriginAllowed,
  applyCors,
  getClientIp,
  checkRateLimit,
  verifySupabaseUser
};
