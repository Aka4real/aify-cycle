/**
 * AifyCycle - Admin & System Console Controller
 * Live diagnostics for Gemini gateway cascade, Supabase cloud sync,
 * usage telemetry, filterable privacy audit log, storage footprint, and GDPR tools.
 */

import { storage } from './storage.js';
import { analytics } from './analytics-tracker.js';
import { supabaseService } from './supabase-client.js';
import { formatDateKey } from './cycle-engine.js';
import { escapeHtml } from './dom-utils.js';
import { ui } from './ui-components.js';

const SUN_SVG = '<svg class="ui-icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>';
const MOON_SVG = '<svg class="ui-icon" viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>';

class AdminConsole {
  constructor() {
    this.auditSearch = '';
    this.auditActionFilter = 'all';
    this.lastGatewayLatencyMs = null;
  }

  async init() {
    this.setupTheme();
    this.setupScrollHeader();
    this.setupSidebarHighlight();
    this.attachListeners();
    await this.refreshAll();
  }

  setupTheme() {
    const saved = storage.getTheme();
    document.documentElement.setAttribute('data-theme', saved);
    const iconEl = document.getElementById('admin-theme-icon');
    if (iconEl) {
      iconEl.innerHTML = saved === 'light' ? MOON_SVG : SUN_SVG;
    }
  }

  toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    const next = current === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    storage.saveTheme(next);
    const iconEl = document.getElementById('admin-theme-icon');
    if (iconEl) {
      iconEl.innerHTML = next === 'light' ? MOON_SVG : SUN_SVG;
    }
    ui.showToast(`Switched to ${next} theme`, '');
  }

  setupScrollHeader() {
    const header = document.getElementById('admin-top-header');
    if (!header) return;
    const onScroll = () => {
      header.classList.toggle('is-scrolled', window.scrollY > 8);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  setupSidebarHighlight() {
    const links = Array.from(document.querySelectorAll('.admin-nav-link'));
    links.forEach(link => {
      link.addEventListener('click', () => {
        links.forEach(l => l.classList.remove('active'));
        link.classList.add('active');
      });
    });
  }

  async refreshAll() {
    const refreshedEl = document.getElementById('admin-last-refreshed');
    if (refreshedEl) {
      const stamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      refreshedEl.textContent = `Diagnostics refreshed at ${stamp}. All personal health data remains scoped to your browser or authenticated account.`;
    }

    this.renderLocalTelemetry();
    this.renderAuditLog();
    this.renderStorageInspector();

    await Promise.all([
      this.refreshGatewayDiagnostics(),
      this.refreshSupabaseDiagnostics()
    ]);
  }

  async refreshGatewayDiagnostics() {
    const kpiModel = document.getElementById('kpi-ai-model');
    const kpiMode = document.getElementById('kpi-ai-mode');
    const gwMode = document.getElementById('gw-mode');
    const gwPrimary = document.getElementById('gw-configured-model');
    const gwActive = document.getElementById('gw-active-model');
    const gwCascade = document.getElementById('gw-cascade-enabled');
    const gwLatency = document.getElementById('gw-probe-latency');
    const gwClientFlag = document.getElementById('gw-client-flag');
    const tbody = document.getElementById('gw-cascade-tbody');

    const profile = storage.getProfile();
    if (gwClientFlag) {
      gwClientFlag.textContent = profile.aiCoachEnabled === false ? 'Disabled in settings' : 'Enabled';
    }

    const t0 = performance.now();
    try {
      const res = await fetch('/api/gemini/status', { method: 'GET' });
      const elapsed = Math.max(1, Math.round(performance.now() - t0));
      this.lastGatewayLatencyMs = elapsed;

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      if (kpiModel) kpiModel.textContent = data.configured ? (data.model || 'Gemini') : 'Local fallback';
      if (kpiMode) kpiMode.textContent = data.configured ? `Proxy active (${elapsed} ms)` : 'No server API key set';
      if (gwMode) gwMode.textContent = data.mode || (data.configured ? 'server_proxy' : 'unconfigured');
      if (gwPrimary) gwPrimary.textContent = data.configuredModel || data.model || '--';
      if (gwActive) gwActive.textContent = data.model || '--';
      if (gwCascade) gwCascade.textContent = data.cascadeEnabled ? 'Enabled (3.5s fast-fail)' : 'Disabled';
      if (gwLatency) gwLatency.textContent = `${elapsed} ms`;

      if (tbody) {
        const ordered = [...new Set([data.configuredModel, ...(data.fallbackModels || [])].filter(Boolean))];
        tbody.innerHTML = ordered.map((modelId, idx) => {
          const isActive = modelId === data.model;
          const isPrimary = idx === 0;
          let statusBadge = '<span class="status-cell status-cell-info">Standby fallback</span>';
          if (!data.configured) {
            statusBadge = '<span class="status-cell status-cell-warn">Unconfigured</span>';
          } else if (isActive) {
            statusBadge = '<span class="status-cell status-cell-ok">Active route</span>';
          } else if (isPrimary) {
            statusBadge = '<span class="status-cell status-cell-warn">Cooling down</span>';
          }

          return `
            <tr>
              <td>#${idx + 1}</td>
              <td>${escapeHtml(modelId)}</td>
              <td>${isPrimary ? 'Primary target' : 'Cascade fallback'}</td>
              <td>${statusBadge}</td>
            </tr>
          `;
        }).join('');
      }
    } catch (err) {
      if (kpiModel) kpiModel.textContent = 'Offline local';
      if (kpiMode) kpiMode.textContent = 'Gateway unreachable';
      if (gwMode) gwMode.textContent = 'Offline / unreachable';
      if (gwLatency) gwLatency.textContent = 'Failed';
      if (tbody) {
        tbody.innerHTML = `<tr><td colspan="4">Could not reach /api/gemini/status (${escapeHtml(err.message)}). Local wellness fallback remains active.</td></tr>`;
      }
    }
  }

  async refreshSupabaseDiagnostics() {
    const kpiStatus = document.getElementById('kpi-supabase-status');
    const kpiMeta = document.getElementById('kpi-supabase-meta');
    const sbState = document.getElementById('sb-state');
    const sbSource = document.getElementById('sb-source');
    const sbHost = document.getElementById('sb-host');
    const sbSession = document.getElementById('sb-session');
    const provGoogle = document.getElementById('sb-provider-google');
    const provApple = document.getElementById('sb-provider-apple');
    const provAnon = document.getElementById('sb-provider-anon');
    const urlInput = document.getElementById('admin-sb-url');
    const keyInput = document.getElementById('admin-sb-key');

    // Prefill saved custom override if present
    try {
      const saved = localStorage.getItem('aifycycle_supabase_config_v1');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (urlInput && !urlInput.value) urlInput.value = parsed.url || '';
        if (keyInput && !keyInput.value) keyInput.value = parsed.anonKey || '';
      }
    } catch (e) {}

    const localSession = storage.getAuthSession();
    if (sbSession) {
      if (localSession?.isLoggedIn && localSession.user) {
        const u = localSession.user;
        sbSession.textContent = u.isGuest
          ? 'Private guest mode'
          : `${u.email || u.name} (${u.provider || 'email'})`;
      } else {
        sbSession.textContent = 'Signed out';
      }
    }

    try {
      await supabaseService.init();
      const info = supabaseService.getConnectionInfo();
      const providers = await supabaseService.getAuthProviderStatus();

      if (info.configured) {
        if (kpiStatus) kpiStatus.textContent = 'Connected';
        if (kpiMeta) {
          kpiMeta.textContent = info.host || 'Supabase Cloud';
          kpiMeta.title = info.host || 'Supabase Cloud';
        }
        if (sbState) sbState.innerHTML = '<span class="status-cell status-cell-ok">Connected</span>';
        if (sbSource) sbSource.textContent = info.source || 'server';
        if (sbHost) sbHost.textContent = info.host || '--';
      } else {
        if (kpiStatus) kpiStatus.textContent = 'Local-first';
        if (kpiMeta) kpiMeta.textContent = 'Browser sandbox only';
        if (sbState) sbState.innerHTML = '<span class="status-cell status-cell-warn">Local sandbox</span>';
        if (sbSource) sbSource.textContent = 'None configured';
        if (sbHost) sbHost.textContent = 'None (local-first)';
      }

      const formatProvider = (val) => {
        if (val === true) return '<span class="status-cell status-cell-ok">Enabled</span>';
        if (val === false) return '<span class="status-cell status-cell-warn">Disabled</span>';
        return 'Unavailable';
      };

      if (provGoogle) provGoogle.innerHTML = formatProvider(providers.google);
      if (provApple) provApple.innerHTML = formatProvider(providers.apple);
      if (provAnon) provAnon.innerHTML = formatProvider(providers.anonymous);
    } catch (err) {
      if (kpiStatus) kpiStatus.textContent = 'Local-first';
      if (kpiMeta) kpiMeta.textContent = 'Cloud unavailable';
      if (sbState) sbState.innerHTML = '<span class="status-cell status-cell-warn">Offline fallback</span>';
    }
  }

  renderLocalTelemetry() {
    const summary = analytics.getTelemetrySummary();
    let rawTelemetry = {};
    try {
      rawTelemetry = JSON.parse(localStorage.getItem('aifycycle_telemetry_v1') || '{}');
    } catch (e) {}

    const kpiStorage = document.getElementById('kpi-storage-kb');
    const kpiRecords = document.getElementById('kpi-records-meta');
    const kpiConsent = document.getElementById('kpi-consent-status');
    const kpiSessions = document.getElementById('kpi-sessions-meta');

    if (kpiStorage) kpiStorage.textContent = `${summary.storageFootprintKb} KB`;
    if (kpiRecords) kpiRecords.textContent = `${summary.totalLogsCount} logs · ${summary.totalMemoriesCount} notes`;
    if (kpiConsent) kpiConsent.textContent = summary.trackingConsentActive ? 'Opted in' : 'Off (default)';
    if (kpiSessions) kpiSessions.textContent = `${summary.totalSessions} local sessions`;

    const toggle = document.getElementById('admin-telemetry-toggle');
    if (toggle) toggle.checked = summary.trackingConsentActive;

    const telSessions = document.getElementById('tel-sessions');
    const telFirstSeen = document.getElementById('tel-first-seen');
    const telAiTotal = document.getElementById('tel-ai-total');
    const telAiSplit = document.getElementById('tel-ai-split');
    const telAiLatency = document.getElementById('tel-ai-latency');
    const telEventsTotal = document.getElementById('tel-events-total');
    const telVercel = document.getElementById('tel-vercel-status');

    if (telSessions) telSessions.textContent = String(summary.totalSessions);
    if (telFirstSeen) {
      telFirstSeen.textContent = summary.firstSeen
        ? `First seen ${new Date(summary.firstSeen).toLocaleDateString()}`
        : 'First seen: today';
    }
    if (telAiTotal) telAiTotal.textContent = String(summary.aiCoachTotalQueries);
    if (telAiSplit) telAiSplit.textContent = `${summary.aiLiveQueries} Live · ${summary.aiLocalQueries} Local`;
    if (telAiLatency) telAiLatency.textContent = summary.aiAvgLatencyMs > 0 ? `${summary.aiAvgLatencyMs} ms` : '--';
    if (telEventsTotal) telEventsTotal.textContent = String(summary.totalEvents);
    if (telVercel) {
      const host = window.location.hostname;
      const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '';
      telVercel.textContent = isLocal ? 'Disabled on localhost' : 'Active on production';
    }

    const tbody = document.getElementById('tel-feature-tbody');
    if (tbody) {
      const usage = rawTelemetry.featureUsage || {};
      const tabViews = rawTelemetry.tabViews || {};

      const rows = [
        ['Cycle compass view', 'Navigation', tabViews.dial || 0],
        ['Calendar view', 'Navigation', tabViews.calendar || 0],
        ['Cycle syncing view', 'Navigation', tabViews.syncing || 0],
        ['Wellness guide view', 'Navigation', tabViews['ai-coach'] || 0],
        ['Insights view', 'Navigation', tabViews.analytics || 0],
        ['Period start updates', 'Cycle tracking', usage.periodLogs || 0],
        ['Symptom entries logged', 'Cycle tracking', usage.symptomsLogged || 0],
        ['AI coach queries (live)', 'AI gateway', usage.aiLiveGeminiQueries || 0],
        ['AI coach queries (local)', 'AI gateway', usage.aiLocalQueries || 0],
        ['Backup exports', 'Data portability', usage.backupExports || 0]
      ];

      tbody.innerHTML = rows.map(([name, cat, count]) => `
        <tr>
          <td>${escapeHtml(name)}</td>
          <td>${escapeHtml(cat)}</td>
          <td>${Number(count)}</td>
        </tr>
      `).join('');
    }
  }

  renderAuditLog() {
    const allLogs = analytics.getAuditLog();
    const selectEl = document.getElementById('audit-action-filter');
    const tbody = document.getElementById('admin-audit-tbody');

    if (selectEl) {
      const currentVal = this.auditActionFilter;
      const uniqueActions = [...new Set(allLogs.map(item => item.action).filter(Boolean))].sort();
      selectEl.innerHTML = '<option value="all">All action types</option>' +
        uniqueActions.map(a => `<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`).join('');
      selectEl.value = uniqueActions.includes(currentVal) ? currentVal : 'all';
    }

    if (!tbody) return;

    const query = this.auditSearch.trim().toLowerCase();
    const filtered = allLogs.filter(entry => {
      if (this.auditActionFilter !== 'all' && entry.action !== this.auditActionFilter) return false;
      if (query) {
        const hay = `${entry.action || ''} ${entry.detail || ''}`.toLowerCase();
        return hay.includes(query);
      }
      return true;
    });

    if (filtered.length === 0) {
      tbody.innerHTML = '<tr><td colspan="3">No audit entries match the current filter.</td></tr>';
      return;
    }

    tbody.innerHTML = filtered.slice(0, 40).map(entry => {
      const dt = new Date(entry.timestamp);
      const formatted = Number.isNaN(dt.getTime())
        ? '--'
        : `${dt.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
      return `
        <tr>
          <td><span class="status-cell status-cell-info">${escapeHtml(entry.action || 'EVENT')}</span></td>
          <td>${escapeHtml(entry.detail || '')}</td>
          <td>${escapeHtml(formatted)}</td>
        </tr>
      `;
    }).join('');
  }

  renderStorageInspector() {
    const tbody = document.getElementById('admin-storage-tbody');
    if (!tbody) return;

    const rows = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith('aify')) continue;
      const val = localStorage.getItem(key) || '';
      const bytes = (key.length + val.length) * 2;

      let summary = 'Scalar value';
      try {
        const parsed = JSON.parse(val);
        if (Array.isArray(parsed)) {
          summary = `${parsed.length} array items`;
        } else if (parsed && typeof parsed === 'object') {
          summary = `${Object.keys(parsed).length} object fields`;
        }
      } catch (e) {
        summary = `${val.length} characters`;
      }

      rows.push({ key, summary, kb: (bytes / 1024).toFixed(2), bytes });
    }

    rows.sort((a, b) => b.bytes - a.bytes);

    if (rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="3">No AifyCycle keys currently stored in localStorage.</td></tr>';
      return;
    }

    tbody.innerHTML = rows.map(r => `
      <tr>
        <td>${escapeHtml(r.key)}</td>
        <td>${escapeHtml(r.summary)}</td>
        <td>${escapeHtml(r.kb)} KB</td>
      </tr>
    `).join('');
  }

  attachListeners() {
    document.getElementById('admin-theme-toggle')?.addEventListener('click', () => this.toggleTheme());

    document.getElementById('btn-admin-refresh')?.addEventListener('click', async () => {
      await this.refreshAll();
      ui.showToast('System diagnostics refreshed', '');
    });

    document.getElementById('btn-probe-gateway')?.addEventListener('click', async () => {
      await this.refreshGatewayDiagnostics();
      ui.showToast(
        this.lastGatewayLatencyMs ? `Gateway responded in ${this.lastGatewayLatencyMs} ms` : 'Gateway check completed',
        ''
      );
    });

    document.getElementById('btn-admin-sync-now')?.addEventListener('click', async () => {
      const btn = document.getElementById('btn-admin-sync-now');
      if (btn) btn.disabled = true;
      try {
        await supabaseService.init();
        if (!supabaseService.hasConfig()) {
          ui.showToast('No Supabase cloud project configured; operating locally', '');
          return;
        }
        const up = await storage.uploadLocalToCloud();
        const down = await storage.syncFromCloud();
        if (up.success || down.success) {
          ui.showToast('Synchronized local records with Supabase Cloud', '');
        } else if (up.reason === 'not_authenticated' || down.reason === 'not_authenticated') {
          ui.showToast('Sign in to an account in the main app before syncing', '');
        } else {
          ui.showToast(`Sync notice: ${up.error || down.error || up.reason || 'Deferred'}`, '');
        }
        await this.refreshAll();
      } finally {
        if (btn) btn.disabled = false;
      }
    });

    document.getElementById('admin-supabase-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const url = document.getElementById('admin-sb-url')?.value.trim();
      const key = document.getElementById('admin-sb-key')?.value.trim();
      if (!url || !key) {
        ui.showToast('Enter both a Supabase URL and public anon key', '');
        return;
      }
      const saveBtn = document.getElementById('btn-admin-sb-save');
      if (saveBtn) saveBtn.disabled = true;
      try {
        await supabaseService.setCustomConfig(url, key);
        await this.refreshSupabaseDiagnostics();
        ui.showToast('Custom Supabase credentials saved', '');
      } catch (err) {
        ui.showToast(`Connection error: ${err.message}`, '');
      } finally {
        if (saveBtn) saveBtn.disabled = false;
      }
    });

    document.getElementById('btn-admin-sb-clear')?.addEventListener('click', async () => {
      await supabaseService.setCustomConfig(null, null);
      const urlInput = document.getElementById('admin-sb-url');
      const keyInput = document.getElementById('admin-sb-key');
      if (urlInput) urlInput.value = '';
      if (keyInput) keyInput.value = '';
      await this.refreshSupabaseDiagnostics();
      ui.showToast('Custom Supabase override cleared', '');
    });

    document.getElementById('admin-telemetry-toggle')?.addEventListener('change', (e) => {
      analytics.saveConsent({ analyticsAllowed: e.target.checked });
      this.renderLocalTelemetry();
      this.renderAuditLog();
      ui.showToast(`Anonymous telemetry ${e.target.checked ? 'enabled' : 'disabled'}`, '');
    });

    document.getElementById('audit-search-input')?.addEventListener('input', (e) => {
      this.auditSearch = e.target.value || '';
      this.renderAuditLog();
    });

    document.getElementById('audit-action-filter')?.addEventListener('change', (e) => {
      this.auditActionFilter = e.target.value || 'all';
      this.renderAuditLog();
    });

    document.getElementById('btn-admin-export-compliance')?.addEventListener('click', () => {
      const report = analytics.exportComplianceReport();
      this._downloadJson(report, `aifycycle-compliance-audit-${formatDateKey(new Date())}.json`);
      ui.showToast('Compliance report exported', '');
    });

    document.getElementById('btn-admin-export-backup')?.addEventListener('click', () => {
      const backup = storage.exportBackup();
      this._downloadJson(backup, `aifycycle-backup-${formatDateKey(new Date())}.json`);
      analytics.trackEvent('backup', 'export');
      analytics.logAuditAction('DATA_EXPORTED', 'Exported JSON data backup from System Console');
      this.renderLocalTelemetry();
      this.renderAuditLog();
      ui.showToast('Full backup JSON downloaded', '');
    });

    document.getElementById('admin-import-file')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const res = storage.importBackup(text);
        if (res.success) {
          analytics.logAuditAction('DATA_IMPORTED', `Imported JSON backup (${file.name})`);
          await this.refreshAll();
          ui.showToast('Backup imported successfully', '');
        } else {
          ui.showToast(`Import failed: ${res.error}`, '');
        }
      } catch (err) {
        ui.showToast(`Could not read file: ${err.message}`, '');
      } finally {
        e.target.value = '';
      }
    });

    document.getElementById('btn-admin-load-demo')?.addEventListener('click', async () => {
      if (!confirm('Load starter demo cycle logs into local browser storage?')) return;
      storage.resetAllData();
      analytics.logAuditAction('DEMO_DATASET_LOADED', 'Loaded starter demo cycle dataset via System Console');
      await this.refreshAll();
      ui.showToast('Demo cycle dataset loaded locally', '');
    });

    document.getElementById('btn-admin-purge-telemetry')?.addEventListener('click', async () => {
      if (!confirm('Clear all local usage telemetry and audit log entries?')) return;
      analytics.purgeAllTelemetry();
      await this.refreshAll();
      ui.showToast('Local telemetry and audit history cleared', '');
    });

    document.getElementById('btn-admin-gdpr-wipe')?.addEventListener('click', async () => {
      const confirmed = confirm(
        'GDPR DATA ERASURE:\n\n' +
        'This permanently deletes all local profile settings, cycle logs, AI chat history, learned notes, telemetry, and authenticated cloud rows.\n\n' +
        'This action cannot be undone. Proceed?'
      );
      if (!confirmed) return;

      const result = await storage.purgeAllUserData();
      if (result?.error) {
        alert(`Local data erased, but cloud erasure reported an error: ${result.error}`);
      } else {
        alert('All personal data and sessions have been permanently erased.');
      }
      window.location.href = '/';
    });
  }

  _downloadJson(content, filename) {
    const blob = new Blob([content], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const consoleApp = new AdminConsole();
  consoleApp.init();
});
