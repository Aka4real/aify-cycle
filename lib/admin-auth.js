/**
 * AifyCycle - Hybrid Admin Authentication & Session Manager
 * Supports:
 * 1. Supabase Auth JWT verified against ADMIN_EMAILS env allowlist OR profiles.is_admin = true
 * 2. Optional Admin Secret Key (ADMIN_SECRET / ADMIN_PASSWORD) issuing an HMAC-SHA256 signed HttpOnly cookie
 */

const crypto = require('crypto');
const { verifySupabaseUser, checkRateLimit, getClientIp } = require('./http-security');
const { isAdminDbConfigured, adminRest } = require('./supabase-admin');

const ADMIN_COOKIE_NAME = 'aify_admin_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

// Ephemeral fallback signing secret if ADMIN_SECRET isn't set (only used when signing cookies)
const PROCESS_FALLBACK_KEY = crypto.randomBytes(32).toString('hex');

function getConfiguredAdminEmails() {
  return (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);
}

function getConfiguredAdminSecret() {
  return (process.env.ADMIN_SECRET || process.env.ADMIN_PASSWORD || '').trim();
}

function getSigningSecret() {
  return (
    process.env.ADMIN_SESSION_SECRET ||
    getConfiguredAdminSecret() ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    PROCESS_FALLBACK_KEY
  );
}

function timingSafeStringEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Burn equal time on dummy comparison to reduce length-timing leakage
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function parseCookies(req) {
  const raw = req?.headers?.cookie || '';
  const map = {};
  if (!raw) return map;
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) {
      try {
        map[key] = decodeURIComponent(val);
      } catch (e) {
        map[key] = val;
      }
    }
  }
  return map;
}

function signAdminSessionToken(payload) {
  const data = {
    ...payload,
    iat: Date.now(),
    exp: Date.now() + SESSION_TTL_MS
  };
  const encoded = Buffer.from(JSON.stringify(data), 'utf8').toString('base64url');
  const sig = crypto
    .createHmac('sha256', getSigningSecret())
    .update(encoded)
    .digest('base64url');
  return `${encoded}.${sig}`;
}

function verifyAdminSessionToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encoded, sig] = parts;
  if (!encoded || !sig) return null;

  const expected = crypto
    .createHmac('sha256', getSigningSecret())
    .update(encoded)
    .digest('base64url');

  if (!timingSafeStringEqual(sig, expected)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed.exp || Date.now() > parsed.exp) return null;
    return parsed;
  } catch (e) {
    return null;
  }
}

