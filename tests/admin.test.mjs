import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

const {
  signAdminSessionToken,
  verifyAdminSessionToken,
  handleAdminLogin,
  handleAdminLogout
} = require('../lib/admin-auth.js');
const {
  classifyPresence,
  sanitizeEventMetadata,
  recordHeartbeat,
  recordGeminiCall,
  getMemoryTelemetrySnapshot,
  resetMemoryTelemetryForTests
} = require('../lib/telemetry-store.js');
const {
  getDetailedGeminiHealth,
  markModelCooldown,
  resetModelCooldown,
  clearModelCooldowns
} = require('../lib/gemini.js');
const {
  csvCell,
  toCsv,
  buildOnlineTimelineSeries,
  buildUserGrowthSeries,
  buildActivityHeatmap,
  getOverviewPayload,
  getDatabaseIntegrityPayload,
  getGeminiHealthPayload,
  getTelemetryDeepDivePayload
} = require('../lib/admin-service.js');
const appServer = require('../server.js');

// --- 1. Hybrid Admin Auth & Signed Session Cookies ---

test('Admin HMAC session tokens verify validly and reject tampered payloads', () => {
  const token = signAdminSessionToken({ identity: 'ops@aifycycle.app', method: 'secret_key' });
  const verified = verifyAdminSessionToken(token);
  assert.ok(verified);
  assert.equal(verified.identity, 'ops@aifycycle.app');

  const [payload, sig] = token.split('.');
  const tampered = `${payload}.${sig.slice(0, -2)}AA`;
  assert.equal(verifyAdminSessionToken(tampered), null);
  assert.equal(verifyAdminSessionToken('invalid.token.extra'), null);
});

test('handleAdminLogin validates ADMIN_SECRET with timing-safe comparison and issues HttpOnly cookie', async () => {
  const prevSecret = process.env.ADMIN_SECRET;
  process.env.ADMIN_SECRET = 'test-super-secret-key-2026';
  try {
    const fakeReq = { headers: {}, socket: { remoteAddress: '127.0.0.10' } };

    const bad = await handleAdminLogin(fakeReq, { mode: 'secret', secret: 'wrong-secret' });
    assert.equal(bad.status, 401);

    const ok = await handleAdminLogin(fakeReq, { mode: 'secret', secret: 'test-super-secret-key-2026' });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.authenticated, true);
    assert.match(ok.headers['Set-Cookie'], /aify_admin_session=/);
    assert.match(ok.headers['Set-Cookie'], /HttpOnly/);
    assert.match(ok.headers['Set-Cookie'], /SameSite=Strict/);

    const out = handleAdminLogout(fakeReq);
    assert.equal(out.status, 200);
    assert.match(out.headers['Set-Cookie'], /Max-Age=0/);
  } finally {
    if (prevSecret === undefined) delete process.env.ADMIN_SECRET;
    else process.env.ADMIN_SECRET = prevSecret;
  }
});

// --- 2. Live Presence Classification & Privacy Sanitization ---

test('classifyPresence accurately separates Online (<=2m), Idle (2-5m), and Offline (>5m or exit beacon)', () => {
  const now = Date.now();
  assert.equal(classifyPresence(new Date(now - 30 * 1000).toISOString(), 'online', now), 'online');
  assert.equal(classifyPresence(new Date(now - 115 * 1000).toISOString(), 'online', now), 'online');
  assert.equal(classifyPresence(new Date(now - 150 * 1000).toISOString(), 'online', now), 'idle');
  assert.equal(classifyPresence(new Date(now - 6 * 60 * 1000).toISOString(), 'online', now), 'offline');
  assert.equal(classifyPresence(new Date(now - 2 * 1000).toISOString(), 'offline', now), 'offline');
});

test('sanitizeEventMetadata strips sensitive health fields while preserving operational metrics', () => {
  const clean = sanitizeEventMetadata({
    mode: 'server',
    latencyMs: 412.6,
    notes: 'private medical note should never pass',
    symptoms: ['Cramps'],
    flow: 'heavy',
    content: 'private chat transcript'
  });
  assert.deepEqual(clean, { mode: 'server', latencyMs: 413 });
});

