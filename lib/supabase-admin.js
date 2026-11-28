/**
 * AifyCycle - Server-Side Supabase Admin Client
 * Uses SUPABASE_SERVICE_ROLE_KEY strictly on the server (Node.js / Vercel API)
 * to query auth.users, run integrity diagnostics, and persist operational telemetry.
 * NEVER expose service role keys to client browsers.
 */

function getSupabaseAdminConfig() {
  const url = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const serviceKey = (
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SECRET_KEY ||
    ''
  ).trim();
  const anonKey = (
    process.env.SUPABASE_ANON_KEY ||
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    ''
  ).trim();

  return {
    url,
    serviceKey,
    anonKey,
    hasUrl: Boolean(url),
    hasAnonKey: Boolean(anonKey),
    hasServiceKey: Boolean(serviceKey),
    configured: Boolean(url && serviceKey)
  };
}

function isAdminDbConfigured() {
  return getSupabaseAdminConfig().configured;
}

function parseContentRangeCount(headerValue) {
  if (!headerValue || typeof headerValue !== 'string') return null;
  const slashIdx = headerValue.lastIndexOf('/');
  if (slashIdx === -1) return null;
  const totalPart = headerValue.slice(slashIdx + 1).trim();
  if (totalPart === '*' || !totalPart) return null;
  const n = parseInt(totalPart, 10);
  return Number.isFinite(n) ? n : null;
}

async function adminRest(pathWithQuery, {
  method = 'GET',
  body = undefined,
  headers = {},
  prefer = '',
  timeoutMs = 8000
} = {}) {
  const cfg = getSupabaseAdminConfig();
  if (!cfg.configured) {
    return { ok: false, status: 503, data: null, count: null, error: 'SUPABASE_SERVICE_ROLE_KEY_MISSING', latencyMs: 0 };
  }

  const cleanPath = pathWithQuery.startsWith('/') ? pathWithQuery : `/${pathWithQuery}`;
  const reqHeaders = {
    apikey: cfg.serviceKey,
    Authorization: `Bearer ${cfg.serviceKey}`,
    ...headers
  };

  if (prefer) {
    reqHeaders.Prefer = prefer;
  }
  if (body !== undefined && !reqHeaders['Content-Type']) {
    reqHeaders['Content-Type'] = 'application/json';
  }

  const startedAt = Date.now();
  try {
    const res = await fetch(`${cfg.url}/rest/v1${cleanPath}`, {
      method,
      headers: reqHeaders,
      body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
      signal: AbortSignal.timeout(timeoutMs)
    });
    const latencyMs = Date.now() - startedAt;
    const count = parseContentRangeCount(res.headers.get('content-range'));
    const text = await res.text().catch(() => '');
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (e) {
        data = text;
      }
    }

    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        data,
        count,
        error: (data && typeof data === 'object' && (data.message || data.error || data.hint)) || `HTTP_${res.status}`,
        code: data && typeof data === 'object' ? data.code : null,
        latencyMs
      };
    }

    return { ok: true, status: res.status, data, count, error: null, latencyMs };
  } catch (err) {
    return {
      ok: false,
      status: 503,
      data: null,
      count: null,
      error: err.message || 'NETWORK_ERROR',
      latencyMs: Date.now() - startedAt
    };
  }
}

async function adminRpc(fnName, params = {}, { timeoutMs = 10000 } = {}) {
  return adminRest(`/rpc/${encodeURIComponent(fnName)}`, {
    method: 'POST',
    body: params,
    timeoutMs
  });
}

async function countTableRows(table, filterQuery = '') {
  const qs = filterQuery ? `&${filterQuery.replace(/^[?&]+/, '')}` : '';
  const res = await adminRest(`/${encodeURIComponent(table)}?select=*&limit=0${qs}`, {
    method: 'HEAD',
    prefer: 'count=exact',
    timeoutMs: 6000
  });
  if (res.ok && res.count !== null) {
    return { ok: true, count: res.count, latencyMs: res.latencyMs, status: res.status };
  }
  // Some PostgREST proxies disallow HEAD count -> fallback GET limit=1
  const fallback = await adminRest(`/${encodeURIComponent(table)}?select=*&limit=1${qs}`, {
    method: 'GET',
    prefer: 'count=exact',
    timeoutMs: 6000
  });
  return {
    ok: fallback.ok,
    count: fallback.count !== null ? fallback.count : (Array.isArray(fallback.data) ? fallback.data.length : 0),
    error: fallback.error,
    code: fallback.code,
    status: fallback.status,
    latencyMs: fallback.latencyMs
  };
}

