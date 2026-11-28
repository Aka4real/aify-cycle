/**
 * AifyCycle - Local-First Analytics, Live Presence Heartbeat & Operational Telemetry
 * - Maintains local-first privacy audit logs and opt-in usage analytics.
 * - Sends lightweight presence heartbeats (45s interval + visibility/pagehide beacon)
 *   to /api/telemetry/heartbeat so the Admin Panel accurately tracks Online Now & Last Seen
 *   for both Registered and Guest sessions.
 * - Strictly privacy-safe: never transmits cycle notes, symptoms, moods, flow, or chat text.
 */

import { storage } from './storage.js';
import { supabaseService } from './supabase-client.js';

const TELEMETRY_STORAGE_KEY = 'aifycycle_telemetry_v1';
const AUDIT_LOG_STORAGE_KEY = 'aifycycle_audit_log_v1';
const CONSENT_STORAGE_KEY = 'aifycycle_consent_v1';
const SESSION_ID_KEY = 'aifycycle_presence_sid_v1';
const HEARTBEAT_ENDPOINT = '/api/telemetry/heartbeat';
const HEARTBEAT_INTERVAL_MS = 45 * 1000;
const APP_VERSION = '1.1.0';

function detectClientDevice() {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
  const width = typeof window !== 'undefined' ? window.innerWidth || 1280 : 1280;
  if (/iPad|Tablet/i.test(ua) || (width >= 640 && width < 1024 && /Touch|Mobile/i.test(ua))) {
    return 'tablet';
  }
  if (/Mobile|iPhone|Android/i.test(ua) || width < 640) {
    return 'mobile';
  }
  return 'desktop';
}

function scrubErrorText(raw) {
  return String(raw || '')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
    .replace(/(access_token|refresh_token|apikey|token|code)=[^&\s]+/gi, '$1=[REDACTED]')
    .trim()
    .slice(0, 300);
}

class AnalyticsTracker {
  constructor() {
    this.sessionStartTime = Date.now();
    this.sessionId = this._resolveSessionId();
    this._eventQueue = [];
    this._errorQueue = [];
    this._heartbeatTimer = null;
    this._presenceContextFn = null;
    this._presenceActive = false;
    this._errorCaptureInstalled = false;
    this._lastAccessToken = null;
    this._initStorage();
  }

  _resolveSessionId() {
    try {
      const existing = sessionStorage.getItem(SESSION_ID_KEY);
      if (existing) return existing;
      const created = this._generateSessionId();
      sessionStorage.setItem(SESSION_ID_KEY, created);
      return created;
    } catch (e) {
      return this._generateSessionId();
    }
  }

  _initStorage() {
    if (!localStorage.getItem(TELEMETRY_STORAGE_KEY)) {
      const initialTelemetry = {
        totalSessions: 1,
        firstSeen: new Date().toISOString(),
        lastActive: new Date().toISOString(),
        eventsCount: 0,
        tabViews: {},
        featureUsage: {
          periodLogs: 0,
          symptomsLogged: 0,
          cycleSettingsUpdates: 0,
          aiCoachQueries: 0,
          aiLiveGeminiQueries: 0,
          aiLocalQueries: 0,
          calendarInteractions: 0,
          syncingGuideViews: 0,
          backupExports: 0
        },
        aiPerformance: {
          totalResponseTimeMs: 0,
          queryCount: 0,
          avgResponseTimeMs: 0
        }
      };
      localStorage.setItem(TELEMETRY_STORAGE_KEY, JSON.stringify(initialTelemetry));
    } else {
      const data = this._getTelemetryData();
      data.totalSessions = (data.totalSessions || 0) + 1;
      data.lastActive = new Date().toISOString();
      this._saveTelemetryData(data);
    }

    if (!localStorage.getItem(AUDIT_LOG_STORAGE_KEY)) {
      localStorage.setItem(AUDIT_LOG_STORAGE_KEY, JSON.stringify([
        {
          id: 'audit_init',
          action: 'SESSION_STARTED',
          category: 'system',
          detail: 'User session initialized with local-first privacy sandbox.',
          timestamp: new Date().toISOString()
        }
      ]));
    }
  }

  // --- Consent & User Preferences ---

  isTrackingEnabled() {
    const consent = this.getConsent();
    return Boolean(consent && consent.analyticsAllowed === true);
  }

  getConsent() {
    try {
      const data = localStorage.getItem(CONSENT_STORAGE_KEY);
      return data ? JSON.parse(data) : null;
    } catch (e) {
      return null;
    }
  }