test('recordHeartbeat tracks registered & guest concurrency, snapshots, and sanitized errors', async () => {
  resetMemoryTelemetryForTests();

  await recordHeartbeat(
    {
      sessionId: 'sess_reg_1',
      status: 'online',
      activeView: 'calendar',
      isGuest: false,
      provider: 'google',
      deviceType: 'mobile',
      events: [{ category: 'view', action: 'calendar', metadata: { latencyMs: 120, notes: 'SECRET' } }],
      errors: [{ errorType: 'runtime', message: 'Test client exception', source: 'app.js:42', viewName: 'calendar' }]
    },
    { verifiedUser: { id: '11111111-1111-4111-8111-111111111111', email: 'alice@example.com' } }
  );

  await recordHeartbeat(
    {
      sessionId: 'sess_guest_1',
      status: 'online',
      activeView: 'dial',
      isGuest: true,
      deviceType: 'desktop'
    },
    { verifiedUser: null }
  );

  const snap = getMemoryTelemetrySnapshot();
  assert.equal(snap.sessions.length, 2);
  assert.equal(snap.snapshots.length >= 1, true);
  assert.equal(snap.snapshots[snap.snapshots.length - 1].onlineTotal, 2);
  assert.equal(snap.snapshots[snap.snapshots.length - 1].onlineRegistered, 1);
  assert.equal(snap.snapshots[snap.snapshots.length - 1].onlineGuests, 1);
  assert.equal(snap.events.length, 1);
  assert.equal(snap.events[0].metadata.notes, undefined);
  assert.equal(snap.clientErrors.length, 1);
});

// --- 3. Gemini Detailed Health & Telemetry ---

test('Gemini detailed health tracks 5 cascade models, circuit breakers, and call telemetry', async () => {
  clearModelCooldowns();
  const initial = getDetailedGeminiHealth();
  assert.ok(initial.models.length >= 5);
  assert.equal(initial.models[0].role, 'primary');

  markModelCooldown(initial.configuredPrimary, 60000);
  const degraded = getDetailedGeminiHealth();
  assert.equal(degraded.models[0].coolingDown, true);
  assert.notEqual(degraded.activeModel, degraded.configuredPrimary);

  resetModelCooldown(initial.configuredPrimary);
  const recovered = getDetailedGeminiHealth();
  assert.equal(recovered.models[0].coolingDown, false);
  assert.equal(recovered.activeModel, recovered.configuredPrimary);

  recordGeminiCall({
    task: 'chat',
    requestedModel: 'gemini-3.8-flash',
    modelUsed: 'gemini-3.1-flash-lite',
    cascaded: true,
    attempts: 2,
    statusCode: 200,
    success: true,
    latencyMs: 840,
    totalTokens: 320
  });

  const gemPayload = await getGeminiHealthPayload({ range: '24h' });
  assert.ok(gemPayload.summary.totalCalls >= 1);
  assert.ok(gemPayload.recentCalls.some(c => c.cascaded === true && c.modelUsed === 'gemini-3.1-flash-lite'));
  clearModelCooldowns();
});

// --- 4. Chart Builders & Formula-Safe CSV Exports ---

test('Chart builders produce continuous online timelines, growth curves, and 7x24 heatmaps', () => {
  const timeline = buildOnlineTimelineSeries([], { total: 3, registered: 2, guests: 1 }, '24h');
  assert.equal(timeline.length, 24);
  assert.equal(timeline[timeline.length - 1].onlineTotal, 3);

  const nowIso = new Date().toISOString();
  const growth = buildUserGrowthSeries(
    [{ id: 'u1', createdAt: nowIso, lastSeenAt: nowIso }],
    [],
    7
  );
  assert.equal(growth.length, 7);
  assert.equal(growth[growth.length - 1].totalUsers, 1);
  assert.equal(growth[growth.length - 1].newSignups, 1);

  const heatmap = buildActivityHeatmap([{ lastSeenAt: nowIso }], []);
  assert.equal(heatmap.matrix.length, 7);
  assert.equal(heatmap.matrix[0].length, 24);
  assert.equal(heatmap.max, 1);
});

