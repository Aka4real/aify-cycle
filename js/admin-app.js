/**
 * AifyCycle Ops - Admin Observatory Controller
 * Coordinates Hybrid Auth (Supabase Admin Allowlist + Admin Secret Key),
 * live auto-refresh, 6 observability views, interactive SVG charts,
 * user inspector drawer, Gemini live probes, DB integrity scans, and Cmd+K palette.
 */

import { escapeHtml } from './dom-utils.js';
import { supabaseService } from './supabase-client.js';
import {
  renderAreaLineChart,
  renderComboGrowthChart,
  renderDonutChart,
  renderHorizontalBars,
  renderActivityHeatmap,
  renderHealthGauge,
  renderSparklineSvg
} from './admin-charts.js';

const THEME_KEY = 'aifycycle_admin_theme_v1';

const VIEW_TITLES = {
  overview: 'Overview',
  users: 'Users & Live Presence',
  gemini: 'Gemini AI Models & Health',
  integrity: 'Database Integrity Suite',
  telemetry: 'Telemetry & Product Insights',
  system: 'System Runtime & Audit'
};

const VIEW_LABELS = {
  dial: 'Cycle Compass',
  calendar: 'Calendar',
  syncing: 'Cycle Syncing',
  'ai-coach': 'AI Coach',
  analytics: 'Insights',
  settings: 'Settings',
  onboarding: 'Onboarding',
  auth: 'Sign In'
};

function formatRelativeTime(iso) {
  if (!iso) return 'Never';
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return 'Never';
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 20) return 'Just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function formatShortDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatUptime(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}

function getInitials(name, email) {
  const src = (name || email || 'U').trim();
  const parts = src.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return src.slice(0, 2).toUpperCase();
}

function presenceLabel(status) {
  if (status === 'online') return 'Online';
  if (status === 'idle') return 'Idle';
  return 'Offline';
}

function lastSeenSourceLabel(source) {
  const map = {
    live_heartbeat: 'Live heartbeat',
    profile_heartbeat: 'App activity',
    last_sign_in: 'Last sign-in',
    profile_sync: 'Cloud sync',
    never: 'No activity'
  };
  return map[source] || source || '';
}

function statusPillHtml(status, customLabel = null) {
  const s = String(status || 'neutral').toLowerCase();
  const label = customLabel || s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  return `<span class="adm-pill ${escapeHtml(s)}"><span class="adm-dot ${escapeHtml(s)}"></span>${escapeHtml(label)}</span>`;
}

class AdminObservatoryApp {
  constructor() {
    this.authenticated = false;
    this.adminInfo = null;
    this.authConfig = null;
    this.supabaseToken = null;

    this.activeView = 'overview';
    this.range = '24h';
    this.autoRefreshMs = 15000;
    this.refreshTimer = null;
    this.setupDismissed = false;

    // Users table state
    this.usersQuery = {
      search: '',
      status: 'all',
      provider: 'all',
      sort: 'lastSeen',
      page: 1,
      pageSize: 25
    };
    this.searchDebounce = null;

    // Cached payloads
    this.cache = {
      overview: null,
      users: null,
      gemini: null,
      integrity: null,
      telemetry: null
    };
  }

  async init() {
    this._initTheme();
    this._attachAuthListeners();
    this._attachShellListeners();

    // Handle Supabase OAuth return to /admin?code=...
    await this._handleSupabaseOAuthReturn();

    // Check existing session (HttpOnly cookie or Supabase Bearer token)
    const authStatus = await this._checkAuthStatus();
    this.authConfig = authStatus.config || null;
    this._applyAuthConfigHints();

    if (authStatus.authenticated) {
      this._enterShell(authStatus.admin);
    } else {
      this._showAuthGate(authStatus.reason === 'NOT_ADMIN' ? 'Your signed-in account is not authorized for admin access.' : null);
    }
  }

  // =========================================================================
  // THEME
  // =========================================================================

  _initTheme() {
    const saved = localStorage.getItem(THEME_KEY) || localStorage.getItem('aifycycle_theme_v1') || 'light';
    this._applyTheme(saved === 'dark' ? 'dark' : 'light');
  }

