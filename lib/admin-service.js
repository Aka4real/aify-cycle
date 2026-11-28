/**
 * AifyCycle - Admin Intelligence, Telemetry Aggregation & DB Integrity Engine
 *
 * Strictly enforces the privacy-first operational boundary:
 * - Surfaces account metadata, presence/last-seen, aggregate record counts,
 *   Gemini model telemetry, PostgreSQL integrity diagnostics, and anonymized product analytics.
 * - NEVER queries or returns private cycle notes, symptom lists, moods, flow logs,
 *   AI memory facts, or AI chat message text.
 */

const {
  getSupabaseAdminConfig,
  isAdminDbConfigured,
  adminRest,
  adminRpc,
  countTableRows,
  listAllAuthUsers,
  getAuthUserById,
  checkSupabaseHealth
} = require('./supabase-admin');
const {
  ONLINE_WINDOW_MS,
  IDLE_WINDOW_MS,
  classifyPresence,
  getMemoryTelemetrySnapshot
} = require('./telemetry-store');
const { getDetailedGeminiHealth } = require('./gemini');
const { getSecurityRuntimeStats } = require('./http-security');
const { getAdminAuthConfigStatus } = require('./admin-auth');

const CORE_TABLES = [
  'profiles',
  'cycle_logs',
  'ai_memories',
  'ai_chat_history',
  'partner_shares',
  'legacy_user_imports'
];

const TELEMETRY_TABLES = [
  'telemetry_sessions',
  'presence_snapshots',
  'telemetry_events',
  'gemini_telemetry',
  'client_error_logs',
  'admin_audit_logs'
];

const ALL_EXPECTED_TABLES = [...CORE_TABLES, ...TELEMETRY_TABLES];

const USER_POLICY_TABLES = new Set([
  'profiles',
  'cycle_logs',
  'ai_memories',
  'ai_chat_history',
  'partner_shares'
]);

const RANGE_MS = {
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  '90d': 90 * 24 * 60 * 60 * 1000
};

function parseRange(rangeStr, fallback = '24h') {
  const key = String(rangeStr || fallback).toLowerCase();
  return RANGE_MS[key] ? { key, ms: RANGE_MS[key] } : { key: fallback, ms: RANGE_MS[fallback] };
}

function safeIso(val) {
  if (!val) return null;
  const ts = Date.parse(val);
  return Number.isFinite(ts) ? new Date(ts).toISOString() : null;
}

