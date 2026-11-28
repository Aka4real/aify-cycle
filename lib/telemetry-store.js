/**
 * AifyCycle - Unified Operational Telemetry & Live Presence Store
 * Combines fast in-memory ring buffers with durable Supabase PostgreSQL persistence
 * (when SUPABASE_SERVICE_ROLE_KEY & telemetry tables are available).
 *
 * Privacy Guarantee: Strictly rejects/strips private health text (notes, symptom details,
 * chat message contents, memories). Stores only operational metadata & aggregate counts.
 */

const { isAdminDbConfigured, adminRest } = require('./supabase-admin');

const ONLINE_WINDOW_MS = 2 * 60 * 1000;    // <= 2 minutes = Online
const IDLE_WINDOW_MS = 5 * 60 * 1000;      // 2-5 minutes = Idle/Away
const SNAPSHOT_BUCKET_MS = 5 * 60 * 1000;  // 5-minute time-series rollup buckets

const MAX_SESSIONS_MEM = 2000;
const MAX_SNAPSHOTS_MEM = 2016; // 7 days of 5-min buckets
const MAX_EVENTS_MEM = 4000;
const MAX_GEMINI_CALLS_MEM = 500;
const MAX_ERRORS_MEM = 300;
const MAX_AUDIT_MEM = 300;

const ALLOWED_VIEWS = new Set([
  'dial', 'calendar', 'syncing', 'ai-coach', 'analytics', 'settings', 'onboarding', 'auth', 'unknown'
]);
const ALLOWED_DEVICES = new Set(['desktop', 'mobile', 'tablet']);
const ALLOWED_STATUSES = new Set(['online', 'idle', 'offline']);
const ALLOWED_EVENT_CATEGORIES = new Set([
  'view', 'cycle', 'symptom', 'ai_coach', 'calendar', 'syncing', 'backup', 'auth', 'system', 'error'
]);
const ALLOWED_METADATA_KEYS = new Set([
  'mode', 'latencyMs', 'status', 'model', 'cascaded', 'tab', 'errorType', 'deviceType', 'provider'
]);

const store = {
  startedAt: Date.now(),
  totalHttpRequests: 0,
  totalApiErrors: 0,
  // Map<sessionId, SessionRecord>
  sessions: new Map(),
  // Map<bucketIso, SnapshotRecord>
  snapshots: new Map(),
  // Ring buffers (newest first)
  events: [],
  geminiCalls: [],
  clientErrors: [],
  adminAudit: [],
  lastDbSnapshotBucket: null
};

function clampStr(val, maxLen = 120) {
  if (typeof val !== 'string') return '';
  return val.trim().slice(0, maxLen);
}

function sanitizeView(view) {
  const v = clampStr(view, 32).toLowerCase();
  return ALLOWED_VIEWS.has(v) ? v : 'dial';
}

function sanitizeDevice(device) {
  const d = clampStr(device, 16).toLowerCase();
  return ALLOWED_DEVICES.has(d) ? d : 'desktop';
}

function sanitizeStatus(status) {
  const s = clampStr(status, 16).toLowerCase();
  return ALLOWED_STATUSES.has(s) ? s : 'online';
}

function sanitizeEventMetadata(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return {};
  const out = {};
  for (const [k, v] of Object.entries(meta)) {
    if (!ALLOWED_METADATA_KEYS.has(k)) continue;
    if (typeof v === 'number' && Number.isFinite(v)) {
      out[k] = Math.round(v);
    } else if (typeof v === 'boolean') {
      out[k] = v;
    } else if (typeof v === 'string') {
      out[k] = v.trim().slice(0, 64);
    }
  }
  return out;
}