function buildAdminCookieHeader(token, req, { clear = false } = {}) {
  const isHttps = Boolean(
    req?.headers?.['x-forwarded-proto'] === 'https' ||
    req?.socket?.encrypted ||
    process.env.VERCEL === '1'
  );
  const parts = [
    `${ADMIN_COOKIE_NAME}=${clear ? '' : encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    clear ? 'Max-Age=0' : `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  ];
  if (isHttps) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

async function isEmailOrDbAdmin(supabaseUser) {
  if (!supabaseUser?.id) return false;
  const allowlist = getConfiguredAdminEmails();
  const email = (supabaseUser.email || '').trim().toLowerCase();

  if (email && allowlist.includes(email)) {
    return true;
  }

  // Check profiles.is_admin flag if Service Role DB is configured
  if (isAdminDbConfigured()) {
    const res = await adminRest(`/profiles?id=eq.${encodeURIComponent(supabaseUser.id)}&select=is_admin&limit=1`, {
      timeoutMs: 3500
    });
    if (res.ok && Array.isArray(res.data) && res.data[0]?.is_admin === true) {
      return true;
    }
  }

  return false;
}

function getAdminAuthConfigStatus() {
  const adminEmails = getConfiguredAdminEmails();
  const hasSecret = Boolean(getConfiguredAdminSecret());
  const hasSupabase = Boolean(
    process.env.SUPABASE_URL?.trim() &&
    (process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || '').trim()
  );
  const hasServiceRole = isAdminDbConfigured();

  return {
    configured: adminEmails.length > 0 || hasSecret || hasServiceRole,
    methods: {
      supabaseAllowlist: hasSupabase && (adminEmails.length > 0 || hasServiceRole),
      secretKey: hasSecret
    },
    adminEmailCount: adminEmails.length,
    serviceRoleConfigured: hasServiceRole
  };
}

/**
 * Verify an incoming admin API request via:
 * 1. Signed HttpOnly admin session cookie (aify_admin_session)
 * 2. Supabase Authorization: Bearer <jwt> matching ADMIN_EMAILS or profiles.is_admin
 */
async function verifyAdminRequest(req) {
  // 1. Check signed HttpOnly cookie first (fast, zero network calls)
  const cookies = parseCookies(req);
  if (cookies[ADMIN_COOKIE_NAME]) {
    const session = verifyAdminSessionToken(cookies[ADMIN_COOKIE_NAME]);
    if (session) {
      return {
        authenticated: true,
        admin: {
          identity: session.identity || 'admin',
          email: session.email || null,
          userId: session.userId || null,
          method: session.method || 'secret_key',
          expiresAt: new Date(session.exp).toISOString()
        }
      };
    }
  }

  // 2. Check Supabase Bearer JWT against ADMIN_EMAILS / profiles.is_admin
  const sbUser = await verifySupabaseUser(req);
  if (sbUser) {
    const allowed = await isEmailOrDbAdmin(sbUser);
    if (allowed) {
      return {
        authenticated: true,
        admin: {
          identity: sbUser.email || sbUser.id,
          email: sbUser.email || null,
          userId: sbUser.id,
          method: 'supabase_jwt',
          expiresAt: null
        }
      };
    }
    return {
      authenticated: false,
      reason: 'NOT_ADMIN',
      message: 'This account is not authorized for admin access.'
    };
  }

  return {
    authenticated: false,
    reason: 'UNAUTHENTICATED',
    message: 'Admin authentication required.'
  };
}

/**
 * Handle POST /api/admin/auth login attempts (Secret Key OR Supabase JWT exchange)
 */
async function handleAdminLogin(req, body = {}) {
  const ip = getClientIp(req);
  const rl = checkRateLimit(`admin-login:${ip}`, { limit: 12, windowMs: 15 * 60 * 1000 });
  if (!rl.allowed) {
    return {
      status: 429,
      headers: { 'Retry-After': String(rl.retryAfterSec) },
      data: {
        error: 'RATE_LIMITED',
        message: `Too many admin sign-in attempts. Retry in ${rl.retryAfterSec}s.`
      }
    };
  }

  const mode = (body.mode || 'secret').toLowerCase();

  // Mode A: Admin Secret Key
  if (mode === 'secret') {
    const configuredSecret = getConfiguredAdminSecret();
    if (!configuredSecret) {
      return {
        status: 503,
        headers: {},
        data: {
          error: 'ADMIN_SECRET_NOT_CONFIGURED',
          message: 'ADMIN_SECRET is not set on this server. Sign in with an allowlisted Supabase admin account or configure ADMIN_SECRET in environment variables.'
        }
      };
    }

    const supplied = typeof body.secret === 'string' ? body.secret.trim() : '';
    if (!supplied || !timingSafeStringEqual(supplied, configuredSecret)) {
      return {
        status: 401,
        headers: {},
        data: {
          error: 'INVALID_SECRET',
          message: 'Invalid admin access key.'
        }
      };
    }

    const token = signAdminSessionToken({
      identity: 'Admin Key Operator',
      method: 'secret_key'
    });

    return {
      status: 200,
      headers: { 'Set-Cookie': buildAdminCookieHeader(token, req) },
      data: {
        authenticated: true,
        admin: {
          identity: 'Admin Key Operator',
          method: 'secret_key'
        }
      }
    };
  }

  // Mode B: Supabase JWT verification + session cookie mint
  if (mode === 'supabase') {
    const sbUser = await verifySupabaseUser(req);
    if (!sbUser) {
      return {
        status: 401,
        headers: {},
        data: {
          error: 'INVALID_SESSION',
          message: 'Valid Supabase session token is required.'
        }
      };
    }

    const allowed = await isEmailOrDbAdmin(sbUser);
    if (!allowed) {
      return {
        status: 403,
        headers: {},
        data: {
          error: 'FORBIDDEN_ADMIN',
          message: 'Your account is not listed in ADMIN_EMAILS and does not hold an admin role.'
        }
      };
    }

    const token = signAdminSessionToken({
      identity: sbUser.email || sbUser.id,
      email: sbUser.email || null,
      userId: sbUser.id,
      method: 'supabase_allowlist'
    });

    return {
      status: 200,
      headers: { 'Set-Cookie': buildAdminCookieHeader(token, req) },
      data: {
        authenticated: true,
        admin: {
          identity: sbUser.email || sbUser.id,
          email: sbUser.email || null,
          userId: sbUser.id,
          method: 'supabase_allowlist'
        }
      }
    };
  }

  return {
    status: 400,
    headers: {},
    data: { error: 'INVALID_MODE', message: 'Expected mode "secret" or "supabase".' }
  };
}

function handleAdminLogout(req) {
  return {
    status: 200,
    headers: { 'Set-Cookie': buildAdminCookieHeader('', req, { clear: true }) },
    data: { authenticated: false, loggedOut: true }
  };
}

module.exports = {
  ADMIN_COOKIE_NAME,
  getConfiguredAdminEmails,
  getConfiguredAdminSecret,
  getAdminAuthConfigStatus,
  signAdminSessionToken,
  verifyAdminSessionToken,
  verifyAdminRequest,
  handleAdminLogin,
  handleAdminLogout,
  parseCookies
};