async function listAllAuthUsers({ maxPages = 10, perPage = 200 } = {}) {
  const cfg = getSupabaseAdminConfig();
  if (!cfg.configured) {
    return { ok: false, users: [], error: 'SUPABASE_SERVICE_ROLE_KEY_MISSING', latencyMs: 0 };
  }

  const startedAt = Date.now();
  const allUsers = [];

  try {
    for (let page = 1; page <= maxPages; page++) {
      const res = await fetch(`${cfg.url}/auth/v1/admin/users?page=${page}&per_page=${perPage}`, {
        method: 'GET',
        headers: {
          apikey: cfg.serviceKey,
          Authorization: `Bearer ${cfg.serviceKey}`
        },
        signal: AbortSignal.timeout(8000)
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        return {
          ok: false,
          users: allUsers,
          error: errBody.msg || errBody.message || errBody.error || `AUTH_ADMIN_HTTP_${res.status}`,
          status: res.status,
          latencyMs: Date.now() - startedAt
        };
      }

      const payload = await res.json().catch(() => ({}));
      const batch = Array.isArray(payload.users) ? payload.users : (Array.isArray(payload) ? payload : []);
      allUsers.push(...batch);

      if (batch.length < perPage) {
        break;
      }
    }

    return {
      ok: true,
      users: allUsers,
      error: null,
      latencyMs: Date.now() - startedAt
    };
  } catch (err) {
    return {
      ok: false,
      users: allUsers,
      error: err.message || 'AUTH_ADMIN_NETWORK_ERROR',
      latencyMs: Date.now() - startedAt
    };
  }
}

async function getAuthUserById(userId) {
  const cfg = getSupabaseAdminConfig();
  if (!cfg.configured || !userId) {
    return { ok: false, user: null, error: 'NOT_CONFIGURED' };
  }
  try {
    const res = await fetch(`${cfg.url}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
      method: 'GET',
      headers: {
        apikey: cfg.serviceKey,
        Authorization: `Bearer ${cfg.serviceKey}`
      },
      signal: AbortSignal.timeout(6000)
    });
    if (!res.ok) {
      return { ok: false, user: null, error: `HTTP_${res.status}` };
    }
    const data = await res.json().catch(() => null);
    return { ok: Boolean(data?.id), user: data, error: null };
  } catch (err) {
    return { ok: false, user: null, error: err.message };
  }
}

async function checkSupabaseHealth() {
  const cfg = getSupabaseAdminConfig();
  if (!cfg.hasUrl) {
    return {
      configured: false,
      adminConfigured: false,
      connected: false,
      restLatencyMs: null,
      authLatencyMs: null,
      error: 'SUPABASE_URL not configured'
    };
  }

  let authOk = false;
  let authLatencyMs = null;
  const authKey = cfg.serviceKey || cfg.anonKey;
  if (authKey) {
    const t0 = Date.now();
    try {
      const r = await fetch(`${cfg.url}/auth/v1/settings`, {
        headers: { apikey: authKey },
        signal: AbortSignal.timeout(5000)
      });
      authLatencyMs = Date.now() - t0;
      authOk = r.ok;
    } catch (e) {
      authLatencyMs = Date.now() - t0;
    }
  }

  if (!cfg.hasServiceKey) {
    return {
      configured: cfg.hasAnonKey,
      adminConfigured: false,
      connected: authOk,
      authOk,
      authLatencyMs,
      restLatencyMs: null,
      error: 'SUPABASE_SERVICE_ROLE_KEY not configured (admin DB queries unavailable)'
    };
  }

  const restProbe = await adminRest('/profiles?select=id&limit=1', { timeoutMs: 6000 });
  return {
    configured: true,
    adminConfigured: true,
    connected: restProbe.ok,
    authOk,
    authLatencyMs,
    restOk: restProbe.ok,
    restLatencyMs: restProbe.latencyMs,
    error: restProbe.ok ? null : restProbe.error
  };
}

module.exports = {
  getSupabaseAdminConfig,
  isAdminDbConfigured,
  adminRest,
  adminRpc,
  countTableRows,
  listAllAuthUsers,
  getAuthUserById,
  checkSupabaseHealth
};