  _applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(THEME_KEY, theme);
    const icon = document.getElementById('adm-theme-icon');
    if (icon) {
      icon.innerHTML = theme === 'dark'
        ? '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>'
        : '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
    }
  }

  _toggleTheme() {
    const cur = document.documentElement.getAttribute('data-theme') || 'light';
    this._applyTheme(cur === 'dark' ? 'light' : 'dark');
  }

  // =========================================================================
  // HYBRID AUTHENTICATION
  // =========================================================================

  async _handleSupabaseOAuthReturn() {
    const params = new URLSearchParams(window.location.search);
    const hasOAuth = params.has('code') || window.location.hash.includes('access_token');
    try {
      const client = await supabaseService.init();
      if (!client) return;
      const { data: { session } } = await client.auth.getSession();
      if (hasOAuth) {
        window.history.replaceState({}, document.title, '/admin');
      }
      if (session?.access_token) {
        this.supabaseToken = session.access_token;
        if (hasOAuth) {
          // Automatically mint admin HttpOnly session cookie if email is allowlisted
          await fetch('/api/admin/auth', {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${this.supabaseToken}`
            },
            body: JSON.stringify({ mode: 'supabase' })
          }).catch(() => {});
        }
      }
    } catch (e) {}
  }

  async _checkAuthStatus() {
    const headers = {};
    if (this.supabaseToken) {
      headers.Authorization = `Bearer ${this.supabaseToken}`;
    }
    try {
      const res = await fetch('/api/admin/auth', {
        method: 'GET',
        credentials: 'same-origin',
        headers
      });
      return await res.json();
    } catch (e) {
      return { authenticated: false, reason: 'NETWORK_ERROR' };
    }
  }

  _applyAuthConfigHints() {
    const cfg = this.authConfig;
    const hint = document.getElementById('auth-config-hint');
    if (!cfg) return;

    if (!cfg.configured) {
      this._showAuthMessage(
        'Configure ADMIN_EMAILS or ADMIN_SECRET in your server environment (.env / Vercel) to enable admin sign-in.',
        'info'
      );
      if (hint) hint.textContent = 'Setup Required';
    } else if (hint) {
      hint.textContent = cfg.methods.supabaseAllowlist && cfg.methods.secretKey
        ? 'Hybrid Auth Active'
        : cfg.methods.secretKey
          ? 'Secret Key Active'
          : 'Admin Allowlist Active';
    }

    // Default to Secret Key tab if Supabase admin auth isn't configured yet
    if (!cfg.methods.supabaseAllowlist && cfg.methods.secretKey) {
      this._switchAuthTab('secret');
    }
  }

  _switchAuthTab(mode) {
    const isSb = mode === 'supabase';
    const tabSb = document.getElementById('tab-auth-supabase');
    const tabSec = document.getElementById('tab-auth-secret');
    const panSb = document.getElementById('panel-auth-supabase');
    const panSec = document.getElementById('panel-auth-secret');
    if (tabSb) {
      tabSb.classList.toggle('active', isSb);
      tabSb.setAttribute('aria-selected', String(isSb));
    }
    if (tabSec) {
      tabSec.classList.toggle('active', !isSb);
      tabSec.setAttribute('aria-selected', String(!isSb));
    }
    if (panSb) panSb.style.display = isSb ? '' : 'none';
    if (panSec) panSec.style.display = isSb ? 'none' : '';
  }

  _showAuthMessage(msg, type = 'error') {
    const el = document.getElementById('admin-auth-msg');
    if (!el) return;
    if (!msg) {
      el.style.display = 'none';
      el.textContent = '';
      return;
    }
    el.className = `adm-auth-msg ${type}`;
    el.textContent = msg;
    el.style.display = '';
  }

  _showAuthGate(errMsg = null) {
    this.authenticated = false;
    this.adminInfo = null;
    this._stopAutoRefresh();
    document.getElementById('admin-auth-screen').style.display = 'flex';
    document.getElementById('admin-shell').style.display = 'none';
    if (errMsg) this._showAuthMessage(errMsg, 'error');
  }

  _enterShell(admin) {
    this.authenticated = true;
    this.adminInfo = admin || { identity: 'Admin', method: 'hybrid' };
    document.getElementById('admin-auth-screen').style.display = 'none';
    document.getElementById('admin-shell').style.display = 'flex';

    const opName = document.getElementById('adm-op-name');
    const opMethod = document.getElementById('adm-op-method');
    const opAvatar = document.getElementById('adm-op-avatar');
    if (opName) opName.textContent = this.adminInfo.identity || 'Admin';
    if (opMethod) {
      const m = this.adminInfo.method;
      opMethod.textContent = m === 'secret_key'
        ? 'Admin Secret Key'
        : m === 'supabase_allowlist' || m === 'supabase_jwt'
          ? 'Supabase Admin'
          : 'Authenticated';
    }
    if (opAvatar) opAvatar.textContent = getInitials(this.adminInfo.identity, this.adminInfo.email);

    this._loadInitialDashboard();
    this._startAutoRefresh();
  }

  _attachAuthListeners() {
    document.querySelectorAll('.adm-auth-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        this._switchAuthTab(btn.getAttribute('data-auth-mode'));
        this._showAuthMessage('');
      });
    });

    // Secret Key login
    const secretForm = document.getElementById('form-admin-secret');
    if (secretForm) {
      secretForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        this._showAuthMessage('');
        const secret = document.getElementById('admin-secret-input')?.value || '';
        const btn = document.getElementById('btn-admin-secret-login');
        if (btn) btn.disabled = true;
        try {
          const res = await fetch('/api/admin/auth', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: 'secret', secret })
          });
          const data = await res.json().catch(() => ({}));
          if (res.ok && data.authenticated) {
            document.getElementById('admin-secret-input').value = '';
            this._enterShell(data.admin);
          } else {
            this._showAuthMessage(data.message || 'Authentication failed.', 'error');
          }
        } catch (err) {
          this._showAuthMessage('Network error contacting server.', 'error');
        } finally {
          if (btn) btn.disabled = false;
        }
      });
    }

    // Supabase Email/Password admin login
    const sbForm = document.getElementById('form-admin-supabase');
    if (sbForm) {
      sbForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        this._showAuthMessage('');
        const email = (document.getElementById('admin-email')?.value || '').trim();
        const password = document.getElementById('admin-password')?.value || '';
        const btn = document.getElementById('btn-admin-sb-login');
        if (btn) btn.disabled = true;
        try {
          const client = await supabaseService.init();
          if (!client) {
            this._showAuthMessage('Supabase Auth is not configured on this server. Use the Secret Key tab instead.', 'error');
            return;
          }
          const { data, error } = await client.auth.signInWithPassword({ email, password });
          if (error || !data?.session?.access_token) {
            this._showAuthMessage(error?.message || 'Invalid credentials.', 'error');
            return;
          }
          this.supabaseToken = data.session.access_token;
          const verifyRes = await fetch('/api/admin/auth', {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${this.supabaseToken}`
            },
            body: JSON.stringify({ mode: 'supabase' })
          });
          const verifyData = await verifyRes.json().catch(() => ({}));
          if (verifyRes.ok && verifyData.authenticated) {
            this._enterShell(verifyData.admin);
          } else {
            this._showAuthMessage(verifyData.message || 'Account is not authorized as an admin.', 'error');
          }
        } catch (err) {
          this._showAuthMessage(err.message || 'Sign-in failed.', 'error');
        } finally {
          if (btn) btn.disabled = false;
        }
      });
    }

    // Supabase Google OAuth admin login
    const btnGoogle = document.getElementById('btn-admin-google');
    if (btnGoogle) {
      btnGoogle.addEventListener('click', async () => {
        this._showAuthMessage('');
        const client = await supabaseService.init();
        if (!client) {
          this._showAuthMessage('Supabase Google OAuth is not configured on this server. Use the Secret Key tab instead.', 'error');
          return;
        }
        const { error } = await client.auth.signInWithOAuth({
          provider: 'google',
          options: {
            redirectTo: `${window.location.origin}/admin`,
            queryParams: { prompt: 'select_account' }
          }
        });
        if (error) {
          this._showAuthMessage(error.message || 'Could not start Google sign-in.', 'error');
        }
      });
    }
  }

  // =========================================================================
  // API CLIENT
  // =========================================================================

  async _apiFetch(url, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (this.supabaseToken && !headers.Authorization) {
      headers.Authorization = `Bearer ${this.supabaseToken}`;
    }
    const res = await fetch(url, {
      credentials: 'same-origin',
      ...options,
      headers
    });
    if (res.status === 401 || res.status === 403) {
      this._showAuthGate('Your admin session expired. Please sign in again.');
      throw new Error('SESSION_EXPIRED');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.message || data.error || `HTTP ${res.status}`);
    }
    return data;
  }

  async _downloadExport(type, format = 'json') {
    try {
      const headers = {};
      if (this.supabaseToken) headers.Authorization = `Bearer ${this.supabaseToken}`;
      const url = `/api/admin/telemetry?export=${encodeURIComponent(type)}&format=${encodeURIComponent(format)}&range=${encodeURIComponent(this.range)}`;
      const res = await fetch(url, { credentials: 'same-origin', headers });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      const cd = res.headers.get('content-disposition') || '';
      const match = cd.match(/filename="([^"]+)"/);
      const filename = match ? match[1] : `aifycycle-${type}.${format}`;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        URL.revokeObjectURL(a.href);
        a.remove();
      }, 200);
      this._toast(`Downloaded ${filename}`);
    } catch (err) {
      this._toast(err.message || 'Export failed');
    }
  }

  // =========================================================================
  // SHELL NAVIGATION, AUTO-REFRESH & COMMAND PALETTE
  // =========================================================================

  _attachShellListeners() {
    // Sidebar navigation
    document.querySelectorAll('.adm-nav-item[data-nav]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.switchView(btn.getAttribute('data-nav'));
        this._closeMobileSidebar();
      });
    });

    // Cross-view links
    document.querySelectorAll('[data-goto]').forEach(btn => {
      btn.addEventListener('click', () => this.switchView(btn.getAttribute('data-goto')));
    });

    // Mobile menu
    const btnMenu = document.getElementById('btn-mobile-menu');
    const backdrop = document.getElementById('adm-sidebar-backdrop');
    if (btnMenu) btnMenu.addEventListener('click', () => this._toggleMobileSidebar());
    if (backdrop) backdrop.addEventListener('click', () => this._closeMobileSidebar());

    // Range selector
    document.querySelectorAll('.adm-range-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.range = btn.getAttribute('data-range') || '24h';
        document.querySelectorAll('.adm-range-btn').forEach(b => b.classList.toggle('active', b === btn));
        this.refreshCurrentView();
      });
    });

    // Auto refresh selector
    const autoSel = document.getElementById('adm-autorefresh-select');
    if (autoSel) {
      autoSel.addEventListener('change', () => {
        this.autoRefreshMs = parseInt(autoSel.value, 10) || 0;
        this._startAutoRefresh();
      });
    }

    // Manual refresh & theme toggle
    document.getElementById('btn-adm-refresh')?.addEventListener('click', () => this.refreshCurrentView(true));
    document.getElementById('btn-adm-theme')?.addEventListener('click', () => this._toggleTheme());
    document.getElementById('btn-dismiss-setup')?.addEventListener('click', () => {
      this.setupDismissed = true;
      document.getElementById('adm-setup-banner').style.display = 'none';
    });

    // Logout
    document.getElementById('btn-admin-logout')?.addEventListener('click', async () => {
      await fetch('/api/admin/auth', { method: 'DELETE', credentials: 'same-origin' }).catch(() => {});
      this.supabaseToken = null;
      this._showAuthGate();
      this._toast('Signed out of Admin Console');
    });

    // Users search / filter / sort
    const searchInput = document.getElementById('users-search-input');
    if (searchInput) {
      searchInput.addEventListener('input', () => {
        clearTimeout(this.searchDebounce);
        this.searchDebounce = setTimeout(() => {
          this.usersQuery.search = searchInput.value.trim();
          this.usersQuery.page = 1;
          this.loadUsers();
        }, 220);
      });
    }

    document.querySelectorAll('#users-status-chips .adm-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        document.querySelectorAll('#users-status-chips .adm-chip').forEach(c => c.classList.toggle('active', c === chip));
        this.usersQuery.status = chip.getAttribute('data-status') || 'all';
        this.usersQuery.page = 1;
        this.loadUsers();
      });
    });

    document.getElementById('users-provider-select')?.addEventListener('change', (e) => {
      this.usersQuery.provider = e.target.value;
      this.usersQuery.page = 1;
      this.loadUsers();
    });

    document.getElementById('users-sort-select')?.addEventListener('change', (e) => {
      this.usersQuery.sort = e.target.value;
      this.usersQuery.page = 1;
      this.loadUsers();
    });

    // Gemini actions
    document.getElementById('btn-gemini-probe-all')?.addEventListener('click', () => this.probeAllGemini());
    document.getElementById('btn-gemini-reset-all')?.addEventListener('click', () => this.geminiAction('clear_all_cooldowns'));

    // Integrity rescan
    document.getElementById('btn-integrity-rescan')?.addEventListener('click', () => this.loadIntegrity(true));

    // Exports
    document.getElementById('btn-export-users-csv')?.addEventListener('click', () => this._downloadExport('users', 'csv'));
    document.getElementById('btn-export-gemini-csv')?.addEventListener('click', () => this._downloadExport('gemini', 'csv'));
    document.getElementById('btn-export-integrity-json')?.addEventListener('click', () => this._downloadExport('integrity', 'json'));
    document.getElementById('btn-export-errors-csv')?.addEventListener('click', () => this._downloadExport('telemetry', 'csv'));
    document.querySelectorAll('[data-export]').forEach(btn => {
      btn.addEventListener('click', () => {
        this._downloadExport(btn.getAttribute('data-export'), btn.getAttribute('data-format') || 'json');
      });
    });

    // User drawer close
    document.getElementById('btn-close-drawer')?.addEventListener('click', () => this._closeUserDrawer());
    document.getElementById('user-drawer-overlay')?.addEventListener('click', (e) => {
      if (e.target.id === 'user-drawer-overlay') this._closeUserDrawer();
    });

    // Command palette (Ctrl+K / Cmd+K)
    document.getElementById('btn-open-cmd')?.addEventListener('click', () => this._openCommandPalette());
    document.getElementById('cmd-palette-overlay')?.addEventListener('click', (e) => {
      if (e.target.id === 'cmd-palette-overlay') this._closeCommandPalette();
    });
    document.getElementById('cmd-palette-input')?.addEventListener('input', (e) => {
      this._renderCommandItems(e.target.value);
    });

    document.addEventListener('keydown', (e) => {
      if (!this.authenticated) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        this._openCommandPalette();
      } else if (e.key === 'Escape') {
        this._closeCommandPalette();
        this._closeUserDrawer();
      }
    });
  }

  _toggleMobileSidebar() {
    document.getElementById('adm-sidebar')?.classList.toggle('open');
    document.getElementById('adm-sidebar-backdrop')?.classList.toggle('open');
  }

  _closeMobileSidebar() {
    document.getElementById('adm-sidebar')?.classList.remove('open');
    document.getElementById('adm-sidebar-backdrop')?.classList.remove('open');
  }

  switchView(viewKey) {
    if (!VIEW_TITLES[viewKey]) return;
    this.activeView = viewKey;
    document.querySelectorAll('.adm-nav-item[data-nav]').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-nav') === viewKey);
    });
    document.querySelectorAll('.adm-view').forEach(sec => {
      sec.classList.toggle('active', sec.id === `view-${viewKey}`);
    });
    const titleEl = document.getElementById('admin-page-title');
    if (titleEl) titleEl.textContent = VIEW_TITLES[viewKey];

    this.refreshCurrentView();
  }

  _startAutoRefresh() {
    this._stopAutoRefresh();
    if (!this.autoRefreshMs || this.autoRefreshMs < 5000) return;
    this.refreshTimer = setInterval(() => {
      if (!this.authenticated || document.hidden) return;
      this.refreshCurrentView(false);
    }, this.autoRefreshMs);
  }

  _stopAutoRefresh() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  async _loadInitialDashboard() {
    await Promise.allSettled([
      this.loadOverview(),
      this.loadUsers(),
      this.loadGemini(),
      this.loadIntegrity(false),
      this.loadTelemetry()
    ]);
  }

  async refreshCurrentView(showToast = false) {
    try {
      if (this.activeView === 'overview') await this.loadOverview();
      else if (this.activeView === 'users') await this.loadUsers();
      else if (this.activeView === 'gemini') await this.loadGemini();
      else if (this.activeView === 'integrity') await this.loadIntegrity(false);
      else if (this.activeView === 'telemetry' || this.activeView === 'system') await this.loadTelemetry();
      if (showToast) this._toast('Telemetry refreshed');
    } catch (e) {}
  }

  _stampUpdated(iso) {
    const el = document.getElementById('adm-last-updated');
    if (!el) return;
    const d = iso ? new Date(iso) : new Date();
    el.textContent = `Updated ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
  }

  _updateSetupBanner(overview) {
    const banner = document.getElementById('adm-setup-banner');
    if (!banner || this.setupDismissed) return;
    const title = document.getElementById('adm-setup-title');
    const body = document.getElementById('adm-setup-body');

    if (!overview.dbConfigured) {
      title.textContent = 'Running in Local Live Telemetry Mode (Supabase Service Role Key not set)';
      body.innerHTML = 'Live presence heartbeats, server runtime telemetry, and Gemini probes are active right now. Add <code>SUPABASE_SERVICE_ROLE_KEY</code> to <code>.env</code> or Vercel Environment Variables and run <code>supabase/migrations/20261127_admin_telemetry.sql</code> to inspect all cloud accounts and deep PostgreSQL integrity.';
      banner.style.display = 'flex';
    } else if (!overview.rpcAvailable) {
      title.textContent = 'Admin Telemetry Migration Pending in Supabase SQL Editor';
      body.innerHTML = 'Supabase cloud accounts are connected! Run <code>supabase/migrations/20261127_admin_telemetry.sql</code> in Supabase Cloud SQL Editor to unlock 5-minute online history snapshots, persistent Gemini telemetry, and full PostgreSQL RLS/bloat audits.';
      banner.style.display = 'flex';
    } else {
      banner.style.display = 'none';
    }
  }

  // =========================================================================
  // VIEW 1: OVERVIEW
  // =========================================================================

  async loadOverview() {
    const data = await this._apiFetch(`/api/admin/overview?range=${encodeURIComponent(this.range)}`);
    this.cache.overview = data;
    this._stampUpdated(data.generatedAt);
    this._updateSetupBanner(data);
    this._renderOverview(data);
  }

  _renderOverview(data) {
    const k = data.kpis;
    this._setBadge('badge-nav-health', `${data.healthScore}%`, data.healthScore >= 85 ? 'live' : data.healthScore >= 60 ? 'warn' : 'err');
    this._setBadge('badge-nav-online', String(k.onlineNow.total), k.onlineNow.total > 0 ? 'live' : '');
    this._setBadge('badge-nav-gemini', `${k.geminiHealthyModels}/${k.geminiTotalModels}`, k.geminiStatus === 'operational' ? 'live' : 'warn');
    this._setBadge('badge-nav-db', `${k.dbIntegrityScore}%`, k.dbIntegrityScore >= 85 ? 'live' : k.dbIntegrityScore >= 60 ? 'warn' : 'err');
    this._setBadge('badge-nav-errors', String(k.clientErrorsCount), k.clientErrorsCount > 0 ? 'err' : '');

    const onlineVals = (data.charts.onlineTimeline || []).slice(-12).map(p => p.onlineTotal);
    const growthVals = (data.charts.userGrowth || []).slice(-12).map(p => p.totalUsers);
    const dauVals = (data.charts.userGrowth || []).slice(-12).map(p => p.dau);

    const kpiGrid = document.getElementById('ov-kpi-grid');
    if (kpiGrid) {
      const deltaClass = k.signupGrowthPct > 0 ? 'up' : k.signupGrowthPct < 0 ? 'down' : 'flat';
      const deltaText = `${k.signupGrowthPct >= 0 ? '+' : ''}${k.signupGrowthPct}% 7d`;

      kpiGrid.innerHTML = `
        <div class="adm-kpi-card">
          <div class="adm-kpi-top">
            <span class="adm-kpi-label">Online Now</span>
            <span class="adm-dot ${k.onlineNow.total > 0 ? 'online' : 'offline'}"></span>
          </div>
          <div class="adm-kpi-value-row">
            <span class="adm-kpi-value">${k.onlineNow.total}</span>
            ${renderSparklineSvg(onlineVals, 'var(--adm-sage)')}
          </div>
          <div class="adm-kpi-foot">
            <span>${k.onlineNow.registered} registered &middot; ${k.onlineNow.guests} guests</span>
            ${k.onlineNow.idleTotal > 0 ? `<span>${k.onlineNow.idleTotal} idle</span>` : ''}
          </div>
        </div>

        <div class="adm-kpi-card">
          <div class="adm-kpi-top">
            <span class="adm-kpi-label">Total Users</span>
            <span class="adm-delta ${deltaClass}">${escapeHtml(deltaText)}</span>
          </div>
          <div class="adm-kpi-value-row">
            <span class="adm-kpi-value">${k.totalUsers}</span>
            ${renderSparklineSvg(growthVals, 'var(--adm-rose)')}
          </div>
          <div class="adm-kpi-foot">
            <span>+${k.new24h} today &middot; +${k.new7d} this week</span>
          </div>
        </div>

        <div class="adm-kpi-card">
          <div class="adm-kpi-top">
            <span class="adm-kpi-label">DAU / MAU</span>
            <span class="adm-delta flat">${k.stickinessPct}% sticky</span>
          </div>
          <div class="adm-kpi-value-row">
            <span class="adm-kpi-value">${k.dau} <span style="font-size:15px;color:var(--adm-text-muted);font-weight:500;">/ ${k.mau}</span></span>
            ${renderSparklineSvg(dauVals, 'var(--adm-blue)')}
          </div>
          <div class="adm-kpi-foot">
            <span>WAU: ${k.wau} active (7d)</span>
          </div>
        </div>

        <div class="adm-kpi-card">
          <div class="adm-kpi-top">
            <span class="adm-kpi-label">Gemini Cascade</span>
            ${statusPillHtml(k.geminiStatus, `${k.geminiHealthyModels}/${k.geminiTotalModels}`)}
          </div>
          <div class="adm-kpi-value-row">
            <span class="adm-kpi-value">${k.geminiAvgLatencyMs !== null ? `${k.geminiAvgLatencyMs}<span style="font-size:14px;color:var(--adm-text-muted);">ms</span>` : (k.geminiStatus === 'unconfigured' ? 'Local' : 'Ready')}</span>
          </div>
          <div class="adm-kpi-foot">
            <span class="mono" style="font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(k.geminiActiveModel)}</span>
          </div>
        </div>

        <div class="adm-kpi-card">
          <div class="adm-kpi-top">
            <span class="adm-kpi-label">DB Integrity</span>
            ${statusPillHtml(k.dbIntegrityScore >= 85 ? 'pass' : k.dbIntegrityScore >= 60 ? 'warn' : 'fail', `${k.dbIntegrityScore}/100`)}
          </div>
          <div class="adm-kpi-value-row">
            <span class="adm-kpi-value">${k.dbLatencyMs !== null ? `${k.dbLatencyMs}<span style="font-size:14px;color:var(--adm-text-muted);">ms</span>` : '—'}</span>
          </div>
          <div class="adm-kpi-foot">
            <span>${k.totalRecords.toLocaleString()} total records</span>
          </div>
        </div>

        <div class="adm-kpi-card">
          <div class="adm-kpi-top">
            <span class="adm-kpi-label">Client Errors</span>
            ${statusPillHtml(k.clientErrorsCount === 0 ? 'pass' : 'error', k.clientErrorsCount === 0 ? 'Clean' : `${k.clientErrorsCount} logged`)}
          </div>
          <div class="adm-kpi-value-row">
            <span class="adm-kpi-value">${k.clientErrorsCount}</span>
          </div>
          <div class="adm-kpi-foot">
            <span>Opt-in telemetry: ${k.telemetryOptInCount} users</span>
          </div>
        </div>
      `;
    }

    // Charts
    renderAreaLineChart(document.getElementById('chart-online-timeline'), {
      data: data.charts.onlineTimeline,
      rangeKey: data.range,
      series: [
        { key: 'onlineTotal', label: 'Total Online', color: 'var(--adm-sage)', fill: true, width: 2.5 },
        { key: 'onlineRegistered', label: 'Registered', color: 'var(--adm-rose)', width: 2 },
        { key: 'onlineGuests', label: 'Guests', color: 'var(--adm-blue)', width: 1.8, dashed: true }
      ]
    });

    renderComboGrowthChart(document.getElementById('chart-user-growth'), data.charts.userGrowth);

    renderDonutChart(document.getElementById('chart-ov-providers'), data.charts.providerBreakdown, {
      centerLabel: 'Accounts',
      centerValue: k.totalUsers
    });

    // System Health Gauge & Alerts
    renderHealthGauge(document.getElementById('ov-health-gauge'), data.healthScore, 'Health');
    const verdict = document.getElementById('ov-health-verdict');
    const sub = document.getElementById('ov-health-sub');
    if (verdict) {
      verdict.textContent = data.healthScore >= 90
        ? 'All Systems Optimal'
        : data.healthScore >= 70
          ? 'Operational with Advisories'
          : 'Attention Required';
    }
    if (sub) {
      sub.textContent = `${data.alerts.length} status report${data.alerts.length === 1 ? '' : 's'} evaluated at ${new Date(data.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }

    const alertsEl = document.getElementById('ov-alerts-list');
    if (alertsEl) {
      alertsEl.innerHTML = data.alerts.map(a => `
        <div class="adm-alert-item">
          <span class="adm-dot ${escapeHtml(a.severity === 'ok' ? 'pass' : a.severity === 'info' ? 'ready' : a.severity)}" style="margin-top:5px;"></span>
          <div style="min-width:0;">
            <div class="adm-alert-item-title">${escapeHtml(a.title)}</div>
            <div class="adm-alert-item-detail">${escapeHtml(a.detail)}</div>
          </div>
        </div>
      `).join('');
    }

    // Live Active Strip
    const liveEl = document.getElementById('ov-live-strip');
    if (liveEl) {
      if (!data.liveNow || data.liveNow.length === 0) {
        liveEl.innerHTML = '<div class="adm-empty" style="grid-column:1/-1;padding:22px;">No active sessions detected within the last 5 minutes. Open AifyCycle in another tab to see real-time presence appear here immediately.</div>';
      } else {
        liveEl.innerHTML = data.liveNow.map(item => `
          <button type="button" class="adm-live-user-tile" ${!item.isGuest ? `data-inspect-user="${escapeHtml(item.id)}"` : ''}>
            <div class="adm-avatar ${item.isGuest ? 'guest' : ''}">${escapeHtml(getInitials(item.name, item.email))}</div>
            <div style="min-width:0;flex:1;">
              <div style="display:flex;align-items:center;gap:6px;">
                <span class="adm-dot ${escapeHtml(item.status)}"></span>
                <span style="font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(item.name)}</span>
              </div>
              <div style="font-size:11.5px;color:var(--adm-text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                ${escapeHtml(VIEW_LABELS[item.activeView] || item.activeView || 'App')} &middot; ${escapeHtml(item.deviceType || 'desktop')} &middot; ${escapeHtml(formatRelativeTime(item.lastSeenAt))}
              </div>
            </div>
          </button>
        `).join('');

        liveEl.querySelectorAll('[data-inspect-user]').forEach(btn => {
          btn.addEventListener('click', () => this.openUserInspector(btn.getAttribute('data-inspect-user')));
        });
      }
    }

    // Recent Signups
    const recentEl = document.getElementById('ov-recent-signups');
    if (recentEl) {
      if (!data.recentSignups || data.recentSignups.length === 0) {
        recentEl.innerHTML = '<div class="adm-empty">No registered accounts found yet.</div>';
      } else {
        recentEl.innerHTML = `<div class="adm-alert-list">${data.recentSignups.map(u => `
          <div class="adm-alert-item" style="align-items:center;justify-content:space-between;cursor:pointer;" data-inspect-user="${escapeHtml(u.id)}">
            <div style="min-width:0;">
              <div style="font-weight:600;font-size:13px;display:flex;align-items:center;gap:6px;">
                <span class="adm-dot ${escapeHtml(u.presenceStatus)}"></span>
                <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(u.name)}</span>
              </div>
              <div style="font-size:11.5px;color:var(--adm-text-muted);">${escapeHtml(u.email)}</div>
            </div>
            <div style="text-align:right;flex-shrink:0;">
              <div style="font-size:11.5px;font-weight:600;">${escapeHtml(formatRelativeTime(u.createdAt))}</div>
              <div style="font-size:11px;color:var(--adm-text-muted);">${escapeHtml(u.provider)}</div>
            </div>
          </div>
        `).join('')}</div>`;
        recentEl.querySelectorAll('[data-inspect-user]').forEach(row => {
          row.addEventListener('click', () => this.openUserInspector(row.getAttribute('data-inspect-user')));
        });
      }
    }
  }

  // =========================================================================
  // VIEW 2: USERS & LIVE PRESENCE
  // =========================================================================

  async loadUsers() {
    const q = new URLSearchParams({
      search: this.usersQuery.search,
      status: this.usersQuery.status,
      provider: this.usersQuery.provider,
      sort: this.usersQuery.sort,
      page: String(this.usersQuery.page),
      pageSize: String(this.usersQuery.pageSize)
    });
    const data = await this._apiFetch(`/api/admin/users?${q.toString()}`);
    this.cache.users = data;
    this._stampUpdated(data.generatedAt);
    this._renderUsers(data);
  }

  _renderUsers(data) {
    const s = data.summary;
    this._setBadge('badge-nav-online', String(s.onlineTotal), s.onlineTotal > 0 ? 'live' : '');

    const kpiEl = document.getElementById('users-kpi-grid');
    if (kpiEl) {
      kpiEl.innerHTML = `
        <div class="adm-kpi-card">
          <div class="adm-kpi-top"><span class="adm-kpi-label">Online Right Now</span><span class="adm-dot ${s.onlineTotal > 0 ? 'online' : 'offline'}"></span></div>
          <div class="adm-kpi-value">${s.onlineTotal}</div>
          <div class="adm-kpi-foot"><span>${s.onlineRegistered} registered &middot; ${s.onlineGuests} guests</span></div>
        </div>
        <div class="adm-kpi-card">
          <div class="adm-kpi-top"><span class="adm-kpi-label">Total Accounts</span></div>
          <div class="adm-kpi-value">${s.totalUsers}</div>
          <div class="adm-kpi-foot"><span>${s.verifiedEmails} email verified &middot; ${s.admins} admin</span></div>
        </div>
        <div class="adm-kpi-card">
          <div class="adm-kpi-top"><span class="adm-kpi-label">Active Last 24h</span></div>
          <div class="adm-kpi-value">${s.active24h}</div>
          <div class="adm-kpi-foot"><span>${s.idleRegistered} currently idle</span></div>
        </div>
        <div class="adm-kpi-card">
          <div class="adm-kpi-top"><span class="adm-kpi-label">New Signups (7d)</span></div>
          <div class="adm-kpi-value">+${s.new7d}</div>
          <div class="adm-kpi-foot"><span>${s.telemetryOptIn} telemetry opt-in</span></div>
        </div>
      `;
    }

    const offlineCount = Math.max(0, s.totalUsers - s.onlineRegistered - s.idleRegistered);
    renderDonutChart(document.getElementById('chart-users-presence'), [
      { label: 'Online (<=2m)', count: s.onlineRegistered, color: 'var(--adm-sage)' },
      { label: 'Idle (2-5m)', count: s.idleRegistered, color: 'var(--adm-amber)' },
      { label: 'Online Guests', count: s.onlineGuests, color: 'var(--adm-blue)' },
      { label: 'Offline Accounts', count: offlineCount, color: 'var(--adm-border-strong)' }
    ], {
      centerLabel: 'Online',
      centerValue: s.onlineTotal
    });

    // Active Guest Sessions table
    const guestWrap = document.getElementById('users-guest-table-wrap');
    if (guestWrap) {
      const guests = data.activeGuestSessions || [];
      if (guests.length === 0) {
        guestWrap.innerHTML = '<div class="adm-empty">No guest sessions recorded recently.</div>';
      } else {
        guestWrap.innerHTML = `
          <table class="adm-table">
            <thead>
              <tr>
                <th>Guest Session</th>
                <th>Status</th>
                <th>View</th>
                <th>Platform</th>
                <th>Last Seen</th>
              </tr>
            </thead>
            <tbody>
              ${guests.slice(0, 8).map(g => `
                <tr>
                  <td class="mono" style="font-size:12px;">${escapeHtml(g.sessionId.slice(0, 18))}</td>
                  <td>${statusPillHtml(g.status, presenceLabel(g.status))}</td>
                  <td>${escapeHtml(VIEW_LABELS[g.activeView] || g.activeView)}</td>
                  <td>${escapeHtml(`${g.deviceType} / ${g.browser}`)}</td>
                  <td title="${escapeHtml(formatDateTime(g.lastSeenAt))}">${escapeHtml(formatRelativeTime(g.lastSeenAt))}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        `;
      }
    }

    // Registered Users Table
    const tbody = document.getElementById('users-table-body');
    if (tbody) {
      if (!data.users || data.users.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" class="adm-empty">${data.dbEnabled ? 'No accounts match the active filters.' : 'Connect SUPABASE_SERVICE_ROLE_KEY to list all registered accounts.'}</td></tr>`;
      } else {
        tbody.innerHTML = data.users.map(u => {
          const avatarHtml = u.avatarUrl
            ? `<img src="${escapeHtml(u.avatarUrl)}" alt="" loading="lazy">`
            : escapeHtml(getInitials(u.name, u.email));
          const lastSeenTitle = u.lastSeenAt
            ? `${formatDateTime(u.lastSeenAt)} (${lastSeenSourceLabel(u.lastSeenSource)})`
            : 'No activity timestamp recorded';
          const lastSeenDisplay = u.presenceStatus === 'online'
            ? 'Active now'
            : formatRelativeTime(u.lastSeenAt);

          return `
            <tr class="clickable" data-inspect-user="${escapeHtml(u.id)}">
              <td>
                <div class="adm-user-cell">
                  <div class="adm-avatar">${avatarHtml}</div>
                  <div style="min-width:0;">
                    <div class="adm-user-name">
                      <span>${escapeHtml(u.name)}</span>
                      ${u.isAdmin ? '<span class="adm-pill rose" style="padding:1px 6px;font-size:10px;">Admin</span>' : ''}
                    </div>
                    <div class="adm-user-email">${escapeHtml(u.email)}</div>
                  </div>
                </div>
              </td>
              <td>${statusPillHtml(u.presenceStatus, presenceLabel(u.presenceStatus))}</td>
              <td title="${escapeHtml(lastSeenTitle)}">
                <div style="font-weight:600;">${escapeHtml(lastSeenDisplay)}</div>
                <div style="font-size:11px;color:var(--adm-text-muted);">${escapeHtml(lastSeenSourceLabel(u.lastSeenSource))}</div>
              </td>
              <td>
                <div>${escapeHtml(VIEW_LABELS[u.activeView] || u.activeView || '—')}</div>
                <div style="font-size:11px;color:var(--adm-text-muted);">${escapeHtml(u.deviceType ? `${u.deviceType}${u.browser ? ' · ' + u.browser : ''}` : '—')}</div>
              </td>
              <td><span class="adm-pill neutral">${escapeHtml(u.provider)}</span></td>
              <td title="${escapeHtml(formatDateTime(u.createdAt))}">
                <div>${escapeHtml(formatShortDate(u.createdAt))}</div>
                <div style="font-size:11px;color:var(--adm-text-muted);">${escapeHtml(formatRelativeTime(u.createdAt))}</div>
              </td>
              <td class="num">
                <span>${u.counts.cycleLogs}</span>
                <span style="color:var(--adm-text-muted);"> / </span>
                <span>${u.counts.aiChats}</span>
                <span style="color:var(--adm-text-muted);"> / </span>
                <span>${u.counts.aiMemories}</span>
              </td>
              <td>${u.telemetryEnabled ? '<span class="adm-pill pass">Opt-In</span>' : '<span class="adm-pill neutral">Local</span>'}</td>
            </tr>
          `;
        }).join('');

        tbody.querySelectorAll('[data-inspect-user]').forEach(row => {
          row.addEventListener('click', () => this.openUserInspector(row.getAttribute('data-inspect-user')));
        });
      }
    }

    // Pagination
    const pagEl = document.getElementById('users-pagination');
    if (pagEl) {
      const p = data.pagination;
      pagEl.innerHTML = `
        <span>Showing ${data.users.length} of ${p.totalFiltered} matching account${p.totalFiltered === 1 ? '' : 's'} (Page ${p.page} of ${p.totalPages})</span>
        <div style="display:flex;gap:8px;">
          <button type="button" class="adm-btn adm-btn-secondary adm-btn-sm" id="btn-users-prev" ${p.page <= 1 ? 'disabled' : ''}>Previous</button>
          <button type="button" class="adm-btn adm-btn-secondary adm-btn-sm" id="btn-users-next" ${p.page >= p.totalPages ? 'disabled' : ''}>Next</button>
        </div>
      `;
      document.getElementById('btn-users-prev')?.addEventListener('click', () => {
        if (this.usersQuery.page > 1) {
          this.usersQuery.page--;
          this.loadUsers();
        }
      });
      document.getElementById('btn-users-next')?.addEventListener('click', () => {
        if (this.usersQuery.page < p.totalPages) {
          this.usersQuery.page++;
          this.loadUsers();
        }
      });
    }
  }

  async openUserInspector(userId) {
    if (!userId) return;
    const overlay = document.getElementById('user-drawer-overlay');
    const body = document.getElementById('drawer-user-body');
    const title = document.getElementById('drawer-user-title');
    const sub = document.getElementById('drawer-user-sub');

    overlay.classList.add('open');
    overlay.setAttribute('aria-hidden', 'false');
    title.textContent = 'Loading account...';
    sub.textContent = userId;
    body.innerHTML = '<div class="adm-empty">Loading privacy-safe account diagnostics...</div>';

    try {
      const detail = await this._apiFetch(`/api/admin/users?id=${encodeURIComponent(userId)}`);
      const u = detail.user;
      title.textContent = u.name || 'Account Inspector';
      sub.textContent = u.email || u.id;

      const sessRows = (detail.sessions || []).map(s => `
        <div class="adm-alert-item" style="justify-content:space-between;align-items:center;">
          <div>
            <div style="font-size:12.5px;font-weight:600;">${escapeHtml(VIEW_LABELS[s.activeView] || s.activeView)} &middot; ${escapeHtml(s.deviceType)} / ${escapeHtml(s.browser)} (${escapeHtml(s.os)})</div>
            <div style="font-size:11px;color:var(--adm-text-muted);">${escapeHtml(s.heartbeatCount)} heartbeats &middot; Started ${escapeHtml(formatDateTime(s.startedAt))}</div>
          </div>
          ${statusPillHtml(s.status, presenceLabel(s.status))}
        </div>
      `).join('');

      body.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
          ${statusPillHtml(u.presenceStatus, presenceLabel(u.presenceStatus))}
          <span class="adm-pill info">Privacy Guard: Health Text Redacted</span>
        </div>

        <div class="adm-kv-grid">
          <div class="adm-kv-box">
            <div class="adm-kv-label">Account Created</div>
            <div class="adm-kv-val">${escapeHtml(formatDateTime(u.createdAt))}</div>
          </div>
          <div class="adm-kv-box">
            <div class="adm-kv-label">Last Seen Active</div>
            <div class="adm-kv-val">${escapeHtml(u.presenceStatus === 'online' ? 'Active right now' : formatDateTime(u.lastSeenAt))}</div>
          </div>
          <div class="adm-kv-box">
            <div class="adm-kv-label">Last Auth Sign-In</div>
            <div class="adm-kv-val">${escapeHtml(formatDateTime(u.lastSignInAt))}</div>
          </div>
          <div class="adm-kv-box">
            <div class="adm-kv-label">Auth Provider</div>
            <div class="adm-kv-val">${escapeHtml(u.provider || '—')} ${u.emailConfirmed ? '(Verified)' : '(Unverified)'}</div>
          </div>
          <div class="adm-kv-box">
            <div class="adm-kv-label">Cycle Logs Stored</div>
            <div class="adm-kv-val num">${u.counts?.cycleLogs ?? 0} days</div>
          </div>
          <div class="adm-kv-box">
            <div class="adm-kv-label">AI Coach Turns</div>
            <div class="adm-kv-val num">${u.counts?.aiChats ?? 0} msgs</div>
          </div>
          <div class="adm-kv-box">
            <div class="adm-kv-label">AI Memories</div>
            <div class="adm-kv-val num">${u.counts?.aiMemories ?? 0} items</div>
          </div>
          <div class="adm-kv-box">
            <div class="adm-kv-label">Partner Shares</div>
            <div class="adm-kv-val num">${u.counts?.partnerShares ?? 0}</div>
          </div>
        </div>

        <div class="adm-kv-box">
          <div class="adm-kv-label">Account UUID</div>
          <div class="adm-kv-val mono" style="font-size:12px;">${escapeHtml(u.id)}</div>
        </div>

        ${u.legacyClaimStatus ? `
          <div class="adm-kv-box">
            <div class="adm-kv-label">Legacy Self-Hosted Migration</div>
            <div class="adm-kv-val">${u.legacyClaimStatus.claimed ? `Claimed on ${escapeHtml(formatDateTime(u.legacyClaimStatus.claimedAt))}` : 'Pending auto-claim on next confirmed sign-in'}</div>
          </div>
        ` : ''}

        <div>
          <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--adm-text-muted);margin-bottom:8px;">Recent Presence Sessions (${(detail.sessions || []).length})</div>
          <div class="adm-alert-list">${sessRows || '<div class="adm-empty" style="padding:18px;">No live heartbeat sessions recorded for this account yet.</div>'}</div>
        </div>
      `;
    } catch (err) {
      body.innerHTML = `<div class="adm-empty">Could not load account details: ${escapeHtml(err.message)}</div>`;
    }
  }

  _closeUserDrawer() {
    const overlay = document.getElementById('user-drawer-overlay');
    if (overlay) {
      overlay.classList.remove('open');
      overlay.setAttribute('aria-hidden', 'true');
    }
  }

  // =========================================================================
  // VIEW 3: GEMINI AI MODELS & HEALTH
  // =========================================================================

  async loadGemini() {
    const data = await this._apiFetch(`/api/admin/gemini?range=${encodeURIComponent(this.range)}`);
    this.cache.gemini = data;
    this._stampUpdated(data.generatedAt);
    this._renderGemini(data);
  }

  async probeAllGemini() {
    const btn = document.getElementById('btn-gemini-probe-all');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Probing 5 Models...';
    }
    try {
      const res = await this._apiFetch('/api/admin/gemini', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'probe_all' })
      });
      const okCount = (res.results || []).filter(r => r.ok).length;
      this._toast(`Probed ${res.results?.length || 0} Gemini models: ${okCount} healthy`);
      await this.loadGemini();
    } catch (err) {
      this._toast(err.message || 'Probe failed');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Probe All Models Live';
      }
    }
  }

  async geminiAction(action, model = '') {
    try {
      const res = await this._apiFetch('/api/admin/gemini', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, model })
      });
      if (action === 'probe_model' && res.result) {
        this._toast(res.result.ok
          ? `${res.result.model} OK in ${res.result.latencyMs}ms`
          : `${res.result.model} failed (${res.result.status}): ${res.result.error || 'Error'}`);
      } else if (action === 'clear_all_cooldowns') {
        this._toast('Cleared all Gemini circuit-breaker cooldowns');
      } else if (action === 'reset_cooldown') {
        this._toast(`Reset circuit breaker for ${model}`);
      } else if (action === 'trip_cooldown') {
        this._toast(`Placed ${model} into 5-min cooldown`);
      }
      await this.loadGemini();
    } catch (err) {
      this._toast(err.message || 'Gemini action failed');
    }
  }

  _renderGemini(data) {
    const s = data.summary;
    this._setBadge('badge-nav-gemini', `${s.healthyCount}/${s.totalModels}`, s.overallStatus === 'operational' ? 'live' : 'warn');

    const kpiEl = document.getElementById('gemini-kpi-grid');
    if (kpiEl) {
      kpiEl.innerHTML = `
        <div class="adm-kpi-card">
          <div class="adm-kpi-top"><span class="adm-kpi-label">Cascade Health</span>${statusPillHtml(s.overallStatus)}</div>
          <div class="adm-kpi-value">${s.healthyCount} <span style="font-size:15px;color:var(--adm-text-muted);">/ ${s.totalModels}</span></div>
          <div class="adm-kpi-foot"><span>Active: <strong class="mono">${escapeHtml(data.activeModel)}</strong></span></div>
        </div>
        <div class="adm-kpi-card">
          <div class="adm-kpi-top"><span class="adm-kpi-label">Success Rate (${escapeHtml(data.range)})</span></div>
          <div class="adm-kpi-value">${s.successRate !== null ? `${s.successRate}%` : '—'}</div>
          <div class="adm-kpi-foot"><span>${s.totalCalls} calls &middot; ${s.cascadeRate}% failover rate</span></div>
        </div>
        <div class="adm-kpi-card">
          <div class="adm-kpi-top"><span class="adm-kpi-label">Avg / P95 Latency</span></div>
          <div class="adm-kpi-value">${s.avgLatencyMs !== null ? `${s.avgLatencyMs}<span style="font-size:14px;color:var(--adm-text-muted);">ms</span>` : '—'}</div>
          <div class="adm-kpi-foot"><span>P95: ${s.p95LatencyMs !== null ? `${s.p95LatencyMs} ms` : '—'}</span></div>
        </div>
        <div class="adm-kpi-card">
          <div class="adm-kpi-top"><span class="adm-kpi-label">Tokens Processed</span></div>
          <div class="adm-kpi-value">${(s.totalTokens || 0).toLocaleString()}</div>
          <div class="adm-kpi-foot"><span>Primary timeout: ${data.timeouts.primaryMs}ms</span></div>
        </div>
      `;
    }

    const modelsGrid = document.getElementById('gemini-models-grid');
    if (modelsGrid) {
      modelsGrid.innerHTML = (data.models || []).map(m => {
        const roleText = m.role === 'primary' ? 'Primary Model' : (m.role === 'historical' ? 'Historical' : `Fallback #${m.priority - 1}`);
        const stateLabel = m.coolingDown
          ? `Cooling (${m.cooldownRemainingSec}s)`
          : m.healthState === 'healthy'
            ? 'Healthy'
            : m.healthState === 'ready'
              ? 'Ready'
              : m.healthState === 'unconfigured'
                ? 'No API Key'
                : 'Degraded';

        return `
          <div class="adm-model-card">
            <div class="adm-model-head">
              <div style="min-width:0;">
                <div class="adm-model-name">${escapeHtml(m.model)}</div>
                <div class="adm-model-role">${escapeHtml(roleText)}${m.isActive ? ' · Currently Routing' : ''}</div>
              </div>
              ${statusPillHtml(m.healthState, stateLabel)}
            </div>

            <div class="adm-model-metrics">
              <div>
                <div class="adm-model-metric-label">Avg Latency</div>
                <div class="adm-model-metric-val">${m.avgLatencyMs !== null ? `${m.avgLatencyMs}ms` : '—'}</div>
              </div>
              <div>
                <div class="adm-model-metric-label">Success</div>
                <div class="adm-model-metric-val">${m.successRate !== null ? `${m.successRate}%` : '—'}</div>
              </div>
              <div>
                <div class="adm-model-metric-label">Calls</div>
                <div class="adm-model-metric-val">${m.totalCalls || 0}</div>
              </div>
            </div>

            <div style="font-size:11.5px;color:var(--adm-text-muted);min-height:18px;">
              ${m.lastError && m.healthState !== 'healthy'
                ? `<span style="color:var(--adm-amber);">Last error: ${escapeHtml(m.lastError.slice(0, 68))}</span>`
                : m.lastProbeAt
                  ? `Last probed ${escapeHtml(formatRelativeTime(m.lastProbeAt))} (${m.lastProbeLatencyMs ?? '—'}ms)`
                  : 'Click Probe to verify live upstream response'}
            </div>

            <div class="adm-model-actions">
              <button type="button" class="adm-btn adm-btn-secondary adm-btn-sm" data-probe-model="${escapeHtml(m.model)}">Probe Live</button>
              ${m.coolingDown
                ? `<button type="button" class="adm-btn adm-btn-primary adm-btn-sm" data-reset-model="${escapeHtml(m.model)}">Reset Breaker</button>`
                : `<button type="button" class="adm-btn adm-btn-ghost adm-btn-sm" data-trip-model="${escapeHtml(m.model)}">Cooldown</button>`}
            </div>
          </div>
        `;
      }).join('');

      modelsGrid.querySelectorAll('[data-probe-model]').forEach(btn => {
        btn.addEventListener('click', () => this.geminiAction('probe_model', btn.getAttribute('data-probe-model')));
      });
      modelsGrid.querySelectorAll('[data-reset-model]').forEach(btn => {
        btn.addEventListener('click', () => this.geminiAction('reset_cooldown', btn.getAttribute('data-reset-model')));
      });
      modelsGrid.querySelectorAll('[data-trip-model]').forEach(btn => {
        btn.addEventListener('click', () => this.geminiAction('trip_cooldown', btn.getAttribute('data-trip-model')));
      });
    }

    renderAreaLineChart(document.getElementById('chart-gemini-series'), {
      data: data.series,
      rangeKey: data.range,
      series: [
        { key: 'requests', label: 'Total Requests', color: 'var(--adm-rose)', fill: true, width: 2.3 },
        { key: 'successes', label: 'Successes', color: 'var(--adm-sage)', width: 2 },
        { key: 'cascaded', label: 'Failovers', color: 'var(--adm-amber)', width: 1.8, dashed: true }
      ],
      emptyMessage: 'No Gemini API calls logged in this time range. Click "Probe All Models Live" to test.'
    });

    const tc = s.taskCounts || {};
    renderHorizontalBars(document.getElementById('gemini-workload-bars'), [
      { label: 'AI Coach Chat', value: tc.chat || 0, color: 'var(--adm-rose)' },
      { label: 'Cycle Syncing Insights', value: tc.cycle_sync || 0, color: 'var(--adm-sage)' },
      { label: 'Admin Health Probes', value: tc.probe || 0, color: 'var(--adm-blue)' }
    ]);

    const errList = document.getElementById('gemini-errors-list');
    if (errList) {
      if (!data.errorBreakdown || data.errorBreakdown.length === 0) {
        errList.innerHTML = '<div style="font-size:12.5px;color:var(--adm-sage);font-weight:600;">Zero upstream Gemini errors in this period.</div>';
      } else {
        errList.innerHTML = `<div class="adm-alert-list">${data.errorBreakdown.map(e => `
          <div class="adm-alert-item" style="justify-content:space-between;align-items:center;padding:8px 11px;">
            <span class="mono" style="font-size:12px;">${escapeHtml(e.code)}</span>
            <span class="adm-pill error">${e.count}</span>
          </div>
        `).join('')}</div>`;
      }
    }

    const callsBody = document.getElementById('gemini-calls-body');
    if (callsBody) {
      if (!data.recentCalls || data.recentCalls.length === 0) {
        callsBody.innerHTML = '<tr><td colspan="8" class="adm-empty">No Gemini requests recorded yet.</td></tr>';
      } else {
        callsBody.innerHTML = data.recentCalls.map(c => `
          <tr>
            <td title="${escapeHtml(formatDateTime(c.createdAt))}">${escapeHtml(formatRelativeTime(c.createdAt))}</td>
            <td><span class="adm-pill neutral">${escapeHtml(c.task)}</span></td>
            <td class="mono" style="font-size:12px;">${escapeHtml(c.requestedModel)}</td>
            <td class="mono" style="font-size:12px;">${escapeHtml(c.modelUsed || '—')} ${c.cascaded ? '<span class="adm-pill warn" style="padding:1px 6px;font-size:10px;">Cascade</span>' : ''}</td>
            <td class="mono">${c.statusCode}</td>
            <td class="num">${c.latencyMs} ms</td>
            <td class="num">${c.totalTokens ? c.totalTokens.toLocaleString() : '—'}</td>
            <td>${c.success ? statusPillHtml('pass', 'OK') : statusPillHtml('fail', c.errorCode ? c.errorCode.slice(0, 22) : 'Failed')}</td>
          </tr>
        `).join('');
      }
    }
  }

  // =========================================================================
  // VIEW 4: DATABASE INTEGRITY SUITE
  // =========================================================================

  async loadIntegrity(showToast = false) {
    const data = await this._apiFetch('/api/admin/integrity');
    this.cache.integrity = data;
    this._stampUpdated(data.generatedAt);
    this._renderIntegrity(data);
    if (showToast) this._toast(`Database integrity scan complete: ${data.score}/100`);
  }

  _renderIntegrity(data) {
    this._setBadge('badge-nav-db', `${data.score}%`, data.score >= 85 ? 'live' : data.score >= 60 ? 'warn' : 'err');
    renderHealthGauge(document.getElementById('db-integrity-gauge'), data.score, 'Integrity');

    const title = document.getElementById('db-integrity-summary-title');
    const sub = document.getElementById('db-integrity-summary-sub');
    if (title) {
      title.textContent = data.summary.failed > 0
        ? `${data.summary.failed} Integrity Issue(s) Detected`
        : data.summary.warnings > 0
          ? `${data.summary.passed} Passed · ${data.summary.warnings} Advisory`
          : 'All Integrity Checks Passed';
    }
    if (sub) {
      sub.textContent = `${data.summary.totalChecks} check${data.summary.totalChecks === 1 ? '' : 's'} completed across schema, RLS, referential integrity & engine stats.`;
    }

    const vitals = document.getElementById('db-engine-vitals');
    if (vitals) {
      const db = data.database;
      vitals.innerHTML = `
        <div class="adm-kv-box">
          <div class="adm-kv-label">PostgreSQL Version</div>
          <div class="adm-kv-val mono">${escapeHtml(db?.pgVersion || (data.connected ? 'Cloud PG' : '—'))}</div>
        </div>
        <div class="adm-kv-box">
          <div class="adm-kv-label">REST / Auth Latency</div>
          <div class="adm-kv-val num">${data.health.restLatencyMs !== null ? `${data.health.restLatencyMs} ms` : '—'} / ${data.health.authLatencyMs !== null ? `${data.health.authLatencyMs} ms` : '—'}</div>
        </div>
        <div class="adm-kv-box">
          <div class="adm-kv-label">Database Size</div>
          <div class="adm-kv-val num">${escapeHtml(db?.sizeFormatted || '—')}</div>
        </div>
        <div class="adm-kv-box">
          <div class="adm-kv-label">Cache Hit Ratio</div>
          <div class="adm-kv-val num">${db ? `${db.cacheHitRatio}%` : '—'}</div>
        </div>
        <div class="adm-kv-box">
          <div class="adm-kv-label">Active Connections</div>
          <div class="adm-kv-val num">${db ? db.activeConnections : '—'}</div>
        </div>
        <div class="adm-kv-box">
          <div class="adm-kv-label">Deadlocks / Commit %</div>
          <div class="adm-kv-val num">${db ? `${db.deadlocks} / ${db.txCommitRatio}%` : '—'}</div>
        </div>
      `;
    }

    const checksEl = document.getElementById('db-checks-list');
    if (checksEl) {
      checksEl.innerHTML = (data.checks || []).map(c => `
        <div class="adm-check-item">
          <div class="adm-check-left">
            <span class="adm-dot ${escapeHtml(c.status)}" style="margin-top:6px;"></span>
            <div style="min-width:0;">
              <div class="adm-check-cat">${escapeHtml(c.category)}</div>
              <div class="adm-check-title">${escapeHtml(c.title)}</div>
              <div class="adm-check-detail">${escapeHtml(c.detail)}</div>
              ${c.remediation ? `<div class="adm-check-remediation">Action: ${escapeHtml(c.remediation)}</div>` : ''}
            </div>
          </div>
          <div style="flex-shrink:0;">${statusPillHtml(c.status, c.metric || c.status)}</div>
        </div>
      `).join('');
    }

    const tbody = document.getElementById('db-tables-body');
    if (tbody) {
      if (!data.tables || data.tables.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" class="adm-empty">No table metadata returned. Ensure SUPABASE_SERVICE_ROLE_KEY is configured.</td></tr>';
      } else {
        tbody.innerHTML = data.tables.map(t => `
          <tr>
            <td class="mono" style="font-weight:600;font-size:12.5px;">public.${escapeHtml(t.name)}</td>
            <td><span class="adm-pill neutral">${escapeHtml(t.group)}</span></td>
            <td class="num" style="font-weight:600;">${Number(t.liveRows || 0).toLocaleString()}</td>
            <td>${t.rlsEnabled === true ? statusPillHtml('pass', 'RLS ON') : t.rlsEnabled === false ? statusPillHtml('fail', 'RLS OFF') : '<span class="adm-pill neutral">Run RPC</span>'}</td>
            <td class="num">${t.policyCount !== null && t.policyCount !== undefined ? t.policyCount : '—'}</td>
            <td class="mono" style="font-size:12px;">${escapeHtml(t.totalSizeFormatted)}</td>
            <td class="num">${t.deadTuples !== null && t.deadTuples !== undefined ? `${t.deadTuples} (${t.bloatRatio}%)` : '—'}</td>
            <td>${statusPillHtml(t.status, t.status === 'pass' ? 'Healthy' : t.status === 'warn' ? 'Advisory' : 'Action Needed')}</td>
          </tr>
        `).join('');
      }
    }
  }

  // =========================================================================
  // VIEW 5 & 6: TELEMETRY, INSIGHTS, RUNTIME & AUDIT
  // =========================================================================

  async loadTelemetry() {
    const data = await this._apiFetch(`/api/admin/telemetry?range=${encodeURIComponent(this.range)}`);
    this.cache.telemetry = data;
    this._stampUpdated(data.generatedAt);
    this._renderTelemetry(data);
    this._renderSystem(data);
  }

  _renderTelemetry(data) {
    this._setBadge('badge-nav-errors', String(data.clientErrors.total), data.clientErrors.total > 0 ? 'err' : '');

    // Retention Cohorts
    const cohortsEl = document.getElementById('tel-cohorts-grid');
    if (cohortsEl) {
      const c = data.cohorts;
      const items = [
        { label: 'Day 1 Retention', ...c.d1 },
        { label: 'Day 7 Retention', ...c.d7 },
        { label: 'Day 30 Retention', ...c.d30 }
      ];
      cohortsEl.innerHTML = items.map(it => `
        <div class="adm-cohort-box">
          <div style="font-size:11.5px;color:var(--adm-text-muted);font-weight:600;">${escapeHtml(it.label)}</div>
          <div class="num" style="font-size:26px;font-weight:700;margin:4px 0;">${it.rate}%</div>
          <div style="font-size:11.5px;color:var(--adm-text-secondary);">${it.retained} / ${it.eligible} eligible</div>
        </div>
      `).join('');
    }

    // Feature Adoption Bars
    renderHorizontalBars(
      document.getElementById('tel-feature-bars'),
      (data.tabViews || []).map(v => ({
        label: VIEW_LABELS[v.view] || v.view,
        value: (v.count || 0) + (v.sessions || 0)
      })),
      { color: 'var(--adm-rose)' }
    );

    // 7x24 Heatmap
    renderActivityHeatmap(document.getElementById('tel-heatmap'), data.heatmap);

    // Devices Donut
    renderDonutChart(
      document.getElementById('tel-devices-donut'),
      (data.devices || []).map(d => ({
        label: d.label.charAt(0).toUpperCase() + d.label.slice(1),
        count: d.count
      })),
      { centerLabel: 'Sessions' }
    );

    // Browsers Bars
    renderHorizontalBars(
      document.getElementById('tel-browsers-bars'),
      (data.browsers || []).map(b => ({ label: b.label, value: b.count })),
      { color: 'var(--adm-blue)', emptyMessage: 'No browser telemetry recorded yet.' }
    );

    // Client Error Feed
    const errBody = document.getElementById('tel-errors-body');
    if (errBody) {
      const grouped = data.clientErrors.grouped || [];
      if (grouped.length === 0) {
        errBody.innerHTML = '<tr><td colspan="6" class="adm-empty">Zero client-side runtime errors recorded in this window.</td></tr>';
      } else {
        errBody.innerHTML = grouped.map(e => `
          <tr>
            <td><span class="adm-pill error">${escapeHtml(e.errorType)}</span></td>
            <td>
              <div class="mono" style="font-size:12px;word-break:break-word;">${escapeHtml(e.message)}</div>
              ${e.source ? `<div style="font-size:11px;color:var(--adm-text-muted);">${escapeHtml(e.source)}</div>` : ''}
            </td>
            <td>${escapeHtml(VIEW_LABELS[e.viewName] || e.viewName || '—')}</td>
            <td>${escapeHtml(e.deviceType || '—')}</td>
            <td class="num" style="font-weight:700;">${e.count}</td>
            <td title="${escapeHtml(formatDateTime(e.lastSeenAt))}">${escapeHtml(formatRelativeTime(e.lastSeenAt))}</td>
          </tr>
        `).join('');
      }
    }
  }

  _renderSystem(data) {
    const r = data.runtime;
    const rtGrid = document.getElementById('sys-runtime-grid');
    if (rtGrid && r) {
      rtGrid.innerHTML = `
        <div class="adm-kv-box">
          <div class="adm-kv-label">Runtime Environment</div>
          <div class="adm-kv-val">${escapeHtml(r.deploymentMode)}</div>
        </div>
        <div class="adm-kv-box">
          <div class="adm-kv-label">Node.js / Platform</div>
          <div class="adm-kv-val mono">${escapeHtml(`${r.nodeVersion} (${r.platform}/${r.arch})`)}</div>
        </div>
        <div class="adm-kv-box">
          <div class="adm-kv-label">Process Uptime</div>
          <div class="adm-kv-val num">${escapeHtml(formatUptime(r.uptimeSec))}</div>
        </div>
        <div class="adm-kv-box">
          <div class="adm-kv-label">Heap Memory Usage</div>
          <div class="adm-kv-val num">${escapeHtml(`${r.memory.heapUsedFormatted} / ${r.memory.heapTotalFormatted} (${r.memory.heapPct}%)`)}</div>
        </div>
        <div class="adm-kv-box">
          <div class="adm-kv-label">Resident Set (RSS)</div>
          <div class="adm-kv-val num">${escapeHtml(r.memory.rssFormatted)}</div>
        </div>
        <div class="adm-kv-box">
          <div class="adm-kv-label">API Requests / 5xx Errors</div>
          <div class="adm-kv-val num">${r.totalHttpRequests} / ${r.totalApiErrors}</div>
        </div>
        <div class="adm-kv-box">
          <div class="adm-kv-label">Active Rate-Limit Buckets</div>
          <div class="adm-kv-val num">${r.security.activeRateLimitBuckets}</div>
        </div>
        <div class="adm-kv-box">
          <div class="adm-kv-label">Verified JWT Cache / Mem Sessions</div>
          <div class="adm-kv-val num">${r.security.verifiedTokenCacheSize} / ${r.inMemorySessions}</div>
        </div>
      `;
    }

    const secList = document.getElementById('sys-security-list');
    if (secList && r) {
      const checks = [
        { title: 'Content Security Policy & Anti-Clickjacking', status: 'pass', metric: 'Strict CSP + DENY' },
        { title: 'Origin CORS Allowlist Enforcement', status: 'pass', metric: 'Active' },
        { title: 'Privacy Boundary (Health Text Redaction)', status: 'pass', metric: 'Metadata Only' },
        { title: 'Hybrid Admin Authentication', status: r.adminAuth.configured ? 'pass' : 'warn', metric: r.adminAuth.configured ? 'Protected' : 'Configure Env' },
        { title: 'Supabase Service Role Isolation', status: r.adminAuth.serviceRoleConfigured ? 'pass' : 'warn', metric: r.adminAuth.serviceRoleConfigured ? 'Server Only' : 'Not Set' }
      ];
      secList.innerHTML = checks.map(c => `
        <div class="adm-check-item" style="padding:10px 13px;">
          <div class="adm-check-left">
            <span class="adm-dot ${escapeHtml(c.status)}" style="margin-top:5px;"></span>
            <div class="adm-check-title" style="font-size:13px;">${escapeHtml(c.title)}</div>
          </div>
          ${statusPillHtml(c.status, c.metric)}
        </div>
      `).join('');
    }

    const auditBody = document.getElementById('sys-audit-body');
    if (auditBody) {
      const logs = data.auditLogs || [];
      if (logs.length === 0) {
        auditBody.innerHTML = '<tr><td colspan="5" class="adm-empty">No admin audit actions recorded yet.</td></tr>';
      } else {
        auditBody.innerHTML = logs.map(a => `
          <tr>
            <td title="${escapeHtml(formatDateTime(a.createdAt))}">${escapeHtml(formatRelativeTime(a.createdAt))}</td>
            <td style="font-weight:600;">${escapeHtml(a.adminIdentity)}</td>
            <td><span class="adm-pill info">${escapeHtml(a.action)}</span></td>
            <td class="mono" style="font-size:12px;">${escapeHtml(a.target || '—')}</td>
            <td class="mono" style="font-size:12px;color:var(--adm-text-muted);">${escapeHtml(a.ipAddress || '—')}</td>
          </tr>
        `).join('');
      }
    }
  }

  // =========================================================================
  // COMMAND PALETTE
  // =========================================================================

  _openCommandPalette() {
    const overlay = document.getElementById('cmd-palette-overlay');
    const input = document.getElementById('cmd-palette-input');
    if (!overlay || !input) return;
    overlay.classList.add('open');
    overlay.setAttribute('aria-hidden', 'false');
    input.value = '';
    this._renderCommandItems('');
    setTimeout(() => input.focus(), 20);
  }

  _closeCommandPalette() {
    const overlay = document.getElementById('cmd-palette-overlay');
    if (overlay) {
      overlay.classList.remove('open');
      overlay.setAttribute('aria-hidden', 'true');
    }
  }

  _renderCommandItems(query) {
    const list = document.getElementById('cmd-palette-list');
    if (!list) return;
    const q = String(query || '').trim().toLowerCase();

    const commands = [
      { label: 'Go to Overview', sub: 'Executive KPIs, online chart & growth', run: () => this.switchView('overview') },
      { label: 'Go to Users & Live Presence', sub: 'Registered accounts, online status & last seen', run: () => this.switchView('users') },
      { label: 'Go to Gemini AI Models', sub: '5-model cascade status, latencies & probes', run: () => this.switchView('gemini') },
      { label: 'Go to Database Integrity', sub: 'PostgreSQL RLS, orphans & schema checks', run: () => this.switchView('integrity') },
      { label: 'Go to Telemetry & Insights', sub: 'Retention cohorts, 7x24 heatmap & errors', run: () => this.switchView('telemetry') },
      { label: 'Go to System & Audit', sub: 'Server runtime, security shield & audit trail', run: () => this.switchView('system') },
      { label: 'Action: Probe All Gemini Models Live', sub: 'Ping every cascade model upstream', run: () => { this.switchView('gemini'); this.probeAllGemini(); } },
      { label: 'Action: Reset All Gemini Cooldowns', sub: 'Clear all circuit-breaker cooldowns', run: () => { this.switchView('gemini'); this.geminiAction('clear_all_cooldowns'); } },
      { label: 'Action: Re-run Database Integrity Scan', sub: 'Execute live PostgreSQL audit', run: () => { this.switchView('integrity'); this.loadIntegrity(true); } },
      { label: 'Export: Users Directory (CSV)', sub: 'Formula-hardened CSV export', run: () => this._downloadExport('users', 'csv') },
      { label: 'Export: Full Ops Snapshot (JSON)', sub: 'Complete telemetry & integrity snapshot', run: () => this._downloadExport('full', 'json') },
      { label: 'Toggle Light / Dark Theme', sub: 'Switch observatory palette', run: () => this._toggleTheme() }
    ];

    // Also include cached users for instant search-and-inspect
    const cachedUsers = this.cache.users?.users || [];
    for (const u of cachedUsers.slice(0, 20)) {
      commands.push({
        label: `Inspect User: ${u.name}`,
        sub: `${u.email} · ${presenceLabel(u.presenceStatus)}`,
        run: () => this.openUserInspector(u.id)
      });
    }

    const filtered = commands.filter(c =>
      !q || c.label.toLowerCase().includes(q) || c.sub.toLowerCase().includes(q)
    ).slice(0, 12);

    if (filtered.length === 0) {
      list.innerHTML = '<div class="adm-empty" style="padding:20px;">No matching commands or users.</div>';
      return;
    }

    list.innerHTML = filtered.map((c, idx) => `
      <button type="button" class="adm-cmd-item" data-cmd-idx="${idx}">
        <span>${escapeHtml(c.label)}</span>
        <span class="adm-cmd-item-sub">${escapeHtml(c.sub)}</span>
      </button>
    `).join('');

    list.querySelectorAll('[data-cmd-idx]').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.getAttribute('data-cmd-idx'), 10);
        this._closeCommandPalette();
        filtered[idx]?.run();
      });
    });
  }

  // =========================================================================
  // HELPERS
  // =========================================================================

  _setBadge(id, text, cls = '') {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.className = `adm-nav-badge${cls ? ' ' + cls : ''}`;
  }

  _toast(message) {
    const stack = document.getElementById('adm-toast-stack');
    if (!stack) return;
    const item = document.createElement('div');
    item.className = 'adm-toast';
    item.textContent = String(message);
    stack.appendChild(item);
    setTimeout(() => item.remove(), 3400);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const app = new AdminObservatoryApp();
  app.init();
});