function dayKeyUtc(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

function formatBytes(bytes) {
  const b = Number(bytes) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(2)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function computePercentile(values, p) {
  if (!values || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function csvCell(value) {
  let str = value === null || value === undefined ? '' : String(value);
  // Neutralize spreadsheet formula injection
  if (/^[=+\-@\t\r]/.test(str)) {
    str = `'${str}`;
  }
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function toCsv(headers, rows) {
  const headLine = headers.map(csvCell).join(',');
  const bodyLines = rows.map(row => headers.map(h => csvCell(row[h])).join(','));
  return [headLine, ...bodyLines].join('\n');
}

/**
 * Load unified user + presence + safe aggregate counts dataset
 */
async function loadUnifiedUsersAndSessions() {
  const now = Date.now();
  const mem = getMemoryTelemetrySnapshot();
  const dbEnabled = isAdminDbConfigured();

  let authUsers = [];
  let authUsersError = null;
  let profiles = [];
  let dbSessions = [];
  let logCounts = new Map();
  let memoryCounts = new Map();
  let chatCounts = new Map();
  let shareCounts = new Map();
  let totalCounts = {
    profiles: 0,
    cycle_logs: 0,
    ai_memories: 0,
    ai_chat_history: 0,
    partner_shares: 0
  };

  if (dbEnabled) {
    const [
      authRes,
      profilesRes,
      sessionsRes,
      logsRes,
      memoriesRes,
      chatsRes,
      sharesRes
    ] = await Promise.all([
      listAllAuthUsers({ maxPages: 10, perPage: 200 }),
      // Strictly select non-sensitive operational profile columns (never private partner notes)
      adminRest('/profiles?select=id,user_name,telemetry_enabled,created_at,updated_at,last_seen_at,last_active_view,last_client_meta,is_admin,session_count&limit=2000', { timeoutMs: 8000 })
        .then(async r => {
          // Graceful fallback if new migration columns don't exist yet
          if (!r.ok && r.status === 400) {
            return adminRest('/profiles?select=id,user_name,telemetry_enabled,created_at,updated_at&limit=2000', { timeoutMs: 8000 });
          }
          return r;
        }),
      adminRest('/telemetry_sessions?select=session_id,user_id,is_guest,provider,active_view,device_type,browser,os,app_version,status,started_at,last_seen_at,ended_at,heartbeat_count&order=last_seen_at.desc&limit=1000', { timeoutMs: 6000 }),
      // Select ONLY user_id for aggregate per-user record counts — ZERO health values!
      adminRest('/cycle_logs?select=user_id&limit=10000', { prefer: 'count=exact', timeoutMs: 7000 }),
      adminRest('/ai_memories?select=user_id&limit=10000', { prefer: 'count=exact', timeoutMs: 7000 }),
      adminRest('/ai_chat_history?select=user_id&limit=10000', { prefer: 'count=exact', timeoutMs: 7000 }),
      adminRest('/partner_shares?select=owner_id,status&limit=5000', { prefer: 'count=exact', timeoutMs: 7000 })
    ]);

    if (authRes.ok) {
      authUsers = authRes.users;
    } else {
      authUsersError = authRes.error;
    }

    if (profilesRes.ok && Array.isArray(profilesRes.data)) {
      profiles = profilesRes.data;
      totalCounts.profiles = profiles.length;
    }

    if (sessionsRes.ok && Array.isArray(sessionsRes.data)) {
      dbSessions = sessionsRes.data.map(s => ({
        sessionId: s.session_id,
        userId: s.user_id,
        isGuest: Boolean(s.is_guest),
        provider: s.provider || 'guest',
        activeView: s.active_view || 'dial',
        deviceType: s.device_type || 'desktop',
        browser: s.browser || 'Unknown',
        os: s.os || 'Unknown',
        appVersion: s.app_version || '1.1.0',
        status: s.status || 'online',
        startedAt: s.started_at,
        lastSeenAt: s.last_seen_at,
        endedAt: s.ended_at,
        heartbeatCount: s.heartbeat_count || 1
      }));
    }

    if (logsRes.ok && Array.isArray(logsRes.data)) {
      totalCounts.cycle_logs = logsRes.count ?? logsRes.data.length;
      for (const row of logsRes.data) {
        if (row.user_id) logCounts.set(row.user_id, (logCounts.get(row.user_id) || 0) + 1);
      }
    }
    if (memoriesRes.ok && Array.isArray(memoriesRes.data)) {
      totalCounts.ai_memories = memoriesRes.count ?? memoriesRes.data.length;
      for (const row of memoriesRes.data) {
        if (row.user_id) memoryCounts.set(row.user_id, (memoryCounts.get(row.user_id) || 0) + 1);
      }
    }
    if (chatsRes.ok && Array.isArray(chatsRes.data)) {
      totalCounts.ai_chat_history = chatsRes.count ?? chatsRes.data.length;
      for (const row of chatsRes.data) {
        if (row.user_id) chatCounts.set(row.user_id, (chatCounts.get(row.user_id) || 0) + 1);
      }
    }
    if (sharesRes.ok && Array.isArray(sharesRes.data)) {
      totalCounts.partner_shares = sharesRes.count ?? sharesRes.data.length;
      for (const row of sharesRes.data) {
        if (row.owner_id) shareCounts.set(row.owner_id, (shareCounts.get(row.owner_id) || 0) + 1);
      }
    }
  }

  // Merge DB sessions + in-memory sessions (latest heartbeat wins)
  const mergedSessionsMap = new Map();
  for (const s of dbSessions) {
    mergedSessionsMap.set(s.sessionId, s);
  }
  for (const s of mem.sessions) {
    const existing = mergedSessionsMap.get(s.sessionId);
    if (!existing || Date.parse(s.lastSeenAt) >= Date.parse(existing.lastSeenAt || 0)) {
      mergedSessionsMap.set(s.sessionId, s);
    }
  }

  const allSessions = [...mergedSessionsMap.values()].map(s => ({
    ...s,
    computedStatus: classifyPresence(s.lastSeenAt, s.status, now)
  }));

  // Index sessions by userId (newest first)
  const sessionsByUser = new Map();
  const guestSessions = [];
  for (const s of allSessions) {
    if (s.userId && !s.isGuest) {
      if (!sessionsByUser.has(s.userId)) sessionsByUser.set(s.userId, []);
      sessionsByUser.get(s.userId).push(s);
    } else {
      guestSessions.push(s);
    }
  }
  for (const list of sessionsByUser.values()) {
    list.sort((a, b) => Date.parse(b.lastSeenAt || 0) - Date.parse(a.lastSeenAt || 0));
  }
  guestSessions.sort((a, b) => Date.parse(b.lastSeenAt || 0) - Date.parse(a.lastSeenAt || 0));

  const profileMap = new Map(profiles.map(p => [p.id, p]));
  const adminAllowlist = (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);

  // Merge registered auth.users + profiles + any live authenticated in-memory sessions
  const usersById = new Map();

  for (const u of authUsers) {
    const p = profileMap.get(u.id) || null;
    const uSessions = sessionsByUser.get(u.id) || [];
    const latestSess = uSessions[0] || null;
    const meta = u.user_metadata || {};
    const appMeta = u.app_metadata || {};
    const isAnonymous = Boolean(u.is_anonymous);
    const provider = isAnonymous
      ? 'anonymous'
      : (appMeta.provider || (Array.isArray(appMeta.providers) && appMeta.providers[0]) || 'email');

    // Determine most accurate lastSeenAt & its source
    const candidates = [
      { ts: latestSess?.lastSeenAt, source: 'live_heartbeat', explicitStatus: latestSess?.status },
      { ts: p?.last_seen_at, source: 'profile_heartbeat', explicitStatus: p?.last_client_meta?.status || 'online' },
      { ts: u.last_sign_in_at, source: 'last_sign_in', explicitStatus: 'offline' },
      { ts: p?.updated_at, source: 'profile_sync', explicitStatus: 'offline' }
    ]
      .filter(c => c.ts && Number.isFinite(Date.parse(c.ts)))
      .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));

    const best = candidates[0] || null;
    const lastSeenAt = best ? safeIso(best.ts) : null;
    const lastSeenSource = best ? best.source : 'never';
    const presenceStatus = best && (best.source === 'live_heartbeat' || best.source === 'profile_heartbeat')
      ? classifyPresence(lastSeenAt, best.explicitStatus, now)
      : (lastSeenAt && (now - Date.parse(lastSeenAt) <= ONLINE_WINDOW_MS) ? 'online' : 'offline');

    const emailLower = (u.email || '').toLowerCase();
    const isAdmin = Boolean(p?.is_admin || (emailLower && adminAllowlist.includes(emailLower)));

    usersById.set(u.id, {
      id: u.id,
      email: u.email || (isAnonymous ? 'anonymous@guest' : 'unknown'),
      name: p?.user_name || meta.full_name || meta.name || (u.email ? u.email.split('@')[0] : (isAnonymous ? 'Anonymous Guest' : 'User')),
      avatarUrl: meta.avatar_url || meta.picture || null,
      provider,
      isAnonymous,
      isAdmin,
      emailConfirmed: Boolean(u.email_confirmed_at),
      hasProfile: Boolean(p),
      createdAt: safeIso(u.created_at) || safeIso(p?.created_at),
      lastSignInAt: safeIso(u.last_sign_in_at),
      lastSeenAt,
      lastSeenSource,
      presenceStatus,
      isOnline: presenceStatus === 'online',
      activeView: latestSess?.activeView || p?.last_active_view || null,
      deviceType: latestSess?.deviceType || p?.last_client_meta?.deviceType || null,
      browser: latestSess?.browser || p?.last_client_meta?.browser || null,
      os: latestSess?.os || p?.last_client_meta?.os || null,
      sessionCount: Math.max(uSessions.length, Number(p?.session_count) || 0),
      telemetryEnabled: Boolean(p?.telemetry_enabled),
      counts: {
        cycleLogs: logCounts.get(u.id) || 0,
        aiMemories: memoryCounts.get(u.id) || 0,
        aiChats: chatCounts.get(u.id) || 0,
        partnerShares: shareCounts.get(u.id) || 0
      }
    });
  }

  // Also include any live authenticated users from in-memory sessions if DB isn't configured
  for (const [uid, list] of sessionsByUser.entries()) {
    if (usersById.has(uid)) continue;
    const latest = list[0];
    usersById.set(uid, {
      id: uid,
      email: latest.email || 'session-user',
      name: latest.email ? latest.email.split('@')[0] : 'Active User',
      avatarUrl: null,
      provider: latest.provider || 'email',
      isAnonymous: false,
      isAdmin: false,
      emailConfirmed: true,
      hasProfile: false,
      createdAt: latest.startedAt,
      lastSignInAt: latest.startedAt,
      lastSeenAt: latest.lastSeenAt,
      lastSeenSource: 'live_heartbeat',
      presenceStatus: latest.computedStatus,
      isOnline: latest.computedStatus === 'online',
      activeView: latest.activeView,
      deviceType: latest.deviceType,
      browser: latest.browser,
      os: latest.os,
      sessionCount: list.length,
      telemetryEnabled: false,
      counts: { cycleLogs: 0, aiMemories: 0, aiChats: 0, partnerShares: 0 }
    });
  }

  const users = [...usersById.values()];
  const onlineRegisteredUsers = users.filter(u => u.presenceStatus === 'online');
  const idleRegisteredUsers = users.filter(u => u.presenceStatus === 'idle');
  const onlineGuestSessions = guestSessions.filter(s => s.computedStatus === 'online');
  const idleGuestSessions = guestSessions.filter(s => s.computedStatus === 'idle');

  return {
    dbEnabled,
    authUsersError,
    users,
    allSessions,
    guestSessions,
    onlineRegisteredUsers,
    idleRegisteredUsers,
    onlineGuestSessions,
    idleGuestSessions,
    totalCounts,
    mem
  };
}

/**
 * Load presence snapshots + telemetry events + gemini logs + client errors from DB merged with memory
 */
async function loadTimeSeriesTelemetry(rangeKey = '24h') {
  const { key, ms } = parseRange(rangeKey, '24h');
  const sinceIso = new Date(Date.now() - ms).toISOString();
  const mem = getMemoryTelemetrySnapshot();
  const dbEnabled = isAdminDbConfigured();

  let dbSnapshots = [];
  let dbEvents = [];
  let dbGeminiCalls = [];
  let dbErrors = [];
  let dbAudit = [];

  if (dbEnabled) {
    const [snapRes, evRes, gemRes, errRes, audRes] = await Promise.all([
      adminRest(`/presence_snapshots?bucket_at=gte.${encodeURIComponent(sinceIso)}&order=bucket_at.asc&limit=1000`, { timeoutMs: 6000 }),
      adminRest(`/telemetry_events?created_at=gte.${encodeURIComponent(sinceIso)}&order=created_at.desc&limit=2000`, { timeoutMs: 6000 }),
      adminRest(`/gemini_telemetry?created_at=gte.${encodeURIComponent(sinceIso)}&order=created_at.desc&limit=1000`, { timeoutMs: 6000 }),
      adminRest(`/client_error_logs?created_at=gte.${encodeURIComponent(sinceIso)}&order=created_at.desc&limit=300`, { timeoutMs: 6000 }),
      adminRest('/admin_audit_logs?order=created_at.desc&limit=150', { timeoutMs: 5000 })
    ]);

    if (snapRes.ok && Array.isArray(snapRes.data)) {
      dbSnapshots = snapRes.data.map(r => ({
        bucketAt: r.bucket_at,
        onlineTotal: Number(r.online_total) || 0,
        onlineRegistered: Number(r.online_registered) || 0,
        onlineGuests: Number(r.online_guests) || 0,
        activeViews: r.active_views || {}
      }));
    }
    if (evRes.ok && Array.isArray(evRes.data)) {
      dbEvents = evRes.data.map(r => ({
        sessionId: r.session_id,
        userId: r.user_id,
        isGuest: Boolean(r.is_guest),
        category: r.category,
        action: r.action,
        label: r.label,
        metadata: r.metadata || {},
        createdAt: r.created_at
      }));
    }
    if (gemRes.ok && Array.isArray(gemRes.data)) {
      dbGeminiCalls = gemRes.data.map(r => ({
        task: r.task,
        requestedModel: r.requested_model,
        modelUsed: r.model_used,
        cascaded: Boolean(r.cascaded),
        attempts: Number(r.attempts) || 1,
        statusCode: Number(r.status_code) || 200,
        success: Boolean(r.success),
        latencyMs: Number(r.latency_ms) || 0,
        promptTokens: r.prompt_tokens,
        completionTokens: r.completion_tokens,
        totalTokens: r.total_tokens,
        errorCode: r.error_code,
        userId: r.user_id,
        createdAt: r.created_at
      }));
    }
    if (errRes.ok && Array.isArray(errRes.data)) {
      dbErrors = errRes.data.map(r => ({
        sessionId: r.session_id,
        userId: r.user_id,
        errorType: r.error_type,
        message: r.message,
        source: r.source,
        viewName: r.view_name,
        deviceType: r.device_type,
        appVersion: r.app_version,
        createdAt: r.created_at
      }));
    }
    if (audRes.ok && Array.isArray(audRes.data)) {
      dbAudit = audRes.data.map(r => ({
        adminIdentity: r.admin_identity,
        action: r.action,
        target: r.target,
        details: r.details || {},
        ipAddress: r.ip_address,
        createdAt: r.created_at
      }));
    }
  }

  const sinceTs = Date.now() - ms;

  // Merge snapshots by bucketAt
  const snapMap = new Map();
  for (const s of dbSnapshots) snapMap.set(s.bucketAt, s);
  for (const s of mem.snapshots) {
    if (Date.parse(s.bucketAt) < sinceTs) continue;
    const prev = snapMap.get(s.bucketAt);
    if (!prev || s.onlineTotal > prev.onlineTotal) {
      snapMap.set(s.bucketAt, s);
    }
  }
  const snapshots = [...snapMap.values()].sort((a, b) => a.bucketAt.localeCompare(b.bucketAt));

  const events = dbEvents.length > 0
    ? dbEvents
    : mem.events.filter(e => Date.parse(e.createdAt) >= sinceTs);

  // Merge DB + memory Gemini calls (deduping roughly by createdAt+requestedModel)
  const gemSeen = new Set();
  const geminiCalls = [];
  for (const c of [...mem.geminiCalls, ...dbGeminiCalls]) {
    if (Date.parse(c.createdAt) < sinceTs) continue;
    const sig = `${c.createdAt.slice(0, 19)}|${c.requestedModel}|${c.latencyMs}`;
    if (gemSeen.has(sig)) continue;
    gemSeen.add(sig);
    geminiCalls.push(c);
  }
  geminiCalls.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

  const clientErrors = dbErrors.length > 0
    ? dbErrors
    : mem.clientErrors.filter(e => Date.parse(e.createdAt) >= sinceTs);

  const adminAudit = dbAudit.length > 0 ? dbAudit : mem.adminAudit;

  return {
    rangeKey: key,
    rangeMs: ms,
    snapshots,
    events,
    geminiCalls,
    clientErrors,
    adminAudit
  };
}

/**
 * Build continuous bucketed online-users timeline for charting
 */
function buildOnlineTimelineSeries(snapshots, currentOnline, rangeKey = '24h') {
  const now = Date.now();
  const cfg = {
    '1h': { points: 12, stepMs: 5 * 60 * 1000 },
    '6h': { points: 18, stepMs: 20 * 60 * 1000 },
    '24h': { points: 24, stepMs: 60 * 60 * 1000 },
    '7d': { points: 28, stepMs: 6 * 60 * 60 * 1000 },
    '30d': { points: 30, stepMs: 24 * 60 * 60 * 1000 }
  }[rangeKey] || { points: 24, stepMs: 60 * 60 * 1000 };

  const endBucket = Math.floor(now / cfg.stepMs) * cfg.stepMs;
  const startBucket = endBucket - (cfg.points - 1) * cfg.stepMs;

  const buckets = [];
  for (let i = 0; i < cfg.points; i++) {
    const ts = startBucket + i * cfg.stepMs;
    buckets.push({
      bucketStart: ts,
      bucketEnd: ts + cfg.stepMs,
      timestamp: new Date(ts).toISOString(),
      onlineTotal: 0,
      onlineRegistered: 0,
      onlineGuests: 0
    });
  }

  for (const snap of snapshots) {
    const t = Date.parse(snap.bucketAt);
    if (!Number.isFinite(t) || t < startBucket) continue;
    const idx = Math.min(buckets.length - 1, Math.floor((t - startBucket) / cfg.stepMs));
    if (idx >= 0 && idx < buckets.length) {
      buckets[idx].onlineTotal = Math.max(buckets[idx].onlineTotal, snap.onlineTotal);
      buckets[idx].onlineRegistered = Math.max(buckets[idx].onlineRegistered, snap.onlineRegistered);
      buckets[idx].onlineGuests = Math.max(buckets[idx].onlineGuests, snap.onlineGuests);
    }
  }

  // Always reflect exact live concurrency in the final (current) bucket
  const last = buckets[buckets.length - 1];
  if (last && currentOnline) {
    last.onlineTotal = Math.max(last.onlineTotal, currentOnline.total);
    last.onlineRegistered = Math.max(last.onlineRegistered, currentOnline.registered);
    last.onlineGuests = Math.max(last.onlineGuests, currentOnline.guests);
  }

  return buckets.map(b => ({
    timestamp: b.timestamp,
    onlineTotal: b.onlineTotal,
    onlineRegistered: b.onlineRegistered,
    onlineGuests: b.onlineGuests
  }));
}

/**
 * Build daily user growth (cumulative users + daily new signups + daily active users)
 */
function buildUserGrowthSeries(users, sessions, days = 30) {
  const now = Date.now();
  const todayUtcStart = Date.UTC(
    new Date(now).getUTCFullYear(),
    new Date(now).getUTCMonth(),
    new Date(now).getUTCDate()
  );
  const startDayTs = todayUtcStart - (days - 1) * 86400000;

  const signupsByDay = new Map();
  const activeUsersByDay = new Map();
  let baselineUsers = 0;

  for (const u of users) {
    const createdTs = u.createdAt ? Date.parse(u.createdAt) : NaN;
    if (Number.isFinite(createdTs)) {
      if (createdTs < startDayTs) {
        baselineUsers++;
      } else {
        const dk = dayKeyUtc(createdTs);
        signupsByDay.set(dk, (signupsByDay.get(dk) || 0) + 1);
      }
    }
    const lastTs = u.lastSeenAt ? Date.parse(u.lastSeenAt) : NaN;
    if (Number.isFinite(lastTs) && lastTs >= startDayTs) {
      const dk = dayKeyUtc(lastTs);
      if (!activeUsersByDay.has(dk)) activeUsersByDay.set(dk, new Set());
      activeUsersByDay.get(dk).add(u.id);
    }
  }

  for (const s of sessions) {
    const ts = s.lastSeenAt ? Date.parse(s.lastSeenAt) : NaN;
    if (!Number.isFinite(ts) || ts < startDayTs) continue;
    const dk = dayKeyUtc(ts);
    if (!activeUsersByDay.has(dk)) activeUsersByDay.set(dk, new Set());
    activeUsersByDay.get(dk).add(s.userId || s.sessionId);
  }

  const series = [];
  let runningTotal = baselineUsers;

  for (let i = 0; i < days; i++) {
    const ts = startDayTs + i * 86400000;
    const dateKey = dayKeyUtc(ts);
    const newSignups = signupsByDay.get(dateKey) || 0;
    runningTotal += newSignups;
    const dau = activeUsersByDay.get(dateKey)?.size || 0;
    series.push({
      date: dateKey,
      newSignups,
      totalUsers: runningTotal,
      dau
    });
  }

  return series;
}

/**
 * Build 7 (Sun..Sat) x 24 (00..23 UTC) activity intensity heatmap
 */
function buildActivityHeatmap(sessions, events) {
  const matrix = Array.from({ length: 7 }, () => Array(24).fill(0));
  const items = [
    ...sessions.map(s => s.lastSeenAt),
    ...events.map(e => e.createdAt)
  ];
  let maxVal = 0;
  for (const iso of items) {
    const ts = Date.parse(iso || '');
    if (!Number.isFinite(ts)) continue;
    const d = new Date(ts);
    const dow = d.getUTCDay();
    const hr = d.getUTCHours();
    matrix[dow][hr]++;
    if (matrix[dow][hr] > maxVal) maxVal = matrix[dow][hr];
  }
  return {
    days: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    matrix,
    max: maxVal
  };
}

/**
 * Run deep Database Integrity Audit (RPC first, with resilient PostgREST fallback)
 */
async function getDatabaseIntegrityPayload() {
  const dbCfg = getSupabaseAdminConfig();
  const health = await checkSupabaseHealth();
  const checks = [];
  let tables = [];
  let orphans = null;
  let anomalies = null;
  let legacy = null;
  let functions = [];
  let databaseStats = null;
  let rpcAvailable = false;

  if (!dbCfg.configured) {
    checks.push({
      id: 'service_role_config',
      category: 'Configuration',
      title: 'Supabase Service Role Key',
      status: 'warn',
      metric: 'Not Configured',
      detail: 'SUPABASE_SERVICE_ROLE_KEY is not set in server environment variables.',
      remediation: 'Add SUPABASE_SERVICE_ROLE_KEY to .env or Vercel Environment Variables to enable live database integrity scans.'
    });
    return {
      generatedAt: new Date().toISOString(),
      configured: false,
      connected: health.connected,
      rpcAvailable: false,
      score: 50,
      summary: { totalChecks: checks.length, passed: 0, warnings: 1, failed: 0 },
      health,
      database: null,
      tables: [],
      orphans: null,
      anomalies: null,
      legacy: null,
      functions: [],
      checks
    };
  }

  // 1. Connectivity Check
  checks.push({
    id: 'db_connectivity',
    category: 'Connectivity',
    title: 'Supabase Cloud Database Reachability',
    status: health.connected ? 'pass' : 'fail',
    metric: health.restLatencyMs !== null ? `${health.restLatencyMs} ms` : 'Unreachable',
    detail: health.connected
      ? `PostgREST & Auth endpoints responded cleanly (REST ${health.restLatencyMs}ms, Auth ${health.authLatencyMs ?? '—'}ms).`
      : `Unable to reach Supabase REST endpoint: ${health.error || 'Unknown error'}`,
    remediation: health.connected ? null : 'Verify SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and project status in Supabase Dashboard.'
  });

  // 2. Try comprehensive SQL RPC public.get_db_integrity_report()
  const rpcRes = await adminRpc('get_db_integrity_report', {}, { timeoutMs: 10000 });
  if (rpcRes.ok && rpcRes.data && typeof rpcRes.data === 'object') {
    rpcAvailable = true;
    const report = rpcRes.data;
    tables = Array.isArray(report.tables) ? report.tables : [];
    orphans = report.orphans || null;
    anomalies = report.anomalies || null;
    legacy = report.legacy || null;
    functions = Array.isArray(report.functions) ? report.functions : [];
    databaseStats = report.database || null;
  } else {
    // Graceful fallback: probe each expected table directly via PostgREST HEAD count
    const probes = await Promise.all(
      ALL_EXPECTED_TABLES.map(async tableName => {
        const res = await countTableRows(tableName);
        return {
          table_name: tableName,
          exists: res.ok,
          live_rows: res.ok ? res.count : 0,
          rls_enabled: null,
          policy_count: null,
          total_bytes: null,
          dead_tuples: null,
          error: res.ok ? null : res.error
        };
      })
    );
    tables = probes.filter(t => t.exists);
  }

  const existingTableNames = new Set(tables.map(t => t.table_name));
  const missingCore = CORE_TABLES.filter(t => !existingTableNames.has(t));
  const missingTelemetry = TELEMETRY_TABLES.filter(t => !existingTableNames.has(t));

  // 3. Core Schema Check
  checks.push({
    id: 'core_schema',
    category: 'Schema',
    title: 'Core Wellness Tables Present',
    status: missingCore.length === 0 ? 'pass' : 'fail',
    metric: `${CORE_TABLES.length - missingCore.length}/${CORE_TABLES.length} tables`,
    detail: missingCore.length === 0
      ? 'All core AifyCycle tables (profiles, cycle_logs, ai_memories, ai_chat_history, partner_shares, legacy_user_imports) exist.'
      : `Missing core tables: ${missingCore.join(', ')}`,
    remediation: missingCore.length === 0 ? null : 'Run supabase/migrations/20260924_initial_schema.sql and 20261121_legacy_data_claim.sql in Supabase SQL Editor.'
  });

  // 4. Telemetry & Admin Schema Migration Check
  checks.push({
    id: 'telemetry_schema',
    category: 'Schema',
    title: 'Admin & Telemetry Migration (20261127)',
    status: missingTelemetry.length === 0 && rpcAvailable ? 'pass' : 'warn',
    metric: `${TELEMETRY_TABLES.length - missingTelemetry.length}/${TELEMETRY_TABLES.length} tables`,
    detail: missingTelemetry.length === 0 && rpcAvailable
      ? 'All telemetry tables and get_db_integrity_report() RPC are installed and active.'
      : `Pending admin migration items: ${[...missingTelemetry, ...(rpcAvailable ? [] : ['get_db_integrity_report() RPC'])].join(', ')}.`,
    remediation: missingTelemetry.length === 0 && rpcAvailable
      ? null
      : 'Run supabase/migrations/20261127_admin_telemetry.sql in Supabase Cloud SQL Editor to unlock deep PostgreSQL telemetry & persistent presence snapshots.'
  });

  // 5. Row-Level Security (RLS) Enforcement
  if (rpcAvailable) {
    const rlsDisabled = tables.filter(t => t.rls_enabled !== true);
    checks.push({
      id: 'rls_enforcement',
      category: 'Security',
      title: 'Row-Level Security (RLS) Across All Public Tables',
      status: rlsDisabled.length === 0 ? 'pass' : 'fail',
      metric: `${tables.length - rlsDisabled.length}/${tables.length} RLS ON`,
      detail: rlsDisabled.length === 0
        ? 'Every table in the public schema has PostgreSQL Row-Level Security enabled.'
        : `Tables with RLS disabled: ${rlsDisabled.map(t => t.table_name).join(', ')}`,
      remediation: rlsDisabled.length === 0 ? null : 'Run ALTER TABLE public.<table> ENABLE ROW LEVEL SECURITY immediately.'
    });

    // 6. User Table RLS Policy Coverage
    const missingPolicyTables = tables.filter(
      t => USER_POLICY_TABLES.has(t.table_name) && Number(t.policy_count || 0) === 0
    );
    checks.push({
      id: 'rls_policies',
      category: 'Security',
      title: 'User-Scoped RLS Policy Coverage',
      status: missingPolicyTables.length === 0 ? 'pass' : 'warn',
      metric: `${USER_POLICY_TABLES.size - missingPolicyTables.length}/${USER_POLICY_TABLES.size} guarded`,
      detail: missingPolicyTables.length === 0
        ? 'All user-facing tables enforce auth.uid() policies; internal telemetry & staging tables remain zero-policy service-role locked.'
        : `User tables missing explicit RLS policies: ${missingPolicyTables.map(t => t.table_name).join(', ')}`,
      remediation: missingPolicyTables.length === 0 ? null : 'Re-apply RLS policies from supabase/migrations/20260924_initial_schema.sql.'
    });

    // 7. Referential Integrity / Orphan Scan
    const totalOrphans = orphans
      ? (Number(orphans.orphan_profiles) || 0) +
        (Number(orphans.orphan_cycle_logs) || 0) +
        (Number(orphans.orphan_ai_memories) || 0) +
        (Number(orphans.orphan_ai_chat_history) || 0) +
        (Number(orphans.orphan_partner_shares) || 0)
      : 0;
    checks.push({
      id: 'referential_orphans',
      category: 'Integrity',
      title: 'Referential Integrity & Orphaned Row Scan',
      status: totalOrphans === 0 ? 'pass' : 'fail',
      metric: `${totalOrphans} orphans`,
      detail: totalOrphans === 0
        ? `Zero orphaned records across profiles, cycle_logs, ai_memories, ai_chat_history, and partner_shares. (${orphans?.registered_users_without_profile || 0} newly registered users pending onboarding profile).`
        : `Detected ${totalOrphans} orphaned rows referencing missing auth.users accounts.`,
      remediation: totalOrphans === 0 ? null : 'Inspect foreign key constraints and remove orphaned rows safely.'
    });

    // 8. Data Domain & Date Sanity
    const futureLogs = Number(anomalies?.future_dated_cycle_logs) || 0;
    const missingLps = Number(anomalies?.profiles_missing_last_period_start) || 0;
    checks.push({
      id: 'data_anomalies',
      category: 'Data Quality',
      title: 'Cycle Data & Date Boundary Validation',
      status: futureLogs === 0 ? 'pass' : 'warn',
      metric: `${futureLogs} future anomalies`,
      detail: futureLogs === 0
        ? `No abnormally far-future cycle logs (>30d ahead). ${missingLps} profile(s) currently have an unset last_period_start.`
        : `Found ${futureLogs} cycle_logs dated more than 30 days in the future.`,
      remediation: futureLogs === 0 ? null : 'Audit client date formatting or clean up test logs dated far in the future.'
    });

    // 9. Critical Security Functions & GDPR Erasure RPC
    const fnNames = new Set(functions.map(f => f.name));
    const requiredFns = ['set_updated_at', 'delete_user_data', 'claim_legacy_user_data', 'guard_profile_admin_flag'];
    const missingFns = requiredFns.filter(f => !fnNames.has(f));
    checks.push({
      id: 'security_functions',
      category: 'Compliance',
      title: 'GDPR Erasure & Security Trigger Functions',
      status: missingFns.length === 0 ? 'pass' : 'warn',
      metric: `${requiredFns.length - missingFns.length}/${requiredFns.length} active`,
      detail: missingFns.length === 0
        ? 'delete_user_data(), set_updated_at(), claim_legacy_user_data(), and admin-flag guard triggers are installed with hardened search_path.'
        : `Missing functions: ${missingFns.join(', ')}`,
      remediation: missingFns.length === 0 ? null : 'Re-run SQL migrations to ensure all SECURITY DEFINER functions are up to date.'
    });

    // 10. Legacy Migration Queue
    const unclaimed = Number(legacy?.unclaimed_imports) || 0;
    const legacyTotal = Number(legacy?.total_imports) || 0;
    checks.push({
      id: 'legacy_imports',
      category: 'Migration',
      title: 'Legacy Data Claim Staging Queue',
      status: 'pass',
      metric: `${legacyTotal - unclaimed}/${legacyTotal} claimed`,
      detail: legacyTotal === 0
        ? 'No pending self-hosted legacy user records in staging queue.'
        : `${unclaimed} unclaimed legacy account(s) waiting for users to sign in with matching email (${legacyTotal - unclaimed} already claimed).`,
      remediation: null
    });

    // 11. PostgreSQL Engine Health (Cache Hit Ratio & Dead Tuples)
    const cacheHit = Number(databaseStats?.cache_hit_ratio ?? 100);
    const deadlocks = Number(databaseStats?.deadlocks ?? 0);
    const totalDead = tables.reduce((acc, t) => acc + (Number(t.dead_tuples) || 0), 0);
    checks.push({
      id: 'pg_engine_health',
      category: 'Performance',
      title: 'PostgreSQL Cache Hit Ratio & Vacuum Health',
      status: cacheHit >= 90 && deadlocks === 0 ? 'pass' : 'warn',
      metric: `${cacheHit}% hit / ${totalDead} dead tuples`,
      detail: `PostgreSQL ${databaseStats?.pg_version || '15+'} · DB size ${formatBytes(databaseStats?.database_size_bytes || 0)} · ${databaseStats?.active_connections || 1} active connections · ${deadlocks} deadlocks.`,
      remediation: cacheHit >= 90 ? null : 'Monitor index scan efficiency and consider vacuuming high-churn tables.'
    });
  }

  const passed = checks.filter(c => c.status === 'pass').length;
  const warnings = checks.filter(c => c.status === 'warn').length;
  const failed = checks.filter(c => c.status === 'fail').length;
  const score = checks.length > 0
    ? Math.max(0, Math.min(100, Math.round(((passed + warnings * 0.6) / checks.length) * 100)))
    : 0;

  const formattedTables = tables.map(t => {
    const live = Number(t.live_rows) || 0;
    const dead = Number(t.dead_tuples) || 0;
    const bloatRatio = live + dead > 0 ? Math.round((dead / (live + dead)) * 100) : 0;
    return {
      name: t.table_name,
      group: CORE_TABLES.includes(t.table_name) ? 'core' : (TELEMETRY_TABLES.includes(t.table_name) ? 'telemetry' : 'other'),
      liveRows: live,
      deadTuples: dead,
      bloatRatio,
      rlsEnabled: t.rls_enabled,
      policyCount: t.policy_count,
      totalBytes: t.total_bytes,
      totalSizeFormatted: t.total_bytes !== null && t.total_bytes !== undefined ? formatBytes(t.total_bytes) : '—',
      indexBytes: t.index_bytes,
      seqScans: t.seq_scans ?? null,
      idxScans: t.idx_scans ?? null,
      lastAutovacuum: t.last_autovacuum || null,
      status: t.rls_enabled === false ? 'fail' : (bloatRatio > 35 && dead > 200 ? 'warn' : 'pass')
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    configured: true,
    connected: health.connected,
    rpcAvailable,
    score,
    summary: {
      totalChecks: checks.length,
      passed,
      warnings,
      failed
    },
    health,
    database: databaseStats
      ? {
          pgVersion: databaseStats.pg_version,
          sizeBytes: databaseStats.database_size_bytes,
          sizeFormatted: formatBytes(databaseStats.database_size_bytes),
          activeConnections: databaseStats.active_connections,
          cacheHitRatio: Number(databaseStats.cache_hit_ratio ?? 100),
          txCommitRatio: Number(databaseStats.tx_commit_ratio ?? 100),
          deadlocks: Number(databaseStats.deadlocks ?? 0)
        }
      : null,
    tables: formattedTables,
    orphans,
    anomalies,
    legacy,
    functions,
    checks
  };
}

/**
 * Gemini Models Health & Historical Telemetry Payload
 */
async function getGeminiHealthPayload({ range = '24h' } = {}) {
  const live = getDetailedGeminiHealth();
  const ts = await loadTimeSeriesTelemetry(range);
  const calls = ts.geminiCalls;

  // Aggregate persistent + in-memory metrics per model
  const byModel = new Map();
  for (const m of live.models) {
    byModel.set(m.model, {
      ...m,
      rangeCalls: 0,
      rangeSuccesses: 0,
      rangeFailures: 0,
      rangeCascadeWins: 0,
      rangeLatencies: [],
      rangeTokens: 0
    });
  }

  let totalCalls = 0;
  let totalSuccess = 0;
  let totalCascaded = 0;
  let totalTokens = 0;
  const allLatencies = [];
  const errorCounts = {};
  const taskCounts = { chat: 0, cycle_sync: 0, probe: 0 };

  for (const c of calls) {
    totalCalls++;
    if (c.success) totalSuccess++;
    if (c.cascaded) totalCascaded++;
    if (Number.isFinite(c.totalTokens)) totalTokens += c.totalTokens;
    if (Number.isFinite(c.latencyMs) && c.latencyMs > 0) allLatencies.push(c.latencyMs);
    if (c.task) taskCounts[c.task] = (taskCounts[c.task] || 0) + 1;
    if (!c.success && c.errorCode) {
      errorCounts[c.errorCode] = (errorCounts[c.errorCode] || 0) + 1;
    }

    const targetName = c.modelUsed || c.requestedModel;
    if (targetName) {
      if (!byModel.has(targetName)) {
        byModel.set(targetName, {
          model: targetName,
          priority: 99,
          role: 'historical',
          isActive: false,
          healthState: 'standby',
          coolingDown: false,
          cooldownUntil: null,
          cooldownRemainingSec: 0,
          attempts: 0,
          successes: 0,
          failures: 0,
          cascadeWins: 0,
          successRate: null,
          avgLatencyMs: null,
          p95LatencyMs: null,
          totalTokens: 0,
          rangeCalls: 0,
          rangeSuccesses: 0,
          rangeFailures: 0,
          rangeCascadeWins: 0,
          rangeLatencies: [],
          rangeTokens: 0
        });
      }
      const m = byModel.get(targetName);
      m.rangeCalls++;
      if (c.success) m.rangeSuccesses++;
      else m.rangeFailures++;
      if (c.cascaded && c.success) m.rangeCascadeWins++;
      if (Number.isFinite(c.latencyMs) && c.latencyMs > 0) m.rangeLatencies.push(c.latencyMs);
      if (Number.isFinite(c.totalTokens)) m.rangeTokens += c.totalTokens;
    }
  }

  const enrichedModels = [...byModel.values()]
    .sort((a, b) => a.priority - b.priority)
    .map(m => {
      const mergedCalls = Math.max(m.attempts, m.rangeCalls);
      const mergedSuccesses = Math.max(m.successes, m.rangeSuccesses);
      const mergedFailures = Math.max(m.failures, m.rangeFailures);
      const avgLat = m.rangeLatencies.length > 0
        ? Math.round(m.rangeLatencies.reduce((x, y) => x + y, 0) / m.rangeLatencies.length)
        : m.avgLatencyMs;
      const p95Lat = m.rangeLatencies.length > 0
        ? computePercentile(m.rangeLatencies, 95)
        : m.p95LatencyMs;
      const rate = mergedCalls > 0 ? Math.round((mergedSuccesses / mergedCalls) * 1000) / 10 : m.successRate;

      const { rangeLatencies, ...clean } = m;
      return {
        ...clean,
        totalCalls: mergedCalls,
        totalSuccesses: mergedSuccesses,
        totalFailures: mergedFailures,
        totalTokens: Math.max(m.totalTokens || 0, m.rangeTokens || 0),
        avgLatencyMs: avgLat,
        p95LatencyMs: p95Lat,
        successRate: rate
      };
    });

  // Build latency & request volume time-series (12 buckets across range)
  const bucketCount = 12;
  const stepMs = Math.max(60000, Math.floor(ts.rangeMs / bucketCount));
  const now = Date.now();
  const startTs = now - bucketCount * stepMs;
  const timeline = Array.from({ length: bucketCount }, (_, i) => ({
    timestamp: new Date(startTs + i * stepMs).toISOString(),
    requests: 0,
    successes: 0,
    failures: 0,
    cascaded: 0,
    latencies: []
  }));

  for (const c of calls) {
    const t = Date.parse(c.createdAt);
    if (!Number.isFinite(t) || t < startTs) continue;
    const idx = Math.min(bucketCount - 1, Math.max(0, Math.floor((t - startTs) / stepMs)));
    timeline[idx].requests++;
    if (c.success) timeline[idx].successes++;
    else timeline[idx].failures++;
    if (c.cascaded) timeline[idx].cascaded++;
    if (Number.isFinite(c.latencyMs) && c.latencyMs > 0) timeline[idx].latencies.push(c.latencyMs);
  }

  const series = timeline.map(b => ({
    timestamp: b.timestamp,
    requests: b.requests,
    successes: b.successes,
    failures: b.failures,
    cascaded: b.cascaded,
    avgLatencyMs: b.latencies.length > 0
      ? Math.round(b.latencies.reduce((a, x) => a + x, 0) / b.latencies.length)
      : 0
  }));

  const avgLatencyMs = allLatencies.length > 0
    ? Math.round(allLatencies.reduce((a, b) => a + b, 0) / allLatencies.length)
    : null;

  return {
    generatedAt: new Date().toISOString(),
    range: ts.rangeKey,
    configured: live.configured,
    mode: live.mode,
    configuredPrimary: live.configuredPrimary,
    activeModel: live.activeModel,
    cascadeEnabled: live.cascadeEnabled,
    timeouts: live.timeouts,
    summary: {
      ...live.summary,
      totalCalls,
      successRate: totalCalls > 0 ? Math.round((totalSuccess / totalCalls) * 1000) / 10 : null,
      cascadeRate: totalCalls > 0 ? Math.round((totalCascaded / totalCalls) * 1000) / 10 : 0,
      avgLatencyMs,
      p95LatencyMs: computePercentile(allLatencies, 95),
      totalTokens,
      taskCounts
    },
    models: enrichedModels,
    series,
    errorBreakdown: Object.entries(errorCounts)
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8),
    recentCalls: calls.slice(0, 40)
  };
}

/**
 * Executive Overview Payload
 */
async function getOverviewPayload({ range = '24h' } = {}) {
  const now = Date.now();
  const [unified, ts, integrity, gemini] = await Promise.all([
    loadUnifiedUsersAndSessions(),
    loadTimeSeriesTelemetry(range),
    getDatabaseIntegrityPayload(),
    getGeminiHealthPayload({ range })
  ]);

  const { users, allSessions, onlineRegisteredUsers, idleRegisteredUsers, onlineGuestSessions, idleGuestSessions, totalCounts } = unified;

  const registeredUsers = users.filter(u => !u.isAnonymous);
  const anonymousAccounts = users.filter(u => u.isAnonymous);

  const dayMs = 86400000;
  const new24h = users.filter(u => u.createdAt && (now - Date.parse(u.createdAt) <= dayMs)).length;
  const new7d = users.filter(u => u.createdAt && (now - Date.parse(u.createdAt) <= 7 * dayMs)).length;
  const newPrev7d = users.filter(u => {
    if (!u.createdAt) return false;
    const age = now - Date.parse(u.createdAt);
    return age > 7 * dayMs && age <= 14 * dayMs;
  }).length;
  const new30d = users.filter(u => u.createdAt && (now - Date.parse(u.createdAt) <= 30 * dayMs)).length;
  const signupGrowthPct = newPrev7d > 0
    ? Math.round(((new7d - newPrev7d) / newPrev7d) * 100)
    : (new7d > 0 ? 100 : 0);

  // Active DAU / WAU / MAU (registered users + guest sessions)
  const dauSet = new Set();
  const wauSet = new Set();
  const mauSet = new Set();

  for (const u of users) {
    if (!u.lastSeenAt) continue;
    const age = now - Date.parse(u.lastSeenAt);
    if (age <= dayMs) dauSet.add(u.id);
    if (age <= 7 * dayMs) wauSet.add(u.id);
    if (age <= 30 * dayMs) mauSet.add(u.id);
  }
  for (const s of allSessions) {
    if (!s.lastSeenAt) continue;
    const key = s.userId || s.sessionId;
    const age = now - Date.parse(s.lastSeenAt);
    if (age <= dayMs) dauSet.add(key);
    if (age <= 7 * dayMs) wauSet.add(key);
    if (age <= 30 * dayMs) mauSet.add(key);
  }

  const dau = dauSet.size;
  const wau = wauSet.size;
  const mau = mauSet.size;
  const stickinessPct = mau > 0 ? Math.round((dau / mau) * 100) : 0;

  const onlineNow = {
    total: onlineRegisteredUsers.length + onlineGuestSessions.length,
    registered: onlineRegisteredUsers.length,
    guests: onlineGuestSessions.length,
    idleTotal: idleRegisteredUsers.length + idleGuestSessions.length,
    idleRegistered: idleRegisteredUsers.length,
    idleGuests: idleGuestSessions.length
  };

  // Provider breakdown
  const providerCounts = { google: 0, email: 0, apple: 0, anonymous: 0, other: 0 };
  for (const u of users) {
    if (u.provider === 'google') providerCounts.google++;
    else if (u.provider === 'email') providerCounts.email++;
    else if (u.provider === 'apple') providerCounts.apple++;
    else if (u.provider === 'anonymous' || u.isAnonymous) providerCounts.anonymous++;
    else providerCounts.other++;
  }

  // Compute System Health Score (0-100)
  let healthScore = 100;
  if (!integrity.configured) healthScore -= 15;
  else if (!integrity.connected) healthScore -= 40;
  else healthScore -= Math.round((100 - integrity.score) * 0.35);

  if (!gemini.configured) healthScore -= 10;
  else if (gemini.summary.overallStatus === 'outage') healthScore -= 30;
  else if (gemini.summary.overallStatus === 'degraded') healthScore -= 10;

  if (ts.clientErrors.length > 20) healthScore -= 10;
  else if (ts.clientErrors.length > 5) healthScore -= 4;

  healthScore = Math.max(0, Math.min(100, Math.round(healthScore)));

  // Smart System Alerts
  const alerts = [];
  if (!integrity.configured) {
    alerts.push({
      severity: 'warn',
      source: 'Database',
      title: 'Supabase Service Role Key not configured',
      detail: 'Add SUPABASE_SERVICE_ROLE_KEY to unlock full auth.users directory, persistent telemetry, and PostgreSQL integrity audits.'
    });
  } else if (!integrity.rpcAvailable) {
    alerts.push({
      severity: 'info',
      source: 'Migration',
      title: 'Admin telemetry SQL migration pending',
      detail: 'Run supabase/migrations/20261127_admin_telemetry.sql to enable historical online snapshots & deep PostgreSQL RLS/bloat audits.'
    });
  }
  if (!gemini.configured) {
    alerts.push({
      severity: 'warn',
      source: 'Gemini AI',
      title: 'GEMINI_API_KEY not configured',
      detail: 'AI Coach is currently falling back to local offline wellness rules.'
    });
  } else if (gemini.summary.coolingCount > 0) {
    alerts.push({
      severity: 'warn',
      source: 'Gemini AI',
      title: `${gemini.summary.coolingCount} Gemini model(s) in circuit-breaker cooldown`,
      detail: `Active serving model automatically routed to ${gemini.activeModel}.`
    });
  }
  if (integrity.summary.failed > 0) {
    alerts.push({
      severity: 'error',
      source: 'Integrity',
      title: `${integrity.summary.failed} database integrity check(s) failed`,
      detail: 'Review Database Integrity panel immediately for schema, RLS, or orphan anomalies.'
    });
  }
  if (ts.clientErrors.length > 0) {
    alerts.push({
      severity: ts.clientErrors.length > 10 ? 'error' : 'warn',
      source: 'Client Telemetry',
      title: `${ts.clientErrors.length} client runtime error(s) captured (${ts.rangeKey})`,
      detail: ts.clientErrors[0]?.message || 'Review Client Error Feed in Telemetry & Insights.'
    });
  }
  if (alerts.length === 0) {
    alerts.push({
      severity: 'ok',
      source: 'All Systems',
      title: 'All AifyCycle systems operational',
      detail: 'Database integrity, Gemini cascade, security shield, and live telemetry pipelines report zero active incidents.'
    });
  }

  // Live Active Now Strip (currently online + idle registered users & guests)
  const liveNowList = [
    ...onlineRegisteredUsers.map(u => ({
      id: u.id,
      name: u.name,
      email: u.email,
      isGuest: false,
      status: 'online',
      activeView: u.activeView || 'dial',
      deviceType: u.deviceType || 'desktop',
      browser: u.browser || 'Unknown',
      lastSeenAt: u.lastSeenAt
    })),
    ...idleRegisteredUsers.map(u => ({
      id: u.id,
      name: u.name,
      email: u.email,
      isGuest: false,
      status: 'idle',
      activeView: u.activeView || 'dial',
      deviceType: u.deviceType || 'desktop',
      browser: u.browser || 'Unknown',
      lastSeenAt: u.lastSeenAt
    })),
    ...onlineGuestSessions.map(g => ({
      id: g.sessionId,
      name: `Guest ${g.sessionId.slice(-5)}`,
      email: 'guest@aifycycle.app',
      isGuest: true,
      status: 'online',
      activeView: g.activeView || 'dial',
      deviceType: g.deviceType || 'desktop',
      browser: g.browser || 'Unknown',
      lastSeenAt: g.lastSeenAt
    }))
  ].slice(0, 16);

  const onlineTimeline = buildOnlineTimelineSeries(ts.snapshots, onlineNow, ts.rangeKey);
  const growthDays = ts.rangeKey === '7d' ? 7 : (ts.rangeKey === '90d' ? 90 : 30);
  const userGrowth = buildUserGrowthSeries(users, allSessions, growthDays);

  // Recent signups (last 6)
  const recentSignups = [...users]
    .filter(u => u.createdAt)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, 6)
    .map(u => ({
      id: u.id,
      name: u.name,
      email: u.email,
      provider: u.provider,
      createdAt: u.createdAt,
      lastSeenAt: u.lastSeenAt,
      presenceStatus: u.presenceStatus,
      isOnline: u.isOnline
    }));

  const totalRecords =
    (totalCounts.profiles || 0) +
    (totalCounts.cycle_logs || 0) +
    (totalCounts.ai_memories || 0) +
    (totalCounts.ai_chat_history || 0) +
    (totalCounts.partner_shares || 0);

  return {
    generatedAt: new Date().toISOString(),
    range: ts.rangeKey,
    dbConfigured: integrity.configured,
    rpcAvailable: integrity.rpcAvailable,
    healthScore,
    kpis: {
      onlineNow,
      totalUsers: users.length,
      registeredUsers: registeredUsers.length,
      anonymousUsers: anonymousAccounts.length,
      new24h,
      new7d,
      new30d,
      signupGrowthPct,
      dau,
      wau,
      mau,
      stickinessPct,
      geminiStatus: gemini.summary.overallStatus,
      geminiHealthyModels: gemini.summary.healthyCount,
      geminiTotalModels: gemini.summary.totalModels,
      geminiActiveModel: gemini.activeModel,
      geminiAvgLatencyMs: gemini.summary.avgLatencyMs,
      geminiCalls: gemini.summary.totalCalls,
      dbIntegrityScore: integrity.score,
      dbLatencyMs: integrity.health.restLatencyMs,
      totalRecords,
      recordBreakdown: totalCounts,
      clientErrorsCount: ts.clientErrors.length,
      telemetryOptInCount: users.filter(u => u.telemetryEnabled).length
    },
    charts: {
      onlineTimeline,
      userGrowth,
      providerBreakdown: [
        { key: 'google', label: 'Google OAuth', count: providerCounts.google },
        { key: 'email', label: 'Email & Password', count: providerCounts.email },
        { key: 'apple', label: 'Apple Sign-In', count: providerCounts.apple },
        { key: 'anonymous', label: 'Anonymous Cloud', count: providerCounts.anonymous }
      ].filter(p => p.count > 0 || p.key === 'google' || p.key === 'email')
    },
    liveNow: liveNowList,
    recentSignups,
    alerts
  };
}

/**
 * Full Users & Presence Directory Payload
 */
async function getUsersPayload({
  search = '',
  status = 'all',
  provider = 'all',
  sort = 'lastSeen',
  order = 'desc',
  page = 1,
  pageSize = 25
} = {}) {
  const unified = await loadUnifiedUsersAndSessions();
  const { users, guestSessions, onlineRegisteredUsers, idleRegisteredUsers, onlineGuestSessions, idleGuestSessions } = unified;
  const now = Date.now();

  const q = String(search || '').trim().toLowerCase();
  const statusFilter = String(status || 'all').toLowerCase();
  const providerFilter = String(provider || 'all').toLowerCase();

  let filtered = users.filter(u => {
    if (q) {
      const hay = `${u.name} ${u.email} ${u.id} ${u.provider}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (statusFilter === 'online' && u.presenceStatus !== 'online') return false;
    if (statusFilter === 'idle' && u.presenceStatus !== 'idle') return false;
    if (statusFilter === 'active_now' && u.presenceStatus !== 'online' && u.presenceStatus !== 'idle') return false;
    if (statusFilter === 'active_24h') {
      if (!u.lastSeenAt || now - Date.parse(u.lastSeenAt) > 86400000) return false;
    }
    if (statusFilter === 'offline' && u.presenceStatus !== 'offline') return false;
    if (statusFilter === 'admins' && !u.isAdmin) return false;

    if (providerFilter !== 'all' && u.provider !== providerFilter) return false;
    return true;
  });

  const dir = order === 'asc' ? 1 : -1;
  filtered.sort((a, b) => {
    if (sort === 'createdAt') {
      return dir * ((Date.parse(a.createdAt || 0) || 0) - (Date.parse(b.createdAt || 0) || 0));
    }
    if (sort === 'name') {
      return dir * a.name.localeCompare(b.name);
    }
    if (sort === 'logs') {
      return dir * ((a.counts.cycleLogs || 0) - (b.counts.cycleLogs || 0));
    }
    if (sort === 'ai') {
      return dir * ((a.counts.aiChats || 0) - (b.counts.aiChats || 0));
    }
    // Default: online first, then idle, then most recently seen
    const rank = { online: 3, idle: 2, offline: 1 };
    const rDiff = (rank[a.presenceStatus] || 0) - (rank[b.presenceStatus] || 0);
    if (sort === 'lastSeen' && rDiff !== 0) return -rDiff;
    const tA = Date.parse(a.lastSeenAt || a.createdAt || 0) || 0;
    const tB = Date.parse(b.lastSeenAt || b.createdAt || 0) || 0;
    return dir * (tA - tB);
  });

  const pSize = Math.min(100, Math.max(5, parseInt(pageSize, 10) || 25));
  const totalFiltered = filtered.length;
  const totalPages = Math.max(1, Math.ceil(totalFiltered / pSize));
  const curPage = Math.min(totalPages, Math.max(1, parseInt(page, 10) || 1));
  const slice = filtered.slice((curPage - 1) * pSize, curPage * pSize);

  const active24hCount = users.filter(u => u.lastSeenAt && now - Date.parse(u.lastSeenAt) <= 86400000).length;
  const new7dCount = users.filter(u => u.createdAt && now - Date.parse(u.createdAt) <= 7 * 86400000).length;

  return {
    generatedAt: new Date().toISOString(),
    dbEnabled: unified.dbEnabled,
    error: unified.authUsersError,
    summary: {
      totalUsers: users.length,
      onlineRegistered: onlineRegisteredUsers.length,
      idleRegistered: idleRegisteredUsers.length,
      onlineGuests: onlineGuestSessions.length,
      idleGuests: idleGuestSessions.length,
      onlineTotal: onlineRegisteredUsers.length + onlineGuestSessions.length,
      active24h: active24hCount,
      new7d: new7dCount,
      verifiedEmails: users.filter(u => u.emailConfirmed).length,
      telemetryOptIn: users.filter(u => u.telemetryEnabled).length,
      admins: users.filter(u => u.isAdmin).length
    },
    pagination: {
      page: curPage,
      pageSize: pSize,
      totalFiltered,
      totalPages
    },
    users: slice,
    activeGuestSessions: guestSessions.slice(0, 30).map(g => ({
      sessionId: g.sessionId,
      status: g.computedStatus,
      activeView: g.activeView,
      deviceType: g.deviceType,
      browser: g.browser,
      os: g.os,
      startedAt: g.startedAt,
      lastSeenAt: g.lastSeenAt,
      heartbeatCount: g.heartbeatCount
    }))
  };
}

/**
 * Privacy-Safe Single User Detail Inspector
 * Never exposes cycle notes, symptoms, moods, flow, memory text, or chat content.
 */
async function getUserDetailPayload(userId) {
  if (!userId || typeof userId !== 'string') {
    return { error: 'INVALID_USER_ID' };
  }

  const unified = await loadUnifiedUsersAndSessions();
  const baseUser = unified.users.find(u => u.id === userId) || null;
  const userSessions = unified.allSessions
    .filter(s => s.userId === userId)
    .sort((a, b) => Date.parse(b.lastSeenAt || 0) - Date.parse(a.lastSeenAt || 0))
    .slice(0, 15);

  let authDetail = null;
  let legacyClaimStatus = null;
  let recentGeminiCount = 0;

  if (isAdminDbConfigured()) {
    const [authRes, gemRes] = await Promise.all([
      getAuthUserById(userId),
      adminRest(`/gemini_telemetry?user_id=eq.${encodeURIComponent(userId)}&select=id,task,model_used,latency_ms,success,created_at&order=created_at.desc&limit=10`, { timeoutMs: 5000 })
    ]);
    if (authRes.ok && authRes.user) {
      authDetail = {
        emailConfirmedAt: authRes.user.email_confirmed_at || null,
        lastSignInAt: authRes.user.last_sign_in_at || null,
        updatedAt: authRes.user.updated_at || null,
        identities: Array.isArray(authRes.user.identities)
          ? authRes.user.identities.map(i => i.provider)
          : []
      };
      if (authRes.user.email) {
        const legRes = await adminRest(`/legacy_user_imports?email=eq.${encodeURIComponent(authRes.user.email.toLowerCase())}&select=email,created_at,claimed_at&limit=1`, { timeoutMs: 4000 });
        if (legRes.ok && Array.isArray(legRes.data) && legRes.data[0]) {
          legacyClaimStatus = {
            imported: true,
            claimed: Boolean(legRes.data[0].claimed_at),
            claimedAt: legRes.data[0].claimed_at || null
          };
        }
      }
    }
    if (gemRes.ok && Array.isArray(gemRes.data)) {
      recentGeminiCount = gemRes.data.length;
    }
  }

  if (!baseUser && !authDetail) {
    return { error: 'USER_NOT_FOUND' };
  }

  return {
    generatedAt: new Date().toISOString(),
    privacyMode: 'metadata_only_no_health_text',
    user: {
      ...(baseUser || { id: userId }),
      authDetail,
      legacyClaimStatus,
      recentGeminiCount
    },
    sessions: userSessions.map(s => ({
      sessionId: s.sessionId,
      status: s.computedStatus,
      activeView: s.activeView,
      deviceType: s.deviceType,
      browser: s.browser,
      os: s.os,
      startedAt: s.startedAt,
      lastSeenAt: s.lastSeenAt,
      heartbeatCount: s.heartbeatCount
    }))
  };
}

/**
 * Deep Telemetry, Product Funnels, Cohorts, Client Errors, Runtime Vitals & Audit Log
 */
async function getTelemetryDeepDivePayload({ range = '7d' } = {}) {
  const now = Date.now();
  const [unified, ts] = await Promise.all([
    loadUnifiedUsersAndSessions(),
    loadTimeSeriesTelemetry(range)
  ]);

  const { users, allSessions, mem } = unified;

  // Feature adoption & tab views
  const tabViews = { dial: 0, calendar: 0, syncing: 0, 'ai-coach': 0, analytics: 0, settings: 0 };
  const eventCategories = {};
  for (const ev of ts.events) {
    eventCategories[ev.category] = (eventCategories[ev.category] || 0) + 1;
    if (ev.category === 'view' && ev.action) {
      tabViews[ev.action] = (tabViews[ev.action] || 0) + 1;
    }
  }
  // Supplement tab views with active session view distribution if event log is sparse
  const sessionViewCounts = {};
  for (const s of allSessions) {
    const v = s.activeView || 'dial';
    sessionViewCounts[v] = (sessionViewCounts[v] || 0) + 1;
  }

  // Device, browser, OS breakdowns
  const devices = { desktop: 0, mobile: 0, tablet: 0 };
  const browsers = {};
  const operatingSystems = {};
  for (const s of allSessions) {
    const d = s.deviceType || 'desktop';
    devices[d] = (devices[d] || 0) + 1;
    const b = s.browser || 'Unknown';
    browsers[b] = (browsers[b] || 0) + 1;
    const o = s.os || 'Unknown';
    operatingSystems[o] = (operatingSystems[o] || 0) + 1;
  }

  // Retention cohort metrics (D1 / D7 / D30 returning accounts)
  const dayMs = 86400000;
  function calcRetention(minAgeDays, activeWithinDays) {
    const eligible = users.filter(u => u.createdAt && (now - Date.parse(u.createdAt)) >= minAgeDays * dayMs);
    if (eligible.length === 0) return { eligible: 0, retained: 0, rate: 0 };
    const retained = eligible.filter(u => {
      if (!u.lastSeenAt || !u.createdAt) return false;
      const deltaAfterSignup = Date.parse(u.lastSeenAt) - Date.parse(u.createdAt);
      return deltaAfterSignup >= activeWithinDays * dayMs;
    }).length;
    return {
      eligible: eligible.length,
      retained,
      rate: Math.round((retained / eligible.length) * 100)
    };
  }

  const cohorts = {
    d1: calcRetention(1, 1),
    d7: calcRetention(7, 7),
    d30: calcRetention(30, 30)
  };

  // Group client errors for clean triage
  const groupedErrorsMap = new Map();
  for (const err of ts.clientErrors) {
    const key = `${err.errorType}|${err.message.slice(0, 80)}`;
    const prev = groupedErrorsMap.get(key);
    if (!prev) {
      groupedErrorsMap.set(key, {
        errorType: err.errorType,
        message: err.message,
        source: err.source,
        viewName: err.viewName,
        deviceType: err.deviceType,
        count: 1,
        lastSeenAt: err.createdAt
      });
    } else {
      prev.count++;
      if (Date.parse(err.createdAt) > Date.parse(prev.lastSeenAt)) {
        prev.lastSeenAt = err.createdAt;
      }
    }
  }

  const memUsage = process.memoryUsage();
  const securityStats = getSecurityRuntimeStats();
  const authConfig = getAdminAuthConfigStatus();

  return {
    generatedAt: new Date().toISOString(),
    range: ts.rangeKey,
    heatmap: buildActivityHeatmap(allSessions, ts.events),
    tabViews: Object.entries(tabViews)
      .map(([view, count]) => ({ view, count, sessions: sessionViewCounts[view] || 0 }))
      .sort((a, b) => (b.count + b.sessions) - (a.count + a.sessions)),
    eventCategories: Object.entries(eventCategories)
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count),
    devices: Object.entries(devices).map(([label, count]) => ({ label, count })),
    browsers: Object.entries(browsers)
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6),
    operatingSystems: Object.entries(operatingSystems)
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6),
    cohorts,
    clientErrors: {
      total: ts.clientErrors.length,
      grouped: [...groupedErrorsMap.values()].sort((a, b) => b.count - a.count).slice(0, 25),
      recent: ts.clientErrors.slice(0, 40)
    },
    runtime: {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      deploymentMode: process.env.VERCEL === '1' ? 'Vercel Serverless' : 'Node.js Server',
      uptimeSec: Math.round(process.uptime()),
      memory: {
        rssBytes: memUsage.rss,
        rssFormatted: formatBytes(memUsage.rss),
        heapUsedBytes: memUsage.heapUsed,
        heapUsedFormatted: formatBytes(memUsage.heapUsed),
        heapTotalBytes: memUsage.heapTotal,
        heapTotalFormatted: formatBytes(memUsage.heapTotal),
        heapPct: memUsage.heapTotal > 0 ? Math.round((memUsage.heapUsed / memUsage.heapTotal) * 100) : 0
      },
      totalHttpRequests: mem.totalHttpRequests,
      totalApiErrors: mem.totalApiErrors,
      inMemorySessions: mem.sessions.length,
      security: securityStats,
      adminAuth: authConfig
    },
    auditLogs: ts.adminAudit.slice(0, 60)
  };
}

/**
 * Generate CSV or JSON downloadable reports
 */
async function exportReportPayload({ type = 'users', format = 'json', range = '30d' } = {}) {
  const fmt = String(format || 'json').toLowerCase() === 'csv' ? 'csv' : 'json';
  const kind = String(type || 'users').toLowerCase();
  const dateStamp = new Date().toISOString().slice(0, 10);

  if (kind === 'users') {
    const data = await getUsersPayload({ page: 1, pageSize: 100 });
    const rows = data.users.map(u => ({
      id: u.id,
      name: u.name,
      email: u.email,
      provider: u.provider,
      presence_status: u.presenceStatus,
      last_seen_at: u.lastSeenAt || '',
      last_seen_source: u.lastSeenSource,
      created_at: u.createdAt || '',
      email_confirmed: u.emailConfirmed,
      active_view: u.activeView || '',
      device_type: u.deviceType || '',
      session_count: u.sessionCount,
      cycle_logs_count: u.counts.cycleLogs,
      ai_memories_count: u.counts.aiMemories,
      ai_chats_count: u.counts.aiChats,
      partner_shares_count: u.counts.partnerShares,
      telemetry_opt_in: u.telemetryEnabled
    }));
    if (fmt === 'csv') {
      const headers = Object.keys(rows[0] || {
        id: '', name: '', email: '', provider: '', presence_status: '', last_seen_at: '', created_at: ''
      });
      return {
        contentType: 'text/csv; charset=utf-8',
        filename: `aifycycle-users-${dateStamp}.csv`,
        body: toCsv(headers, rows)
      };
    }
    return {
      contentType: 'application/json; charset=utf-8',
      filename: `aifycycle-users-${dateStamp}.json`,
      body: JSON.stringify({ exportedAt: new Date().toISOString(), summary: data.summary, users: rows }, null, 2)
    };
  }

  if (kind === 'integrity') {
    const data = await getDatabaseIntegrityPayload();
    if (fmt === 'csv') {
      const headers = ['id', 'category', 'title', 'status', 'metric', 'detail', 'remediation'];
      return {
        contentType: 'text/csv; charset=utf-8',
        filename: `aifycycle-db-integrity-${dateStamp}.csv`,
        body: toCsv(headers, data.checks)
      };
    }
    return {
      contentType: 'application/json; charset=utf-8',
      filename: `aifycycle-db-integrity-${dateStamp}.json`,
      body: JSON.stringify(data, null, 2)
    };
  }

  if (kind === 'gemini') {
    const data = await getGeminiHealthPayload({ range });
    if (fmt === 'csv') {
      const headers = ['createdAt', 'task', 'requestedModel', 'modelUsed', 'cascaded', 'statusCode', 'success', 'latencyMs', 'totalTokens', 'errorCode'];
      return {
        contentType: 'text/csv; charset=utf-8',
        filename: `aifycycle-gemini-telemetry-${dateStamp}.csv`,
        body: toCsv(headers, data.recentCalls)
      };
    }
    return {
      contentType: 'application/json; charset=utf-8',
      filename: `aifycycle-gemini-telemetry-${dateStamp}.json`,
      body: JSON.stringify(data, null, 2)
    };
  }

  if (kind === 'telemetry') {
    const data = await getTelemetryDeepDivePayload({ range });
    if (fmt === 'csv') {
      const headers = ['errorType', 'message', 'source', 'viewName', 'deviceType', 'count', 'lastSeenAt'];
      return {
        contentType: 'text/csv; charset=utf-8',
        filename: `aifycycle-client-errors-${dateStamp}.csv`,
        body: toCsv(headers, data.clientErrors.grouped)
      };
    }
    return {
      contentType: 'application/json; charset=utf-8',
      filename: `aifycycle-telemetry-${dateStamp}.json`,
      body: JSON.stringify(data, null, 2)
    };
  }

  // Full snapshot JSON
  const [overview, integrity, gemini, telemetry] = await Promise.all([
    getOverviewPayload({ range }),
    getDatabaseIntegrityPayload(),
    getGeminiHealthPayload({ range }),
    getTelemetryDeepDivePayload({ range })
  ]);
  return {
    contentType: 'application/json; charset=utf-8',
    filename: `aifycycle-full-ops-snapshot-${dateStamp}.json`,
    body: JSON.stringify({
      exportedAt: new Date().toISOString(),
      application: 'AifyCycle Ops',
      privacyMode: 'metadata_only_no_health_text',
      overview,
      integrity,
      gemini,
      telemetry
    }, null, 2)
  };
}

module.exports = {
  csvCell,
  toCsv,
  buildOnlineTimelineSeries,
  buildUserGrowthSeries,
  buildActivityHeatmap,
  getOverviewPayload,
  getUsersPayload,
  getUserDetailPayload,
  getDatabaseIntegrityPayload,
  getGeminiHealthPayload,
  getTelemetryDeepDivePayload,
  exportReportPayload
};