  saveConsent({ analyticsAllowed = false, medicalAcknowledged = false }) {
    const consentData = {
      analyticsAllowed,
      medicalAcknowledged,
      timestamp: new Date().toISOString(),
      version: '1.2.0'
    };
    localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify(consentData));
    this.logAuditAction('CONSENT_UPDATED', `User set analytics tracking to ${analyticsAllowed ? 'ENABLED' : 'DISABLED'}`);
  }

  // --- Live Presence Heartbeat & Operational Error Reporting ---

  startPresenceHeartbeat(getContextFn) {
    this._presenceContextFn = typeof getContextFn === 'function' ? getContextFn : () => ({});
    this._installErrorCapture();

    if (!this._presenceActive) {
      this._presenceActive = true;

      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', () => {
          if (!this._presenceActive) return;
          this.sendHeartbeat(document.hidden ? 'idle' : 'online');
        });
      }

      if (typeof window !== 'undefined') {
        window.addEventListener('pagehide', () => {
          this.sendOfflineBeacon();
        });
      }
    }

    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
    }

    this.sendHeartbeat('online');
    this._heartbeatTimer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      this.sendHeartbeat('online');
    }, HEARTBEAT_INTERVAL_MS);
  }

  stopPresenceHeartbeat() {
    this._presenceActive = false;
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  async _getSupabaseAccessToken() {
    try {
      const client = supabaseService.getClient();
      if (!client) return null;
      const { data: { session } } = await client.auth.getSession();
      this._lastAccessToken = session?.access_token || null;
      return this._lastAccessToken;
    } catch (e) {
      return this._lastAccessToken;
    }
  }

  _buildHeartbeatPayload(status = 'online', includeTokenInBody = false) {
    const ctx = typeof this._presenceContextFn === 'function' ? (this._presenceContextFn() || {}) : {};
    const events = this._eventQueue.splice(0, 20);
    const errors = this._errorQueue.splice(0, 8);

    const body = {
      sessionId: this.sessionId,
      status,
      activeView: ctx.activeView || 'dial',
      isGuest: Boolean(ctx.isGuest),
      provider: ctx.provider || (ctx.isGuest ? 'guest' : 'email'),
      deviceType: detectClientDevice(),
      appVersion: APP_VERSION,
      events,
      errors
    };

    if (includeTokenInBody && this._lastAccessToken) {
      body.accessToken = this._lastAccessToken;
    }
    return body;
  }

  async sendHeartbeat(status = 'online') {
    if (typeof fetch !== 'function') return;
    try {
      const token = await this._getSupabaseAccessToken();
      const payload = this._buildHeartbeatPayload(status, false);
      const headers = { 'Content-Type': 'application/json' };
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }

      await fetch(HEARTBEAT_ENDPOINT, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        keepalive: status === 'offline'
      });
    } catch (e) {
      // Never disrupt end-user UX if telemetry endpoint is offline
    }
  }

  sendOfflineBeacon() {
    try {
      const payload = this._buildHeartbeatPayload('offline', true);
      const json = JSON.stringify(payload);
      if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
        const blob = new Blob([json], { type: 'text/plain;charset=UTF-8' });
        navigator.sendBeacon(HEARTBEAT_ENDPOINT, blob);
      } else if (typeof fetch === 'function') {
        fetch(HEARTBEAT_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: json,
          keepalive: true
        }).catch(() => {});
      }
    } catch (e) {}
  }

  _installErrorCapture() {
    if (this._errorCaptureInstalled || typeof window === 'undefined') return;
    this._errorCaptureInstalled = true;

    window.addEventListener('error', (event) => {
      const msg = scrubErrorText(event?.message || event?.error?.message || 'Script error');
      const src = scrubErrorText(event?.filename ? `${event.filename}:${event.lineno || 0}` : '');
      this.reportClientError('runtime', msg, src);
    });

    window.addEventListener('unhandledrejection', (event) => {
      const reason = event?.reason;
      const msg = scrubErrorText(reason?.message || String(reason || 'Unhandled promise rejection'));
      this.reportClientError('unhandledrejection', msg, 'promise');
    });
  }

  reportClientError(errorType = 'runtime', message = '', source = '') {
    const cleanMsg = scrubErrorText(message);
    if (!cleanMsg) return;
    const ctx = typeof this._presenceContextFn === 'function' ? (this._presenceContextFn() || {}) : {};
    this._errorQueue.push({
      errorType: String(errorType || 'runtime').slice(0, 32),
      message: cleanMsg,
      source: scrubErrorText(source).slice(0, 140),
      viewName: ctx.activeView || 'dial',
      timestamp: new Date().toISOString()
    });
    if (this._errorQueue.length > 15) {
      this._errorQueue.shift();
    }
  }

  // --- Core Event Tracking ---

  trackEvent(category, action, label = '', metadata = {}) {
    if (!this.isTrackingEnabled()) return;

    try {
      const data = this._getTelemetryData();
      data.eventsCount = (data.eventsCount || 0) + 1;
      data.lastActive = new Date().toISOString();

      if (category === 'view') {
        data.tabViews[action] = (data.tabViews[action] || 0) + 1;
      }

      if (category === 'cycle') {
        if (action === 'period_start_updated') data.featureUsage.periodLogs++;
        if (action === 'settings_updated') data.featureUsage.cycleSettingsUpdates++;
      }

      if (category === 'symptom') {
        data.featureUsage.symptomsLogged++;
      }

      if (category === 'ai_coach') {
        data.featureUsage.aiCoachQueries++;
        if (metadata.mode === 'server' || metadata.mode === 'client') {
          data.featureUsage.aiLiveGeminiQueries++;
        } else {
          data.featureUsage.aiLocalQueries++;
        }

        if (metadata.latencyMs) {
          data.aiPerformance.totalResponseTimeMs += metadata.latencyMs;
          data.aiPerformance.queryCount++;
          data.aiPerformance.avgResponseTimeMs = Math.round(
            data.aiPerformance.totalResponseTimeMs / data.aiPerformance.queryCount
          );
        }
      }

      if (category === 'backup' && action === 'export') {
        data.featureUsage.backupExports++;
      }

      this._saveTelemetryData(data);

      // Queue strictly sanitized operational telemetry (never dates/symptoms/notes/text)
      const safeMeta = {};
      if (metadata && typeof metadata === 'object') {
        if (typeof metadata.mode === 'string') safeMeta.mode = metadata.mode.slice(0, 24);
        if (Number.isFinite(metadata.latencyMs)) safeMeta.latencyMs = Math.round(metadata.latencyMs);
      }
      this._eventQueue.push({
        category: String(category).slice(0, 32),
        action: String(action).slice(0, 48),
        label: category === 'view' ? String(label).slice(0, 32) : '',
        metadata: safeMeta,
        timestamp: new Date().toISOString()
      });
      if (this._eventQueue.length > 40) {
        this._eventQueue.shift();
      }
    } catch (e) {
      console.warn('Telemetry tracking error:', e);
    }
  }

  // --- Compliance Audit Log (GDPR / CCPA / HIPAA transparency) ---

  logAuditAction(action, detail) {
    try {
      const logs = this.getAuditLog();
      const entry = {
        id: `audit_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
        action,
        detail,
        timestamp: new Date().toISOString()
      };

      logs.unshift(entry);
      const trimmed = logs.slice(0, 100);
      localStorage.setItem(AUDIT_LOG_STORAGE_KEY, JSON.stringify(trimmed));
    } catch (e) {
      console.warn('Audit log write error:', e);
    }
  }

  getAuditLog() {
    try {
      const data = localStorage.getItem(AUDIT_LOG_STORAGE_KEY);
      return data ? JSON.parse(data) : [];
    } catch (e) {
      return [];
    }
  }

  // --- Telemetry Reporting & Metrics ---

  getTelemetrySummary() {
    const data = this._getTelemetryData();
    const logs = storage.getAllLogs();
    const memories = storage.getAgentMemories();

    let totalStorageBytes = 0;
    for (let key in localStorage) {
      if (Object.prototype.hasOwnProperty.call(localStorage, key)) {
        totalStorageBytes += (key.length + (localStorage[key] || '').length) * 2;
      }
    }

    return {
      totalSessions: data.totalSessions || 1,
      totalEvents: data.eventsCount || 0,
      firstSeen: data.firstSeen,
      lastActive: data.lastActive,
      totalLogsCount: Object.keys(logs).length,
      totalMemoriesCount: memories.length,
      aiCoachTotalQueries: data.featureUsage.aiCoachQueries || 0,
      aiLiveQueries: data.featureUsage.aiLiveGeminiQueries || 0,
      aiLocalQueries: data.featureUsage.aiLocalQueries || 0,
      aiAvgLatencyMs: data.aiPerformance.avgResponseTimeMs || 0,
      storageFootprintKb: (totalStorageBytes / 1024).toFixed(2),
      trackingConsentActive: this.isTrackingEnabled(),
      recentAuditEntries: this.getAuditLog().slice(0, 8)
    };
  }

  exportComplianceReport() {
    const report = {
      reportType: 'GDPR / CCPA Data & Privacy Compliance Audit',
      application: 'AifyCycle',
      version: '1.2.0',
      exportedAt: new Date().toISOString(),
      consentStatus: this.getConsent(),
      telemetry: this._getTelemetryData(),
      auditLog: this.getAuditLog(),
      profile: storage.getProfile(),
      totalDataPoints: Object.keys(storage.getAllLogs()).length
    };

    return JSON.stringify(report, null, 2);
  }

  purgeAllTelemetry() {
    localStorage.removeItem(TELEMETRY_STORAGE_KEY);
    localStorage.removeItem(AUDIT_LOG_STORAGE_KEY);
    this._initStorage();
  }

  // --- Internal Helpers ---

  _getTelemetryData() {
    try {
      const data = localStorage.getItem(TELEMETRY_STORAGE_KEY);
      return data ? JSON.parse(data) : {};
    } catch (e) {
      return {};
    }
  }

  _saveTelemetryData(data) {
    try {
      localStorage.setItem(TELEMETRY_STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      console.warn('Error saving telemetry data:', e);
    }
  }

  _generateSessionId() {
    return 'sess_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }
}

export const analytics = new AnalyticsTracker();