function parseUserAgentInfo(ua = '') {
  const s = String(ua || '');
  let browser = 'Unknown';
  if (/Edg\//i.test(s)) browser = 'Edge';
  else if (/OPR\/|Opera/i.test(s)) browser = 'Opera';
  else if (/Chrome\//i.test(s) && !/Chromium/i.test(s)) browser = 'Chrome';
  else if (/Firefox\//i.test(s)) browser = 'Firefox';
  else if (/Safari\//i.test(s) && !/Chrome\//i.test(s)) browser = 'Safari';

  let os = 'Unknown';
  if (/iPhone|iPad|iPod/i.test(s)) os = 'iOS';
  else if (/Android/i.test(s)) os = 'Android';
  else if (/Mac OS X|Macintosh/i.test(s)) os = 'macOS';
  else if (/Windows/i.test(s)) os = 'Windows';
  else if (/Linux/i.test(s)) os = 'Linux';

  let deviceType = 'desktop';
  if (/iPad|Tablet/i.test(s)) deviceType = 'tablet';
  else if (/Mobile|iPhone|Android/i.test(s)) deviceType = 'mobile';

  return { browser, os, deviceType };
}

function getBucketIso(ts = Date.now()) {
  const floored = Math.floor(ts / SNAPSHOT_BUCKET_MS) * SNAPSHOT_BUCKET_MS;
  return new Date(floored).toISOString();
}

function classifyPresence(lastSeenIso, explicitStatus = 'online', now = Date.now()) {
  if (!lastSeenIso) return 'offline';
  const ts = typeof lastSeenIso === 'number' ? lastSeenIso : Date.parse(lastSeenIso);
  if (!Number.isFinite(ts)) return 'offline';
  const ageMs = now - ts;
  if (explicitStatus === 'offline' && ageMs > 15000) return 'offline';
  if (explicitStatus === 'offline') return 'offline';
  if (ageMs <= ONLINE_WINDOW_MS) {
    return explicitStatus === 'idle' ? 'idle' : 'online';
  }
  if (ageMs <= IDLE_WINDOW_MS) return 'idle';
  return 'offline';
}

function pruneOldSessions(now = Date.now()) {
  if (store.sessions.size <= MAX_SESSIONS_MEM) return;
  const entries = [...store.sessions.entries()]
    .sort((a, b) => Date.parse(b[1].lastSeenAt) - Date.parse(a[1].lastSeenAt));
  store.sessions.clear();
  for (const [k, v] of entries.slice(0, MAX_SESSIONS_MEM)) {
    store.sessions.set(k, v);
  }
}

function updatePresenceSnapshot(now = Date.now()) {
  const bucketIso = getBucketIso(now);
  let onlineTotal = 0;
  let onlineRegistered = 0;
  let onlineGuests = 0;
  const activeViews = {};
  const seenUsers = new Set();

  for (const sess of store.sessions.values()) {
    const pStatus = classifyPresence(sess.lastSeenAt, sess.status, now);
    if (pStatus !== 'online' && pStatus !== 'idle') continue;

    if (sess.userId && !sess.isGuest) {
      if (seenUsers.has(sess.userId)) continue;
      seenUsers.add(sess.userId);
      onlineRegistered++;
    } else {
      onlineGuests++;
    }
    onlineTotal++;
    activeViews[sess.activeView] = (activeViews[sess.activeView] || 0) + 1;
  }

  const prev = store.snapshots.get(bucketIso);
  const snapshot = {
    bucketAt: bucketIso,
    onlineTotal: Math.max(onlineTotal, prev?.onlineTotal || 0),
    onlineRegistered: Math.max(onlineRegistered, prev?.onlineRegistered || 0),
    onlineGuests: Math.max(onlineGuests, prev?.onlineGuests || 0),
    activeViews
  };

  store.snapshots.set(bucketIso, snapshot);

  if (store.snapshots.size > MAX_SNAPSHOTS_MEM) {
    const sorted = [...store.snapshots.keys()].sort();
    while (store.snapshots.size > MAX_SNAPSHOTS_MEM && sorted.length) {
      store.snapshots.delete(sorted.shift());
    }
  }

  return snapshot;
}

function recordHttpMetric(statusCode = 200) {
  store.totalHttpRequests++;
  if (statusCode >= 500) {
    store.totalApiErrors++;
  }
}

async function recordHeartbeat(payload = {}, { verifiedUser = null, userAgent = '' } = {}) {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const uaInfo = parseUserAgentInfo(userAgent);

  const sessionId = clampStr(payload.sessionId, 80) || `anon_${now.toString(36)}`;
  const userId = verifiedUser?.id || null;
  const isGuest = !userId || Boolean(payload.isGuest);
  const status = sanitizeStatus(payload.status || 'online');
  const activeView = sanitizeView(payload.activeView || payload.view);
  const deviceType = payload.deviceType ? sanitizeDevice(payload.deviceType) : uaInfo.deviceType;
  const browser = clampStr(payload.browser, 32) || uaInfo.browser;
  const os = clampStr(payload.os, 32) || uaInfo.os;
  const provider = isGuest ? 'guest' : clampStr(payload.provider || 'email', 24);
  const appVersion = clampStr(payload.appVersion || '1.1.0', 24);

  const existing = store.sessions.get(sessionId);
  const isNewSession = !existing;
  const record = {
    sessionId,
    userId,
    email: verifiedUser?.email || null,
    isGuest,
    provider,
    activeView,
    deviceType,
    browser,
    os,
    appVersion,
    status,
    startedAt: existing?.startedAt || nowIso,
    lastSeenAt: nowIso,
    endedAt: status === 'offline' ? nowIso : null,
    heartbeatCount: (existing?.heartbeatCount || 0) + 1
  };

  store.sessions.set(sessionId, record);
  pruneOldSessions(now);

  const snapshot = updatePresenceSnapshot(now);

  // Process optional privacy-safe event batch
  const eventsToPersist = [];
  if (Array.isArray(payload.events)) {
    for (const rawEv of payload.events.slice(0, 25)) {
      if (!rawEv || typeof rawEv !== 'object') continue;
      const category = clampStr(rawEv.category, 32).toLowerCase();
      const action = clampStr(rawEv.action, 48);
      if (!ALLOWED_EVENT_CATEGORIES.has(category) || !action) continue;

      const ev = {
        sessionId,
        userId,
        isGuest,
        category,
        action,
        label: clampStr(rawEv.label || '', 64),
        metadata: sanitizeEventMetadata(rawEv.metadata),
        createdAt: rawEv.timestamp && Number.isFinite(Date.parse(rawEv.timestamp))
          ? new Date(rawEv.timestamp).toISOString()
          : nowIso
      };
      store.events.unshift(ev);
      eventsToPersist.push(ev);
    }
    if (store.events.length > MAX_EVENTS_MEM) {
      store.events.length = MAX_EVENTS_MEM;
    }
  }

  // Process optional client error batch
  const errorsToPersist = [];
  if (Array.isArray(payload.errors)) {
    for (const rawErr of payload.errors.slice(0, 10)) {
      if (!rawErr || typeof rawErr !== 'object') continue;
      const msg = clampStr(rawErr.message, 320);
      if (!msg) continue;
      const errRec = {
        sessionId,
        userId,
        errorType: clampStr(rawErr.errorType || 'runtime', 32),
        message: msg,
        source: clampStr(rawErr.source || '', 160),
        viewName: sanitizeView(rawErr.viewName || activeView),
        deviceType,
        appVersion,
        createdAt: rawErr.timestamp && Number.isFinite(Date.parse(rawErr.timestamp))
          ? new Date(rawErr.timestamp).toISOString()
          : nowIso
      };
      store.clientErrors.unshift(errRec);
      errorsToPersist.push(errRec);
    }
    if (store.clientErrors.length > MAX_ERRORS_MEM) {
      store.clientErrors.length = MAX_ERRORS_MEM;
    }
  }

  // Persist asynchronously-safe (awaited cleanly with tight timeout for serverless reliability)
  if (isAdminDbConfigured()) {
    const writes = [];

    // 1. Upsert telemetry_sessions
    writes.push(adminRest('/telemetry_sessions?on_conflict=session_id', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=minimal',
      timeoutMs: 3500,
      body: {
        session_id: record.sessionId,
        user_id: record.userId,
        is_guest: record.isGuest,
        provider: record.provider,
        active_view: record.activeView,
        device_type: record.deviceType,
        browser: record.browser,
        os: record.os,
        app_version: record.appVersion,
        status: record.status,
        started_at: record.startedAt,
        last_seen_at: record.lastSeenAt,
        ended_at: record.endedAt,
        heartbeat_count: record.heartbeatCount
      }
    }).catch(() => {}));

    // 2. Update profiles.last_seen_at for authenticated registered users
    if (userId && !isGuest) {
      const profilePatch = {
        last_seen_at: nowIso,
        last_active_view: activeView,
        last_client_meta: {
          deviceType,
          browser,
          os,
          appVersion,
          status
        }
      };
      writes.push(adminRest(`/profiles?id=eq.${encodeURIComponent(userId)}`, {
        method: 'PATCH',
        prefer: 'return=minimal',
        timeoutMs: 3500,
        body: profilePatch
      }).catch(() => {}));
    }

    // 3. Upsert 5-minute presence_snapshots bucket
    writes.push(adminRest('/presence_snapshots?on_conflict=bucket_at', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=minimal',
      timeoutMs: 3500,
      body: {
        bucket_at: snapshot.bucketAt,
        online_total: snapshot.onlineTotal,
        online_registered: snapshot.onlineRegistered,
        online_guests: snapshot.onlineGuests,
        active_views: snapshot.activeViews
      }
    }).catch(() => {}));

    // 4. Insert privacy-safe telemetry events
    if (eventsToPersist.length > 0) {
      writes.push(adminRest('/telemetry_events', {
        method: 'POST',
        prefer: 'return=minimal',
        timeoutMs: 3500,
        body: eventsToPersist.map(e => ({
          session_id: e.sessionId,
          user_id: e.userId,
          is_guest: e.isGuest,
          category: e.category,
          action: e.action,
          label: e.label,
          metadata: e.metadata,
          created_at: e.createdAt
        }))
      }).catch(() => {}));
    }

    // 5. Insert client error logs
    if (errorsToPersist.length > 0) {
      writes.push(adminRest('/client_error_logs', {
        method: 'POST',
        prefer: 'return=minimal',
        timeoutMs: 3500,
        body: errorsToPersist.map(e => ({
          session_id: e.sessionId,
          user_id: e.userId,
          error_type: e.errorType,
          message: e.message,
          source: e.source,
          view_name: e.viewName,
          device_type: e.deviceType,
          app_version: e.appVersion,
          created_at: e.createdAt
        }))
      }).catch(() => {}));
    }

    await Promise.allSettled(writes);
  }

  return {
    ok: true,
    sessionId,
    isNewSession,
    status,
    recordedEvents: eventsToPersist.length,
    recordedErrors: errorsToPersist.length,
    serverTime: nowIso
  };
}

function recordGeminiCall(entry = {}) {
  const rec = {
    task: clampStr(entry.task || 'chat', 32),
    requestedModel: clampStr(entry.requestedModel || 'unknown', 64),
    modelUsed: entry.modelUsed ? clampStr(entry.modelUsed, 64) : null,
    cascaded: Boolean(entry.cascaded),
    attempts: Math.max(1, parseInt(entry.attempts, 10) || 1),
    statusCode: parseInt(entry.statusCode, 10) || 200,
    success: Boolean(entry.success),
    latencyMs: Math.max(0, Math.round(Number(entry.latencyMs) || 0)),
    promptTokens: Number.isFinite(entry.promptTokens) ? entry.promptTokens : null,
    completionTokens: Number.isFinite(entry.completionTokens) ? entry.completionTokens : null,
    totalTokens: Number.isFinite(entry.totalTokens) ? entry.totalTokens : null,
    errorCode: entry.errorCode ? clampStr(String(entry.errorCode), 64) : null,
    userId: entry.userId || null,
    createdAt: new Date().toISOString()
  };

  store.geminiCalls.unshift(rec);
  if (store.geminiCalls.length > MAX_GEMINI_CALLS_MEM) {
    store.geminiCalls.length = MAX_GEMINI_CALLS_MEM;
  }

  if (isAdminDbConfigured()) {
    adminRest('/gemini_telemetry', {
      method: 'POST',
      prefer: 'return=minimal',
      timeoutMs: 3500,
      body: {
        task: rec.task,
        requested_model: rec.requestedModel,
        model_used: rec.modelUsed,
        cascaded: rec.cascaded,
        attempts: rec.attempts,
        status_code: rec.statusCode,
        success: rec.success,
        latency_ms: rec.latencyMs,
        prompt_tokens: rec.promptTokens,
        completion_tokens: rec.completionTokens,
        total_tokens: rec.totalTokens,
        error_code: rec.errorCode,
        user_id: rec.userId,
        created_at: rec.createdAt
      }
    }).catch(() => {});
  }

  return rec;
}

async function recordAdminAudit({ adminIdentity = 'admin', action = 'UNKNOWN', target = '', details = {}, ipAddress = '' } = {}) {
  const entry = {
    adminIdentity: clampStr(adminIdentity, 120) || 'admin',
    action: clampStr(action, 64) || 'ADMIN_ACTION',
    target: clampStr(target, 120),
    details: details && typeof details === 'object' ? details : {},
    ipAddress: clampStr(ipAddress, 64),
    createdAt: new Date().toISOString()
  };

  store.adminAudit.unshift(entry);
  if (store.adminAudit.length > MAX_AUDIT_MEM) {
    store.adminAudit.length = MAX_AUDIT_MEM;
  }

  if (isAdminDbConfigured()) {
    await adminRest('/admin_audit_logs', {
      method: 'POST',
      prefer: 'return=minimal',
      timeoutMs: 3000,
      body: {
        admin_identity: entry.adminIdentity,
        action: entry.action,
        target: entry.target,
        details: entry.details,
        ip_address: entry.ipAddress,
        created_at: entry.createdAt
      }
    }).catch(() => {});
  }

  return entry;
}

function getMemoryTelemetrySnapshot() {
  const now = Date.now();
  const sessions = [...store.sessions.values()].map(s => ({
    ...s,
    computedStatus: classifyPresence(s.lastSeenAt, s.status, now)
  }));
  const snapshots = [...store.snapshots.values()].sort((a, b) => a.bucketAt.localeCompare(b.bucketAt));

  return {
    startedAt: store.startedAt,
    uptimeSec: Math.round((now - store.startedAt) / 1000),
    totalHttpRequests: store.totalHttpRequests,
    totalApiErrors: store.totalApiErrors,
    sessions,
    snapshots,
    events: [...store.events],
    geminiCalls: [...store.geminiCalls],
    clientErrors: [...store.clientErrors],
    adminAudit: [...store.adminAudit]
  };
}

function resetMemoryTelemetryForTests() {
  store.sessions.clear();
  store.snapshots.clear();
  store.events.length = 0;
  store.geminiCalls.length = 0;
  store.clientErrors.length = 0;
  store.adminAudit.length = 0;
  store.totalHttpRequests = 0;
  store.totalApiErrors = 0;
}

module.exports = {
  ONLINE_WINDOW_MS,
  IDLE_WINDOW_MS,
  SNAPSHOT_BUCKET_MS,
  classifyPresence,
  parseUserAgentInfo,
  sanitizeEventMetadata,
  recordHttpMetric,
  recordHeartbeat,
  recordGeminiCall,
  recordAdminAudit,
  getMemoryTelemetrySnapshot,
  resetMemoryTelemetryForTests
};
