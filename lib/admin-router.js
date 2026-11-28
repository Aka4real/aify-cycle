/**
 * AifyCycle - Shared Request Handlers for Telemetry & Admin APIs
 * Used identically by Node.js server.js and Vercel Serverless Functions in /api/*.
 */

const {
  applyCors,
  applySecurityHeaders,
  getClientIp,
  checkRateLimit,
  verifySupabaseUser
} = require('./http-security');
const {
  getAdminAuthConfigStatus,
  verifyAdminRequest,
  handleAdminLogin,
  handleAdminLogout
} = require('./admin-auth');
const {
  recordHeartbeat,
  recordAdminAudit,
  recordHttpMetric
} = require('./telemetry-store');
const {
  probeGeminiModel,
  probeAllGeminiModels,
  markModelCooldown,
  resetModelCooldown,
  clearModelCooldowns,
  getDetailedGeminiHealth
} = require('./gemini');
const {
  getOverviewPayload,
  getUsersPayload,
  getUserDetailPayload,
  getDatabaseIntegrityPayload,
  getGeminiHealthPayload,
  getTelemetryDeepDivePayload,
  exportReportPayload
} = require('./admin-service');

function parseQuery(req) {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    const out = {};
    for (const [k, v] of url.searchParams.entries()) {
      out[k] = v;
    }
    return out;
  } catch (e) {
    return {};
  }
}

function sendResponse(res, status, data, extraHeaders = {}) {
  recordHttpMetric(status);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders
  };

  if (typeof res.status === 'function' && typeof res.json === 'function') {
    for (const [k, v] of Object.entries(headers)) {
      res.setHeader(k, v);
    }
    if (typeof data === 'string') {
      return res.status(status).send(data);
    }
    return res.status(status).json(data);
  }

  res.writeHead(status, headers);
  res.end(typeof data === 'string' ? data : JSON.stringify(data));
}

function readJsonBody(req, maxBytes = 64 * 1024) {
  if (req.body !== undefined) {
    if (typeof req.body === 'string') {
      return Promise.resolve(JSON.parse(req.body || '{}'));
    }
    if (req.body && typeof req.body === 'object') {
      return Promise.resolve(req.body);
    }
    return Promise.resolve({});
  }

  return new Promise((resolve, reject) => {
    let raw = '';
    let exceeded = false;
    req.on('data', chunk => {
      if (exceeded) return;
      raw += chunk;
      if (raw.length > maxBytes) {
        exceeded = true;
        reject(Object.assign(new Error('Payload too large'), { statusCode: 413 }));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (exceeded) return;
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(Object.assign(new Error('Invalid JSON payload'), { statusCode: 400 }));
      }
    });
    req.on('error', err => reject(err));
  });
}

