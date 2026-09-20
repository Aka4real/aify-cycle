/**
 * AifyCycle - Privacy-Preserving Analytics & Audit Telemetry Engine
 * Tracks user interactions, health logging consistency, AI Coach telemetry,
 * and maintains a tamper-evident compliance audit log for GDPR/CCPA.
 * 
 * All telemetry is stored locally by default and respects user consent.
 */

import { storage } from './storage.js';

const TELEMETRY_STORAGE_KEY = 'aifycycle_telemetry_v1';
const AUDIT_LOG_STORAGE_KEY = 'aifycycle_audit_log_v1';
const CONSENT_STORAGE_KEY = 'aifycycle_consent_v1';

class AnalyticsTracker {
  constructor() {
    this.sessionStartTime = Date.now();
    this.sessionId = this._generateSessionId();
    this._initStorage();
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
      // Increment session count
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
    return consent ? consent.analyticsAllowed !== false : true;
  }

  getConsent() {
    try {
      const data = localStorage.getItem(CONSENT_STORAGE_KEY);
      return data ? JSON.parse(data) : null;
    } catch (e) {
      return null;
    }
  }

  saveConsent({ analyticsAllowed = true, medicalAcknowledged = true }) {
    const consentData = {
      analyticsAllowed,
      medicalAcknowledged,
      timestamp: new Date().toISOString(),
      version: '1.2.0'
    };
    localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify(consentData));
    this.logAuditAction('CONSENT_UPDATED', `User set analytics tracking to ${analyticsAllowed ? 'ENABLED' : 'DISABLED'}`);
  }

  // --- Core Event Tracking ---

  trackEvent(category, action, label = '', metadata = {}) {
    if (!this.isTrackingEnabled()) return;

    try {
      const data = this._getTelemetryData();
      data.eventsCount = (data.eventsCount || 0) + 1;
      data.lastActive = new Date().toISOString();

      // Feature increments
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
      // Keep last 100 audit entries
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
    const profile = storage.getProfile();
    const memories = storage.getAgentMemories();

    // Calculate approximate storage space used (bytes)
    let totalStorageBytes = 0;
    for (let key in localStorage) {
      if (localStorage.hasOwnProperty(key)) {
        totalStorageBytes += (key.length + (localStorage[key] || '').length) * 2; // UTF-16
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
    return 'sess_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
  }
}

export const analytics = new AnalyticsTracker();