test('CSV export neutralizes spreadsheet formula injection', () => {
  assert.equal(csvCell('=HYPERLINK("http://evil")'), `"'=HYPERLINK(""http://evil"")"`);
  assert.equal(csvCell('+1+1'), `'+1+1`);
  assert.equal(csvCell('normal@email.com'), 'normal@email.com');
  const csv = toCsv(['name', 'formula'], [{ name: 'Alice', formula: '=CMD()' }]);
  assert.match(csv, /'=CMD\(\)/);
});

// --- 5. Admin HTML, CSS & No-Emoji Standards ---

test('Admin UI obeys GPU compositor safety, defined CSS vars, noindex, and zero platform emojis', () => {
  const css = fs.readFileSync(path.join(root, 'css', 'admin.css'), 'utf8');
  assert.doesNotMatch(css, /backdrop-filter\s*:/i);
  assert.doesNotMatch(css, /filter\s*:\s*blur\(/i);

  const definedVars = new Set([...css.matchAll(/(--[a-zA-Z0-9_-]+)\s*:/g)].map(m => m[1]));
  const usedVars = [...new Set([...css.matchAll(/var\((--[a-zA-Z0-9_-]+)/g)].map(m => m[1]))];
  const missingVars = usedVars.filter(v => !definedVars.has(v));
  assert.deepEqual(missingVars, [], `Undefined admin CSS variables: ${missingVars.join(', ')}`);

  const adminHtml = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
  assert.match(adminHtml, /<meta\s+name="robots"\s+content="noindex,\s*nofollow">/);

  const emojiRe = /\p{Extended_Pictographic}/u;
  for (const rel of ['admin.html', 'css/admin.css', 'js/admin-app.js', 'js/admin-charts.js', 'js/analytics-tracker.js']) {
    const content = fs.readFileSync(path.join(root, rel), 'utf8');
    assert.equal(emojiRe.test(content), false, `Unexpected emoji in ${rel}`);
  }
});

// --- 6. Live HTTP End-to-End Integration Test ---

function httpRequest(port, method, reqPath, { body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path: reqPath, headers }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body !== null) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

test('End-to-end HTTP flow: /admin route, heartbeat ingestion, hybrid auth cookie, and protected admin APIs', async () => {
  const prevSecret = process.env.ADMIN_SECRET;
  process.env.ADMIN_SECRET = 'e2e-admin-secret-key';
  resetMemoryTelemetryForTests();

  const srv = http.createServer(appServer.listeners('request')[0]);
  await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();

  try {
    // 1. /admin serves admin.html
    const pageRes = await httpRequest(port, 'GET', '/admin');
    assert.equal(pageRes.status, 200);
    assert.match(pageRes.body, /AifyCycle Ops/);

    // 2. Unauthenticated /api/admin/overview is rejected with 401
    const unauth = await httpRequest(port, 'GET', '/api/admin/overview');
    assert.equal(unauth.status, 401);

    // 3. Client sends a live guest heartbeat
    const hbRes = await httpRequest(port, 'POST', '/api/telemetry/heartbeat', {
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (Macintosh) Chrome/130.0' },
      body: { sessionId: 'sess_e2e_guest', status: 'online', activeView: 'ai-coach', isGuest: true }
    });
    assert.equal(hbRes.status, 200);
    assert.equal(JSON.parse(hbRes.body).ok, true);

    // 4. Sign in via POST /api/admin/auth with secret key
    const loginRes = await httpRequest(port, 'POST', '/api/admin/auth', {
      headers: { 'Content-Type': 'application/json' },
      body: { mode: 'secret', secret: 'e2e-admin-secret-key' }
    });
    assert.equal(loginRes.status, 200);
    const setCookie = loginRes.headers['set-cookie'];
    assert.ok(setCookie && setCookie.length > 0);
    const cookieHeader = setCookie[0].split(';')[0];

    // 5. Fetch all admin endpoints with signed session cookie
    const ovRes = await httpRequest(port, 'GET', '/api/admin/overview?range=24h', { headers: { Cookie: cookieHeader } });
    assert.equal(ovRes.status, 200);
    const ov = JSON.parse(ovRes.body);
    assert.equal(ov.kpis.onlineNow.guests, 1);
    assert.equal(ov.kpis.onlineNow.total, 1);

    const usrRes = await httpRequest(port, 'GET', '/api/admin/users', { headers: { Cookie: cookieHeader } });
    assert.equal(usrRes.status, 200);
    assert.equal(JSON.parse(usrRes.body).summary.onlineGuests, 1);

    const intRes = await httpRequest(port, 'GET', '/api/admin/integrity', { headers: { Cookie: cookieHeader } });
    assert.equal(intRes.status, 200);
    assert.ok(Array.isArray(JSON.parse(intRes.body).checks));

    const gemRes = await httpRequest(port, 'GET', '/api/admin/gemini', { headers: { Cookie: cookieHeader } });
    assert.equal(gemRes.status, 200);
    assert.ok(JSON.parse(gemRes.body).models.length >= 5);

    const telRes = await httpRequest(port, 'GET', '/api/admin/telemetry?range=7d', { headers: { Cookie: cookieHeader } });
    assert.equal(telRes.status, 200);
    assert.ok(JSON.parse(telRes.body).runtime.nodeVersion);

    const csvRes = await httpRequest(port, 'GET', '/api/admin/telemetry?export=users&format=csv', { headers: { Cookie: cookieHeader } });
    assert.equal(csvRes.status, 200);
    assert.match(csvRes.headers['content-type'], /text\/csv/);
    assert.match(csvRes.headers['content-disposition'], /aifycycle-users-/);
  } finally {
    await new Promise(resolve => srv.close(resolve));
    if (prevSecret === undefined) delete process.env.ADMIN_SECRET;
    else process.env.ADMIN_SECRET = prevSecret;
  }
});