function applyAdminCors(req, res, methods = 'GET, POST, DELETE, OPTIONS') {
  applySecurityHeaders(res);
  const cors = applyCors(req, res, methods);
  if (cors.origin && cors.allowed) {
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  return cors;
}

/**
 * Public Telemetry Heartbeat Endpoint: POST /api/telemetry/heartbeat
 * Accepts standard JSON fetch OR navigator.sendBeacon (text/plain JSON).
 */
async function handleTelemetryHeartbeatRequest(req, res) {
  const cors = applyAdminCors(req, res, 'POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    return sendResponse(res, cors.allowed ? 204 : 403, '');
  }
  if (req.method !== 'POST') {
    return sendResponse(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  }
  if (!cors.allowed) {
    return sendResponse(res, 403, { error: 'ORIGIN_NOT_ALLOWED' });
  }

  const ip = getClientIp(req);
  const rl = checkRateLimit(`hb:${ip}`, { limit: 120, windowMs: 5 * 60 * 1000 });
  if (!rl.allowed) {
    return sendResponse(res, 429, { error: 'RATE_LIMITED' }, { 'Retry-After': String(rl.retryAfterSec) });
  }

  let body;
  try {
    body = await readJsonBody(req, 32 * 1024);
  } catch (err) {
    return sendResponse(res, err.statusCode || 400, { error: 'INVALID_BODY', message: err.message });
  }

  // Verify optional Supabase Bearer JWT (or token passed inside sendBeacon payload if header unavailable)
  let verifiedUser = await verifySupabaseUser(req);
  if (!verifiedUser && typeof body.accessToken === 'string' && body.accessToken.length >= 20) {
    verifiedUser = await verifySupabaseUser({
      headers: { authorization: `Bearer ${body.accessToken}` }
    });
  }

  const result = await recordHeartbeat(body, {
    verifiedUser,
    userAgent: req.headers['user-agent'] || ''
  });

  return sendResponse(res, 200, result);
}

/**
 * Admin Auth Endpoint: GET / POST / DELETE /api/admin/auth
 */
async function handleAdminAuthRequest(req, res) {
  const cors = applyAdminCors(req, res, 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') {
    return sendResponse(res, cors.allowed ? 204 : 403, '');
  }
  if (!cors.allowed) {
    return sendResponse(res, 403, { error: 'ORIGIN_NOT_ALLOWED' });
  }

  if (req.method === 'GET') {
    const check = await verifyAdminRequest(req);
    return sendResponse(res, 200, {
      authenticated: check.authenticated,
      admin: check.authenticated ? check.admin : null,
      reason: check.authenticated ? null : check.reason,
      config: getAdminAuthConfigStatus()
    });
  }

  if (req.method === 'POST') {
    let body;
    try {
      body = await readJsonBody(req, 16 * 1024);
    } catch (err) {
      return sendResponse(res, err.statusCode || 400, { error: 'INVALID_JSON', message: err.message });
    }

    const result = await handleAdminLogin(req, body);
    if (result.status === 200 && result.data?.authenticated) {
      await recordAdminAudit({
        adminIdentity: result.data.admin?.identity || 'admin',
        action: 'ADMIN_LOGIN',
        target: result.data.admin?.method || 'hybrid',
        details: { method: result.data.admin?.method },
        ipAddress: getClientIp(req)
      });
    }
    return sendResponse(res, result.status, result.data, result.headers || {});
  }

  if (req.method === 'DELETE') {
    const existing = await verifyAdminRequest(req);
    if (existing.authenticated) {
      await recordAdminAudit({
        adminIdentity: existing.admin.identity,
        action: 'ADMIN_LOGOUT',
        target: 'session',
        ipAddress: getClientIp(req)
      });
    }
    const result = handleAdminLogout(req);
    return sendResponse(res, result.status, result.data, result.headers || {});
  }

  return sendResponse(res, 405, { error: 'METHOD_NOT_ALLOWED' });
}

async function requireAdmin(req, res, methods = 'GET, OPTIONS') {
  const cors = applyAdminCors(req, res, methods);
  if (req.method === 'OPTIONS') {
    sendResponse(res, cors.allowed ? 204 : 403, '');
    return null;
  }
  if (!cors.allowed) {
    sendResponse(res, 403, { error: 'ORIGIN_NOT_ALLOWED' });
    return null;
  }
  const check = await verifyAdminRequest(req);
  if (!check.authenticated) {
    sendResponse(res, check.reason === 'NOT_ADMIN' ? 403 : 401, {
      error: check.reason || 'UNAUTHORIZED',
      message: check.message || 'Admin authentication required.'
    });
    return null;
  }
  return check.admin;
}

/**
 * GET /api/admin/overview
 */
async function handleAdminOverviewRequest(req, res) {
  const admin = await requireAdmin(req, res, 'GET, OPTIONS');
  if (!admin) return;
  if (req.method !== 'GET') return sendResponse(res, 405, { error: 'METHOD_NOT_ALLOWED' });

  try {
    const query = parseQuery(req);
    const data = await getOverviewPayload({ range: query.range || '24h' });
    return sendResponse(res, 200, data);
  } catch (err) {
    return sendResponse(res, 500, { error: 'OVERVIEW_ERROR', message: err.message });
  }
}

/**
 * GET /api/admin/users (or ?id=<uuid> for detail inspector)
 */
async function handleAdminUsersRequest(req, res) {
  const admin = await requireAdmin(req, res, 'GET, OPTIONS');
  if (!admin) return;
  if (req.method !== 'GET') return sendResponse(res, 405, { error: 'METHOD_NOT_ALLOWED' });

  try {
    const query = parseQuery(req);
    if (query.id) {
      const detail = await getUserDetailPayload(query.id);
      if (detail.error) {
        return sendResponse(res, detail.error === 'USER_NOT_FOUND' ? 404 : 400, detail);
      }
      return sendResponse(res, 200, detail);
    }

    const data = await getUsersPayload({
      search: query.search || '',
      status: query.status || 'all',
      provider: query.provider || 'all',
      sort: query.sort || 'lastSeen',
      order: query.order || 'desc',
      page: query.page || 1,
      pageSize: query.pageSize || 25
    });
    return sendResponse(res, 200, data);
  } catch (err) {
    return sendResponse(res, 500, { error: 'USERS_ERROR', message: err.message });
  }
}

/**
 * GET /api/admin/integrity
 */
async function handleAdminIntegrityRequest(req, res) {
  const admin = await requireAdmin(req, res, 'GET, OPTIONS');
  if (!admin) return;
  if (req.method !== 'GET') return sendResponse(res, 405, { error: 'METHOD_NOT_ALLOWED' });

  try {
    const data = await getDatabaseIntegrityPayload();
    return sendResponse(res, 200, data);
  } catch (err) {
    return sendResponse(res, 500, { error: 'INTEGRITY_ERROR', message: err.message });
  }
}

/**
 * GET / POST /api/admin/gemini
 */
async function handleAdminGeminiRequest(req, res) {
  const admin = await requireAdmin(req, res, 'GET, POST, OPTIONS');
  if (!admin) return;

  if (req.method === 'GET') {
    try {
      const query = parseQuery(req);
      const data = await getGeminiHealthPayload({ range: query.range || '24h' });
      return sendResponse(res, 200, data);
    } catch (err) {
      return sendResponse(res, 500, { error: 'GEMINI_TELEMETRY_ERROR', message: err.message });
    }
  }

  if (req.method === 'POST') {
    let body;
    try {
      body = await readJsonBody(req, 16 * 1024);
    } catch (err) {
      return sendResponse(res, err.statusCode || 400, { error: 'INVALID_JSON', message: err.message });
    }

    const action = String(body.action || '').toLowerCase();
    const model = typeof body.model === 'string' ? body.model.trim() : '';
    const ip = getClientIp(req);

    try {
      if (action === 'probe_model') {
        const result = await probeGeminiModel(model);
        await recordAdminAudit({
          adminIdentity: admin.identity,
          action: 'GEMINI_PROBE_MODEL',
          target: result.model,
          details: { ok: result.ok, status: result.status, latencyMs: result.latencyMs },
          ipAddress: ip
        });
        return sendResponse(res, 200, { result, health: getDetailedGeminiHealth() });
      }

      if (action === 'probe_all') {
        const result = await probeAllGeminiModels();
        await recordAdminAudit({
          adminIdentity: admin.identity,
          action: 'GEMINI_PROBE_ALL',
          target: `${result.results.length} models`,
          details: {
            healthy: result.results.filter(r => r.ok).length,
            total: result.results.length
          },
          ipAddress: ip
        });
        return sendResponse(res, 200, result);
      }

      if (action === 'reset_cooldown' && model) {
        resetModelCooldown(model);
        await recordAdminAudit({
          adminIdentity: admin.identity,
          action: 'GEMINI_RESET_COOLDOWN',
          target: model,
          ipAddress: ip
        });
        return sendResponse(res, 200, { ok: true, health: getDetailedGeminiHealth() });
      }

      if (action === 'trip_cooldown' && model) {
        markModelCooldown(model);
        await recordAdminAudit({
          adminIdentity: admin.identity,
          action: 'GEMINI_TRIP_COOLDOWN',
          target: model,
          ipAddress: ip
        });
        return sendResponse(res, 200, { ok: true, health: getDetailedGeminiHealth() });
      }

      if (action === 'clear_all_cooldowns') {
        clearModelCooldowns();
        await recordAdminAudit({
          adminIdentity: admin.identity,
          action: 'GEMINI_CLEAR_ALL_COOLDOWNS',
          target: 'all',
          ipAddress: ip
        });
        return sendResponse(res, 200, { ok: true, health: getDetailedGeminiHealth() });
      }

      return sendResponse(res, 400, { error: 'INVALID_ACTION', message: 'Unsupported Gemini admin action.' });
    } catch (err) {
      return sendResponse(res, 500, { error: 'GEMINI_ACTION_ERROR', message: err.message });
    }
  }

  return sendResponse(res, 405, { error: 'METHOD_NOT_ALLOWED' });
}

/**
 * GET /api/admin/telemetry (supports ?export=users|integrity|gemini|telemetry|full&format=csv|json)
 */
async function handleAdminTelemetryRequest(req, res) {
  const admin = await requireAdmin(req, res, 'GET, OPTIONS');
  if (!admin) return;
  if (req.method !== 'GET') return sendResponse(res, 405, { error: 'METHOD_NOT_ALLOWED' });

  try {
    const query = parseQuery(req);
    if (query.export) {
      const exported = await exportReportPayload({
        type: query.export,
        format: query.format || 'json',
        range: query.range || '30d'
      });
      await recordAdminAudit({
        adminIdentity: admin.identity,
        action: 'EXPORT_REPORT',
        target: `${query.export}.${query.format || 'json'}`,
        details: { type: query.export, format: query.format || 'json' },
        ipAddress: getClientIp(req)
      });
      return sendResponse(res, 200, exported.body, {
        'Content-Type': exported.contentType,
        'Content-Disposition': `attachment; filename="${exported.filename}"`
      });
    }

    const data = await getTelemetryDeepDivePayload({ range: query.range || '7d' });
    return sendResponse(res, 200, data);
  } catch (err) {
    return sendResponse(res, 500, { error: 'TELEMETRY_ERROR', message: err.message });
  }
}

module.exports = {
  handleTelemetryHeartbeatRequest,
  handleAdminAuthRequest,
  handleAdminOverviewRequest,
  handleAdminUsersRequest,
  handleAdminIntegrityRequest,
  handleAdminGeminiRequest,
  handleAdminTelemetryRequest
};
