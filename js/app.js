/**
 * AifyCycle - Application Controller
 * Main entry point coordinating auth, onboarding, storage, cycle predictions,
 * AI coaching, UI rendering, and user interactions.
 */

import { storage } from './storage.js';
import { getCycleStatus, formatDateKey, parseDateKey, addDays } from './cycle-engine.js';
import { ui } from './ui-components.js';
import { AuthManager } from './auth.js';
import { OnboardingWizard } from './onboarding.js';
import { AICoach } from './ai-coach.js';
import { analytics } from './analytics-tracker.js';
import { supabaseService } from './supabase-client.js';

class AifyCycleApp {
  constructor() {
    this.currentView = 'dial';
    this.today = new Date();
    this.currentYear = this.today.getFullYear();
    this.currentMonth = this.today.getMonth();
    this.activeLogDate = formatDateKey(this.today);
    this.waterCount = 8;

    // New modules
    this.auth = new AuthManager();
    this.onboarding = null;
    this.aiCoach = null;
    this._authListenersAttached = false;
    this._mainListenersAttached = false;
    this._activeScreen = null;
    this._activeUserId = null;
  }

  async init() {
    this.setupTheme();
    this._setupScrollHeader();
    analytics.initVercelAnalytics();
    this._initComplianceAndConsent();

    // Register auth redirect callback for OAuth return / background session restore
    this.auth.setOnAuthRedirectCallback(() => {
      this._routeUser();
    });

    const urlHasAuthParams =
      window.location.search.includes('code=') ||
      window.location.search.includes('error=') ||
      window.location.hash.includes('access_token') ||
      window.location.hash.includes('error=');

    if (urlHasAuthParams) {
      // Wait for PKCE code exchange / error parsing before routing so auth screen doesn't flash
      const { error } = await this.auth.handleOAuthCallback();
      this._routeUser();
      if (error) {
        this._showAuthErrors([error]);
      }
    } else {
      // Instant local-first render, then reconcile Supabase session in background
      this._routeUser();
      this.auth.handleOAuthCallback().then(({ user, error }) => {
        if (error) {
          console.warn('[Auth] Session verification notice:', error);
        } else if (user) {
          this._routeUser();
        }
      });
    }

    console.log('🌸 AifyCycle Initialized successfully.');
  }

  /**
   * Initialize Legal, Privacy & Compliance Consent
   */
  _initComplianceAndConsent() {
    const consent = analytics.getConsent();
    const banner = document.getElementById('privacy-consent-banner');
    if (!consent && banner) {
      banner.style.display = 'block';
    }

    const btnAccept = document.getElementById('btn-consent-accept');
    const btnDecline = document.getElementById('btn-consent-decline');

    if (btnAccept && banner) {
      btnAccept.addEventListener('click', () => {
        analytics.saveConsent({ analyticsAllowed: true });
        banner.style.display = 'none';
        ui.showToast('Privacy preferences saved', '🛡️');
      });
    }

    if (btnDecline && banner) {
      btnDecline.addEventListener('click', () => {
        analytics.saveConsent({ analyticsAllowed: false });
        banner.style.display = 'none';
        ui.showToast('Analytics tracking declined', '🛡️');
      });
    }

    // Attach global legal modal triggers
    document.querySelectorAll('.btn-link-legal').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const modalId = btn.getAttribute('data-modal');
        if (modalId) {
          const targetModal = document.getElementById(modalId);
          if (targetModal) targetModal.classList.add('active');
        }
      });
    });
  }

  /**
   * Route user based on auth & onboarding state
   */
  _routeUser() {
    if (!this.auth.isLoggedIn()) {
      this._showAuthScreen();
    } else if (!this.auth.hasCompletedOnboarding()) {
      this._showOnboardingScreen();
    } else {
      this._showMainApp();
    }
  }

  // =============================================
  // AUTH SCREEN
  // =============================================

  _showAuthScreen() {
    this._activeScreen = 'auth';
    this._activeUserId = null;
    this.onboarding = null;

    document.getElementById('view-auth').style.display = '';
    document.getElementById('view-onboarding').style.display = 'none';
    document.getElementById('main-app-container').style.display = 'none';

    this._attachAuthListeners();
    this._syncOAuthButtonsAvailability();
  }

  async _syncOAuthButtonsAvailability() {
    const btnApple = document.getElementById('btn-oauth-apple');
    if (!btnApple) return;

    // Keep Sign in with Apple hidden until Apple provider is enabled in Supabase Cloud
    try {
      await supabaseService.init();
      const providers = await supabaseService.getAuthProviderStatus();
      btnApple.style.display = providers.apple === true ? '' : 'none';
    } catch (e) {
      btnApple.style.display = 'none';
    }
  }

  _attachAuthListeners() {
    if (this._authListenersAttached) return;
    this._authListenersAttached = true;
    // Tab switching
    const loginTab = document.getElementById('auth-tab-login');
    const signupTab = document.getElementById('auth-tab-signup');
    const loginForm = document.getElementById('auth-login-form');
    const signupForm = document.getElementById('auth-signup-form');
    const indicator = document.querySelector('.auth-tab-indicator');

    if (loginTab && signupTab) {
      loginTab.addEventListener('click', () => {
        loginTab.classList.add('active');
        signupTab.classList.remove('active');
        loginForm.style.display = '';
        signupForm.style.display = 'none';
        if (indicator) indicator.style.transform = 'translateX(0)';
        this._clearAuthErrors();
      });

      signupTab.addEventListener('click', () => {
        signupTab.classList.add('active');
        loginTab.classList.remove('active');
        signupForm.style.display = '';
        loginForm.style.display = 'none';
        if (indicator) indicator.style.transform = 'translateX(100%)';
        this._clearAuthErrors();
      });
    }

    // Login form submit
    if (loginForm) {
      loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        this._clearAuthErrors();
        const email = document.getElementById('login-email').value;
        const password = document.getElementById('login-password').value;
        const submitBtn = loginForm.querySelector('button[type="submit"]');
        const labelSpan = submitBtn?.querySelector('span');
        const origText = labelSpan ? labelSpan.textContent : (submitBtn ? submitBtn.textContent : '');

        if (submitBtn) {
          submitBtn.disabled = true;
          if (labelSpan) labelSpan.textContent = 'Connecting...';
          else submitBtn.textContent = 'Connecting...';
        }

        try {
          const result = await this.auth.login({ email, password });
          if (result.success) {
            this._routeUser();
          } else {
            this._showAuthErrors(result.errors);
          }
        } finally {
          if (submitBtn) {
            submitBtn.disabled = false;
            if (labelSpan) labelSpan.textContent = origText;
            else submitBtn.textContent = origText;
          }
        }
      });
    }

    // Signup form submit
    if (signupForm) {
      signupForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        this._clearAuthErrors();
        const name = document.getElementById('signup-name').value;
        const email = document.getElementById('signup-email').value;
        const password = document.getElementById('signup-password').value;
        const dateOfBirth = document.getElementById('signup-dob').value || null;
        const submitBtn = signupForm.querySelector('button[type="submit"]');
        const labelSpan = submitBtn?.querySelector('span');
        const origText = labelSpan ? labelSpan.textContent : (submitBtn ? submitBtn.textContent : '');

        if (submitBtn) {
          submitBtn.disabled = true;
          if (labelSpan) labelSpan.textContent = 'Creating Account...';
          else submitBtn.textContent = 'Creating Account...';
        }

        try {
          const result = await this.auth.signup({ name, email, password, dateOfBirth });
          if (result.success) {
            const profile = storage.getProfile();
            profile.userName = name.trim();
            storage.saveProfile(profile);
            this._routeUser();
          } else if (result.requiresEmailConfirmation && result.notice) {
            this._showAuthNotice(result.notice);
          } else {
            this._showAuthErrors(result.errors);
          }
        } finally {
          if (submitBtn) {
            submitBtn.disabled = false;
            if (labelSpan) labelSpan.textContent = origText;
            else submitBtn.textContent = origText;
          }
        }
      });
    }

    // --- Real Supabase OAuth Flows (Google & Apple) ---
    const wireOAuthButton = (btnId, provider, providerLabel) => {
      const btn = document.getElementById(btnId);
      if (!btn) return;
      btn.addEventListener('click', async () => {
        const span = btn.querySelector('span');
        const origText = span ? span.textContent : '';
        this._clearAuthErrors();
        btn.disabled = true;
        if (span) span.textContent = `Connecting to ${providerLabel}...`;

        try {
          const res = await this.auth.signInWithOAuth(provider);
          if (res.redirecting) return;

          this._showAuthErrors([res.error || `Could not sign in with ${providerLabel}.`]);
        } finally {
          btn.disabled = false;
          if (span) span.textContent = origText;
        }
      });
    };

    wireOAuthButton('btn-oauth-google', 'google', 'Google');
    wireOAuthButton('btn-oauth-apple', 'apple', 'Apple');

    // Modal close/cancel buttons (for legal modals accessible on auth screen)
    document.querySelectorAll('.modal-overlay .btn-close-modal, .modal-overlay .btn-modal-cancel').forEach(btn => {
      btn.addEventListener('click', () => {
        const modal = btn.closest('.modal-overlay');
        if (modal) modal.classList.remove('active');
      });
    });

    // Guest login
    const guestBtn = document.getElementById('btn-guest-login');
    if (guestBtn) {
      guestBtn.addEventListener('click', async () => {
        guestBtn.disabled = true;
        try {
          await this.auth.guestLogin();
          ui.showToast('Continuing in private guest mode', '✨');
          this._routeUser();
        } finally {
          guestBtn.disabled = false;
        }
      });
    }
  }

  _showAuthErrors(errors) {
    const display = document.getElementById('auth-error-display');
    if (display) {
      display.style.display = 'block';
      display.style.background = '';
      display.style.borderColor = '';
      display.style.color = '';
      display.textContent = '';
      (errors || []).forEach(errText => {
        const p = document.createElement('p');
        p.textContent = `⚠️ ${errText}`;
        display.appendChild(p);
      });
      display.classList.remove('shake');
      void display.offsetWidth;
      display.classList.add('shake');
    }
  }

  _showAuthNotice(message) {
    const display = document.getElementById('auth-error-display');
    if (display) {
      display.style.display = 'block';
      display.style.background = 'rgba(0, 142, 155, 0.12)';
      display.style.borderColor = 'rgba(0, 142, 155, 0.4)';
      display.style.color = 'var(--color-teal, #008E9B)';
      display.textContent = '';
      const p = document.createElement('p');
      p.textContent = `✉️ ${message}`;
      display.appendChild(p);
    }
  }

  _clearAuthErrors() {
    const display = document.getElementById('auth-error-display');
    if (display) {
      display.style.display = 'none';
      display.innerHTML = '';
    }
  }

  // =============================================
  // ONBOARDING SCREEN
  // =============================================

  _showOnboardingScreen() {
    const user = this.auth.currentUser;
    const userId = user?.id || 'guest';

    // Avoid tearing down an active wizard if auth state re-fires for the same user
    if (this._activeScreen === 'onboarding' && this._activeUserId === userId && this.onboarding) {
      return;
    }

    this._activeScreen = 'onboarding';
    this._activeUserId = userId;

    document.getElementById('view-auth').style.display = 'none';
    document.getElementById('view-onboarding').style.display = '';
    document.getElementById('main-app-container').style.display = 'none';

    this.onboarding = new OnboardingWizard((data) => {
      // Onboarding complete callback
      this.auth.completeOnboarding();
      this._showMainApp();
    });

    // If user has a name from signup, use it
    if (user && user.name && user.name !== 'Guest') {
      this.onboarding.data.userName = user.name;
    }

    this.onboarding.init();
  }

  // =============================================
  // MAIN APP
  // =============================================

  _showMainApp() {
    this._activeScreen = 'main';
    this._activeUserId = this.auth.currentUser?.id || 'guest';

    document.getElementById('view-auth').style.display = 'none';
    document.getElementById('view-onboarding').style.display = 'none';
    document.getElementById('main-app-container').style.display = '';

    this.renderAll();
    if (!this._mainListenersAttached) {
      this._mainListenersAttached = true;
      this.attachEventListeners();
    }

    // Initialize AI Coach once; re-render if switching back in
    if (!this.aiCoach) {
      this.aiCoach = new AICoach();
      this.aiCoach.init({
        onExpandToTab: () => this.switchTab('ai-coach'),
        getCurrentTab: () => this.currentView,
        getUserId: () => this.auth.currentUser?.id || 'guest'
      });
    } else {
      this.aiCoach._loadChatHistory?.();
      this.aiCoach.renderChatUI();
      this.aiCoach._scheduleFloatingGreeting?.();
    }
    this.aiCoach.onTabChanged?.(this.currentView);
  }

  _setupScrollHeader() {
    const header = document.getElementById('app-top-header');
    if (!header) return;
    const onScroll = () => {
      header.classList.toggle('is-scrolled', window.scrollY > 8);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  _themeIconSvg(theme) {
    if (theme === 'dark') {
      return '<svg class="ui-icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>';
    }
    return '<svg class="ui-icon" viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>';
  }

  _syncThemeIcons(theme) {
    const svg = this._themeIconSvg(theme);
    const themeIcon = document.getElementById('theme-toggle-icon');
    if (themeIcon) themeIcon.innerHTML = svg;
    document.querySelectorAll('.js-theme-toggle').forEach(btn => {
      if (btn.id !== 'btn-theme-toggle') {
        btn.innerHTML = svg;
      }
    });
  }

  setupTheme() {
    const savedTheme = storage.getTheme();
    document.documentElement.setAttribute('data-theme', savedTheme);
    this._syncThemeIcons(savedTheme);
    document.querySelectorAll('.js-theme-toggle').forEach(btn => {
      if (!btn.dataset.themeBound) {
        btn.dataset.themeBound = 'true';
        btn.addEventListener('click', () => this.toggleTheme());
      }
    });
  }

  toggleTheme() {
    const currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
    const nextTheme = currentTheme === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', nextTheme);
    storage.saveTheme(nextTheme);
    this._syncThemeIcons(nextTheme);
    ui.showToast(`Switched to ${nextTheme === 'light' ? 'light' : 'dark'} theme`, '');
  }

  async _refreshAiSettingsStatus() {
    const statusPill = document.getElementById('ai-settings-status');
    if (!statusPill) return;

    statusPill.textContent = 'Checking...';
    statusPill.className = 'ai-status-pill';

    let serverConfigured = false;
    let modelName = '';
    try {
      const res = await fetch('/api/gemini/status');
      if (res.ok) {
        const data = await res.json();
        serverConfigured = Boolean(data.configured);
        if (data.model) modelName = data.model;
      }
    } catch (e) {}

    if (serverConfigured) {
      const displayModel = modelName
        ? modelName.split('-').map(p => (p ? p[0].toUpperCase() + p.slice(1) : '')).join(' ')
        : 'Gemini AI';
      statusPill.textContent = `${displayModel} active`;
      statusPill.className = 'ai-status-pill pill-server';
    } else {
      statusPill.textContent = 'Local intelligence active';
      statusPill.className = 'ai-status-pill pill-local';
    }
  }

  async _refreshSupabaseSettingsStatus() {
    const statusPill = document.getElementById('supabase-settings-status');
    const urlInput = document.getElementById('setting-supabase-url');
    const anonKeyInput = document.getElementById('setting-supabase-anonkey');

    // Pre-populate custom credentials if saved locally
    try {
      const savedConfig = localStorage.getItem('aifycycle_supabase_config_v1');
      if (savedConfig) {
        const parsed = JSON.parse(savedConfig);
        if (urlInput && !urlInput.value) urlInput.value = parsed.url || '';
        if (anonKeyInput && !anonKeyInput.value) anonKeyInput.value = parsed.anonKey || '';
      }
    } catch (e) {}

    if (!statusPill) return;

    statusPill.textContent = 'Checking...';
    statusPill.className = 'ai-status-pill';

    try {
      await supabaseService.init();
      const info = supabaseService.getConnectionInfo();
      if (info.configured) {
        const label = info.source === 'custom'
          ? `Custom override (${info.host})`
          : `Cloud active (${info.host})`;
        statusPill.textContent = label;
        statusPill.className = 'ai-status-pill pill-server';
      } else {
        statusPill.textContent = 'Local-first sandbox';
        statusPill.className = 'ai-status-pill pill-local';
      }
    } catch (e) {
      statusPill.textContent = 'Local-first sandbox';
      statusPill.className = 'ai-status-pill pill-local';
    }
  }

  async loadCycleSyncingInsights(forceRefresh = false) {
    const profile = storage.getProfile();
    const logs = storage.getAllLogs();
    const todayStatus = getCycleStatus(this.today, profile, logs);

    // Initial render with baseline immediately so there is never an empty screen
    ui.renderCycleSyncingGuide(todayStatus);

    if (!this.aiCoach) return;

    if (forceRefresh) {
      ui.renderCycleSyncingGuide(todayStatus, null, true);
    }

    try {
      const insights = await this.aiCoach.generateCycleSyncingInsights(todayStatus, profile, logs, forceRefresh);
      if (insights) {
        ui.renderCycleSyncingGuide(todayStatus, insights, false);
        // Seamlessly update Hero Wellness Note with Gemini's personalized insight
        const partnerNoteEl = document.getElementById('hero-partner-care-note');
        if (partnerNoteEl && insights.partnerTip) {
          partnerNoteEl.textContent = `"${insights.partnerTip}"`;
        }
      } else {
        ui.renderCycleSyncingGuide(todayStatus, null, false);
      }
    } catch (e) {
      console.warn('Could not load Gemini cycle insights:', e);
      ui.renderCycleSyncingGuide(todayStatus, null, false);
    }
  }

  renderAll() {
    const profile = storage.getProfile();
    const logs = storage.getAllLogs();
    const todayStatus = getCycleStatus(this.today, profile, logs);
    const todayKey = formatDateKey(this.today);
    const todayLog = logs[todayKey] || {};

    // Update greeting & header user info
    const greetingEl = document.getElementById('user-greeting');
    const headerGreetingEl = document.getElementById('header-user-greeting');
    const hour = new Date().getHours();
    const timeGreeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    const greetingText = profile.userName ? `${timeGreeting}, ${profile.userName}` : timeGreeting;
    if (greetingEl) {
      greetingEl.textContent = greetingText;
    }
    if (headerGreetingEl) {
      headerGreetingEl.textContent = greetingText;
    }

    // User avatar or Fraunces monogram fallback in masthead
    const bannerAvatar = document.getElementById('banner-user-avatar');
    const bannerMonogram = document.getElementById('banner-avatar-monogram');
    const bannerProvider = document.getElementById('banner-provider-badge');
    const user = this.auth.currentUser;
    const displayName = (profile.userName || user?.name || 'A').trim();
    if (bannerAvatar && bannerMonogram) {
      if (user?.avatarUrl) {
        bannerAvatar.src = user.avatarUrl;
        bannerAvatar.alt = displayName;
        bannerAvatar.style.display = 'block';
        bannerMonogram.style.display = 'none';
      } else {
        bannerAvatar.style.display = 'none';
        bannerMonogram.textContent = displayName.charAt(0).toUpperCase();
        bannerMonogram.style.display = 'inline';
      }
    } else if (bannerAvatar) {
      bannerAvatar.src = user?.avatarUrl || '/icon-192.png';
      bannerAvatar.alt = displayName;
    }
    if (bannerProvider) {
      bannerProvider.textContent = user?.provider === 'google' ? 'G' :
                                   user?.provider === 'apple' ? '' : '🌸';
      bannerProvider.title = user?.provider ? `Signed in with ${user.provider}` : 'Private Account';
    }

    // Update active date display label & consecutive logging streak
    const nowToday = new Date();
    const activeDateLabel = document.getElementById('dashboard-active-date-label');
    if (activeDateLabel) {
      const isActualToday = formatDateKey(this.today) === formatDateKey(nowToday);
      const formattedDate = this.today.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      activeDateLabel.textContent = isActualToday ? `Today, ${formattedDate}` : formattedDate;
    }

    const streakCountEl = document.getElementById('streak-days-count');
    if (streakCountEl) {
      let streak = 0;
      let cursorDate = logs[formatDateKey(nowToday)] ? nowToday : addDays(nowToday, -1);
      while (logs[formatDateKey(cursorDate)]) {
        streak++;
        cursorDate = addDays(cursorDate, -1);
      }
      streakCountEl.textContent = String(streak);
    }

    // Render Grand Biological Cycle Dial
    ui.renderCycleDial(todayStatus, profile);

    // Render Dynamic Dashboard Vitals (Hydration, Sleep, Hormones, Timeline)
    ui.renderDashboardVitals(todayStatus, profile, todayLog, (type, val) => this._handleVitalChange(type, val));

    // Render Calendar
    ui.renderCalendar(
      this.currentYear,
      this.currentMonth,
      profile,
      logs,
      (dateKey) => this.openLoggerModalForDate(dateKey)
    );

    // Render Syncing Guide with Gemini intelligence
    this.loadCycleSyncingInsights(false);

    // Render Analytics
    ui.renderHistoryAnalytics(profile, logs);
  }

  _handleVitalChange(type, val) {
    const todayKey = formatDateKey(this.today);
    const log = storage.getLog(todayKey) || {
      flow: null,
      symptoms: [],
      moods: ['Radiant'],
      waterGlasses: 6,
      sleepHours: 8.0,
      notes: ''
    };

    if (type === 'water') {
      log.waterGlasses = Math.max(0, val);
      storage.saveLog(todayKey, log);
      ui.showToast(`Hydration: ${val} glasses (${val * 250} ml)`, '💧');
    } else if (type === 'sleep') {
      log.sleepHours = Math.max(1, Math.min(18, Math.round(val * 10) / 10));
      storage.saveLog(todayKey, log);
      ui.showToast(`Sleep set to ${log.sleepHours.toFixed(1)} hrs`, '🌙');
    } else if (type === 'mood') {
      log.moods = log.moods || [];
      const idx = log.moods.indexOf(val);
      if (idx > -1) {
        log.moods.splice(idx, 1);
      } else {
        log.moods.push(val);
      }
      storage.saveLog(todayKey, log);
      ui.showToast(`Mood: ${val}`, '✨');
    } else if (type === 'symptom') {
      log.symptoms = log.symptoms || [];
      const idx = log.symptoms.indexOf(val);
      if (idx > -1) {
        log.symptoms.splice(idx, 1);
        ui.showToast(`Removed ${val}`, '➖');
      } else {
        log.symptoms.push(val);
        ui.showToast(`Logged ${val}`, '➕');
      }
      storage.saveLog(todayKey, log);
    }

    const profile = storage.getProfile();
    const logs = storage.getAllLogs();
    const todayStatus = getCycleStatus(this.today, profile, logs);
    ui.renderDashboardVitals(todayStatus, profile, log, (t, v) => this._handleVitalChange(t, v));
  }

  switchTab(tabId) {
    this.currentView = tabId;
    analytics.trackEvent('view', tabId);

    // Update tab bar buttons
    document.querySelectorAll('.nav-tab').forEach(tab => {
      const target = tab.getAttribute('data-tab');
      tab.classList.toggle('active', target === tabId);
    });

    // Update panels
    document.querySelectorAll('.view-panel').forEach(panel => {
      const id = panel.id.replace('view-', '');
      panel.classList.toggle('active', id === tabId);
    });

    // If switching to calendar or analytics, refresh their layouts
    if (tabId === 'calendar' || tabId === 'analytics') {
      this.renderAll();
    }

    // If switching to cycle syncing, ensure Gemini insights are loaded
    if (tabId === 'syncing') {
      this.loadCycleSyncingInsights(false);
    }

    // If switching to AI coach, refresh suggestions
    if (tabId === 'ai-coach' && this.aiCoach) {
      this.aiCoach.renderChatUI();
    }

    this.aiCoach?.onTabChanged?.(tabId);
  }

  openLoggerModalForDate(dateKey) {
    this.activeLogDate = dateKey;
    const logData = storage.getLog(dateKey) || {};
    this.waterCount = logData.waterGlasses || 8;

    ui.populateLoggerModal(dateKey, logData);

    const modal = document.getElementById('logger-modal');
    if (modal) modal.classList.add('active');
  }

  closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) modal.classList.remove('active');
  }

  saveActiveLog() {
    const dateInput = document.getElementById('log-date-input');
    const targetDateKey = dateInput ? dateInput.value : this.activeLogDate;

    // Read selected flow
    let selectedFlow = null;
    const activeFlowChip = document.querySelector('.flow-chip.active');
    if (activeFlowChip) {
      selectedFlow = activeFlowChip.getAttribute('data-value');
    }

    // Read selected symptoms
    const selectedSymptoms = [];
    document.querySelectorAll('.symptom-chip.active').forEach(chip => {
      selectedSymptoms.push(chip.getAttribute('data-value'));
    });

    // Read selected moods
    const selectedMoods = [];
    document.querySelectorAll('.mood-chip.active').forEach(chip => {
      selectedMoods.push(chip.getAttribute('data-value'));
    });

    // Read sleep
    const sleepSlider = document.getElementById('log-sleep-slider');
    const sleepHours = sleepSlider ? parseFloat(sleepSlider.value) : 8;

    // Read notes
    const notesInput = document.getElementById('log-notes');
    const notes = notesInput ? notesInput.value.trim() : '';

    const newLog = {
      flow: selectedFlow,
      symptoms: selectedSymptoms,
      moods: selectedMoods,
      waterGlasses: this.waterCount,
      sleepHours,
      notes
    };

    // If user selected period flow (light/medium/heavy) on this date, check if this should adjust last period start
    if (selectedFlow && selectedFlow !== 'none') {
      const profile = storage.getProfile();
      // If user marks flow on today or newer date, update lastPeriodStart
      const activeDate = parseDateKey(targetDateKey);
      const currentStart = parseDateKey(profile.lastPeriodStart);
      if (activeDate >= currentStart) {
        profile.lastPeriodStart = targetDateKey;
        storage.saveProfile(profile);
      }
    }

    storage.saveLog(targetDateKey, newLog);
    analytics.trackEvent('symptom', 'logged', targetDateKey);
    analytics.logAuditAction('SYMPTOMS_LOGGED', `Updated wellness & flow for ${targetDateKey}`);
    this.closeModal('logger-modal');
    this.renderAll();
    ui.showToast(`Logged for ${targetDateKey}!`, '💖');
  }

  markPeriodStartedToday() {
    const todayKey = formatDateKey(this.today);
    const profile = storage.getProfile();
    profile.lastPeriodStart = todayKey;
    storage.saveProfile(profile);

    // Record daily log with medium flow (do not invent unlogged symptoms like 'Cramps')
    const existingLog = storage.getLog(todayKey) || {};
    storage.saveLog(todayKey, {
      ...existingLog,
      flow: existingLog.flow && existingLog.flow !== 'none' ? existingLog.flow : 'medium',
      notes: existingLog.notes || 'Cycle day 1 started today.'
    });

    analytics.trackEvent('cycle', 'period_start_updated', todayKey);
    analytics.logAuditAction('PERIOD_START_RECORDED', `Cycle Day 1 recorded on ${todayKey}`);

    this.renderAll();
    ui.showToast('New cycle recorded starting today!', '🩸');
  }

  attachEventListeners() {
    // Real-Time Synchronization with AI Agent updates
    window.addEventListener('aify:data-updated', (e) => {
      console.log('🔄 Real-time data synchronization received from AI Coach:', e.detail);
      this.renderAll();

      if (e.detail && e.detail.summaries && e.detail.summaries.length > 0) {
        const first = e.detail.summaries[0];
        ui.showToast(`Aify updated: ${first.title} (${first.detail})`, first.icon || '✨');
      }
    });

    // Nav Tabs
    document.querySelectorAll('.nav-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const tabTarget = tab.getAttribute('data-tab');
        this.switchTab(tabTarget);
      });
    });

    // Banner AI Coach button (CSP-compliant listener instead of inline onclick)
    const btnBannerAiCoach = document.getElementById('btn-open-ai-coach-banner');
    if (btnBannerAiCoach) {
      btnBannerAiCoach.addEventListener('click', () => this.switchTab('ai-coach'));
    }

    // Header Quick Log Button
    const btnQuickLog = document.getElementById('btn-quick-log');
    if (btnQuickLog) {
      btnQuickLog.addEventListener('click', () => {
        this.openLoggerModalForDate(formatDateKey(this.today));
      });
    }

    // "Period Started Today" Shortcut button
    const btnPeriodStart = document.getElementById('btn-period-start-today');
    if (btnPeriodStart) {
      btnPeriodStart.addEventListener('click', () => {
        if (confirm('Mark today as Day 1 of your new menstrual cycle?')) {
          this.markPeriodStartedToday();
        }
      });
    }

    // Theme Toggle already bound in setupTheme() via .js-theme-toggle; guard against duplicate binding
    const btnThemeToggle = document.getElementById('btn-theme-toggle');
    if (btnThemeToggle && !btnThemeToggle.dataset.themeBound) {
      btnThemeToggle.dataset.themeBound = 'true';
      btnThemeToggle.addEventListener('click', () => this.toggleTheme());
    }

    // Calendar Navigation
    const btnPrevMonth = document.getElementById('btn-cal-prev');
    const btnNextMonth = document.getElementById('btn-cal-next');
    const btnTodayMonth = document.getElementById('btn-cal-today');

    if (btnPrevMonth) {
      btnPrevMonth.addEventListener('click', () => {
        this.currentMonth--;
        if (this.currentMonth < 0) {
          this.currentMonth = 11;
          this.currentYear--;
        }
        this.renderAll();
      });
    }

    if (btnNextMonth) {
      btnNextMonth.addEventListener('click', () => {
        this.currentMonth++;
        if (this.currentMonth > 11) {
          this.currentMonth = 0;
          this.currentYear++;
        }
        this.renderAll();
      });
    }

    if (btnTodayMonth) {
      btnTodayMonth.addEventListener('click', () => {
        this.currentYear = this.today.getFullYear();
        this.currentMonth = this.today.getMonth();
        this.renderAll();
      });
    }

    // Modal Close Buttons
    document.querySelectorAll('.btn-close-modal, .btn-modal-cancel').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const modal = e.target.closest('.modal-overlay');
        if (modal) modal.classList.remove('active');
      });
    });

    // Modal Background Click
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.classList.remove('active');
      });
    });

    // Logger Chip Selection Handlers
    document.querySelectorAll('.flow-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const wasActive = chip.classList.contains('active');
        document.querySelectorAll('.flow-chip').forEach(c => c.classList.remove('active'));
        if (!wasActive) chip.classList.add('active');
      });
    });

    document.querySelectorAll('.symptom-chip, .mood-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        chip.classList.toggle('active');
      });
    });

    // Water Stepper
    const btnWaterMinus = document.getElementById('btn-water-minus');
    const btnWaterPlus = document.getElementById('btn-water-plus');
    const waterValEl = document.getElementById('log-water-val');

    if (btnWaterMinus) {
      btnWaterMinus.addEventListener('click', () => {
        this.waterCount = Math.max(0, this.waterCount - 1);
        if (waterValEl) waterValEl.textContent = `${this.waterCount} glasses`;
      });
    }

    if (btnWaterPlus) {
      btnWaterPlus.addEventListener('click', () => {
        this.waterCount = Math.min(20, this.waterCount + 1);
        if (waterValEl) waterValEl.textContent = `${this.waterCount} glasses`;
      });
    }

    // Sleep Slider
    const sleepSlider = document.getElementById('log-sleep-slider');
    const sleepValEl = document.getElementById('log-sleep-val');
    if (sleepSlider && sleepValEl) {
      sleepSlider.addEventListener('input', (e) => {
        sleepValEl.textContent = `${e.target.value}h`;
      });
    }

    // Save Log Button
    const btnSaveLog = document.getElementById('btn-save-log');
    if (btnSaveLog) {
      btnSaveLog.addEventListener('click', () => this.saveActiveLog());
    }

    // Settings Modal Open/Save
    const btnOpenSettings = document.getElementById('btn-open-settings');
    const settingsModal = document.getElementById('settings-modal');
    if (btnOpenSettings && settingsModal) {
      btnOpenSettings.addEventListener('click', () => {
        const profile = storage.getProfile();
        document.getElementById('setting-username').value = profile.userName || 'User';
        document.getElementById('setting-partnername').value = profile.partnerName || '';
        document.getElementById('setting-cyclelength').value = profile.cycleLength || 28;
        document.getElementById('setting-periodlength').value = profile.periodLength || 5;
        document.getElementById('setting-lastperiod').value = profile.lastPeriodStart || formatDateKey(this.today);
        
        // Refresh Gemini AI settings & Supabase cloud sync status
        this._refreshAiSettingsStatus();
        this._refreshSupabaseSettingsStatus();

        settingsModal.classList.add('active');
      });
    }

    // Supabase Custom Config Drawer Toggle
    const btnToggleCustomSupabase = document.getElementById('btn-toggle-custom-supabase');
    const supabaseDrawer = document.getElementById('supabase-custom-config-drawer');
    if (btnToggleCustomSupabase && supabaseDrawer) {
      btnToggleCustomSupabase.addEventListener('click', () => {
        const isClosed = supabaseDrawer.style.display === 'none' || !supabaseDrawer.style.display;
        supabaseDrawer.style.display = isClosed ? 'block' : 'none';
        btnToggleCustomSupabase.textContent = isClosed ? 'Hide Custom Credentials ✕' : 'Configure Custom Credentials ⚙️';
      });
    }

    // Save Custom Supabase Credentials
    const btnSaveSupabaseConfig = document.getElementById('btn-save-supabase-config');
    if (btnSaveSupabaseConfig) {
      btnSaveSupabaseConfig.addEventListener('click', async () => {
        const url = document.getElementById('setting-supabase-url')?.value.trim();
        const anonKey = document.getElementById('setting-supabase-anonkey')?.value.trim();
        if (!url || !anonKey) {
          ui.showToast('Please provide both Supabase URL and Anon Key', '⚠️');
          return;
        }

        btnSaveSupabaseConfig.disabled = true;
        btnSaveSupabaseConfig.textContent = 'Connecting...';
        try {
          await supabaseService.setCustomConfig(url, anonKey);
          await storage.uploadLocalToCloud();
          await this._refreshSupabaseSettingsStatus();
          ui.showToast('Supabase connected! Cloud sync active.', '🚀');
        } catch (e) {
          ui.showToast('Failed to connect to Supabase: ' + e.message, '⚠️');
        } finally {
          btnSaveSupabaseConfig.disabled = false;
          btnSaveSupabaseConfig.textContent = 'Save & Connect';
        }
      });
    }

    // Clear Custom Supabase Credentials
    const btnClearSupabaseConfig = document.getElementById('btn-clear-supabase-config');
    if (btnClearSupabaseConfig) {
      btnClearSupabaseConfig.addEventListener('click', async () => {
        await supabaseService.setCustomConfig(null, null);
        const urlInput = document.getElementById('setting-supabase-url');
        const anonKeyInput = document.getElementById('setting-supabase-anonkey');
        if (urlInput) urlInput.value = '';
        if (anonKeyInput) anonKeyInput.value = '';
        await this._refreshSupabaseSettingsStatus();
        ui.showToast('Custom credentials removed. Returned to local mode.', 'ℹ️');
      });
    }

    // Supabase Manual Sync Now
    const btnSyncNow = document.getElementById('btn-supabase-sync-now');
    if (btnSyncNow) {
      btnSyncNow.addEventListener('click', async () => {
        const icon = document.getElementById('sync-spinner-icon');
        const text = document.getElementById('sync-button-text');
        btnSyncNow.disabled = true;
        if (text) text.textContent = 'Syncing...';
        if (icon) icon.style.display = 'inline-block';

        try {
          await supabaseService.init();
          if (!supabaseService.hasConfig()) {
            ui.showToast('Local storage is up to date (no cloud configured)', '📱');
            return;
          }
          const upRes = await storage.uploadLocalToCloud();
          const downRes = await storage.syncFromCloud();
          if (upRes.success || downRes.success) {
            this.renderAll();
            ui.showToast('Cycle records & memories synchronized with Supabase Cloud!', '☁️');
          } else if (upRes.reason === 'not_authenticated' || downRes.reason === 'not_authenticated') {
            ui.showToast('Sign in with Google or Email to sync with Supabase Cloud.', 'ℹ️');
          } else if (upRes.reason === 'demo_mode') {
            ui.showToast('Demo data is kept local and not uploaded to cloud.', 'ℹ️');
          } else {
            ui.showToast(`Cloud sync failed: ${upRes.error || downRes.error || 'Unknown error'}`, '⚠️');
          }
        } catch (e) {
          ui.showToast('Cloud sync error: ' + e.message, '⚠️');
        } finally {
          btnSyncNow.disabled = false;
          if (text) text.textContent = 'Sync Now';
        }
      });
    }

    // Cycle Syncing: Refresh with Gemini 3.6 Flash
    const btnRefreshSync = document.getElementById('btn-refresh-gemini-sync');
    if (btnRefreshSync) {
      btnRefreshSync.addEventListener('click', () => {
        this.loadCycleSyncingInsights(true);
      });
    }

    const btnSaveSettings = document.getElementById('btn-save-settings');
    if (btnSaveSettings) {
      btnSaveSettings.addEventListener('click', () => {
        const profile = storage.getProfile();
        profile.userName = document.getElementById('setting-username').value.trim() || 'User';
        profile.partnerName = document.getElementById('setting-partnername').value.trim() || '';
        profile.cycleLength = parseInt(document.getElementById('setting-cyclelength').value, 10) || 28;
        profile.periodLength = parseInt(document.getElementById('setting-periodlength').value, 10) || 5;
        profile.lastPeriodStart = document.getElementById('setting-lastperiod').value || formatDateKey(this.today);

        const aiEnabledCheckbox = document.getElementById('setting-aicoach-enabled');
        if (aiEnabledCheckbox) {
          profile.aiCoachEnabled = aiEnabledCheckbox.checked;
        }

        storage.saveProfile(profile);
        this.closeModal('settings-modal');
        this.renderAll();
        this.aiCoach?.updateEngineBadge();
        ui.showToast('Profile and cycle settings updated!', '⚙️');
      });
    }

    // Export / Import / Reset Actions
    const btnExportData = document.getElementById('btn-export-data');
    if (btnExportData) {
      btnExportData.addEventListener('click', () => {
        const json = storage.exportBackup();
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `aifycycle-backup-${formatDateKey(new Date())}.json`;
        a.click();
        URL.revokeObjectURL(url);
        analytics.trackEvent('backup', 'export');
        analytics.logAuditAction('DATA_EXPORTED', 'User exported JSON data backup');
        ui.showToast('Data backup downloaded', '📁');
      });
    }

    // Analytics Telemetry Export
    const btnExportTelemetry = document.getElementById('btn-export-telemetry');
    if (btnExportTelemetry) {
      btnExportTelemetry.addEventListener('click', () => {
        const report = analytics.exportComplianceReport();
        const blob = new Blob([report], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `aifycycle-compliance-audit-${formatDateKey(new Date())}.json`;
        a.click();
        URL.revokeObjectURL(url);
        ui.showToast('Compliance report downloaded', '📄');
      });
    }

    // Analytics Tracking Toggle in Settings
    const toggleAnalytics = document.getElementById('setting-analytics-toggle');
    if (toggleAnalytics) {
      toggleAnalytics.checked = analytics.isTrackingEnabled();
      toggleAnalytics.addEventListener('change', (e) => {
        analytics.saveConsent({ analyticsAllowed: e.target.checked });
        ui.showToast(`Anonymous analytics ${e.target.checked ? 'enabled' : 'disabled'}`, '🛡️');
      });
    }

    // GDPR Right to Erasure: Complete Account & Data Wipe
    const btnGdprWipe = document.getElementById('btn-gdpr-wipe');
    if (btnGdprWipe) {
      btnGdprWipe.addEventListener('click', async () => {
        const confirmed = confirm(
          '⚠️ GDPR DATA ERASURE WARNING:\n\n' +
          'This will permanently delete all your account credentials, menstrual cycle logs, symptom entries, AI chat history, learned health memories, API keys, and local analytics from this device and Supabase Cloud.\n\n' +
          'This action is irreversible. Do you wish to proceed?'
        );

        if (confirmed) {
          const result = await storage.purgeAllUserData();
          if (result?.error) {
            alert(`Local data erased, but cloud erasure reported an error: ${result.error}`);
          } else {
            alert('All your personal data, cycle records, and sessions have been permanently erased.');
          }
          window.location.reload();
        }
      });
    }

    const btnResetData = document.getElementById('btn-reset-data');
    if (btnResetData) {
      btnResetData.addEventListener('click', () => {
        if (confirm('Reset all cycle logs and restore starter demo data?')) {
          storage.resetAllData();
          this.closeModal('settings-modal');
          this.renderAll();
          ui.showToast('Starter demo data restored', '🔄');
        }
      });
    }

    // --- Dashboard Interactive Controls ---
    // 1. Water quick add
    const btnAddWater = document.getElementById('btn-quick-add-water');
    if (btnAddWater) {
      btnAddWater.addEventListener('click', () => {
        const todayKey = formatDateKey(this.today);
        const log = storage.getLog(todayKey) || { waterGlasses: 6 };
        const nextGlasses = (log.waterGlasses || 0) + 1;
        this._handleVitalChange('water', nextGlasses);
      });
    }

    // 2. Sleep +/- quick buttons
    const btnSleepPlus = document.getElementById('btn-sleep-plus');
    const btnSleepMinus = document.getElementById('btn-sleep-minus');
    if (btnSleepPlus) {
      btnSleepPlus.addEventListener('click', () => {
        const todayKey = formatDateKey(this.today);
        const log = storage.getLog(todayKey) || { sleepHours: 8.0 };
        this._handleVitalChange('sleep', (log.sleepHours || 8.0) + 0.5);
      });
    }
    if (btnSleepMinus) {
      btnSleepMinus.addEventListener('click', () => {
        const todayKey = formatDateKey(this.today);
        const log = storage.getLog(todayKey) || { sleepHours: 8.0 };
        this._handleVitalChange('sleep', Math.max(1, (log.sleepHours || 8.0) - 0.5));
      });
    }

    // 3. Quick Mood Chips on Dashboard
    document.querySelectorAll('.dash-mood-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const mood = chip.getAttribute('data-mood');
        this._handleVitalChange('mood', mood);
      });
    });

    // 4. Quick Symptom Chips on Dashboard
    document.querySelectorAll('.dash-symptom-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const sym = chip.getAttribute('data-symptom');
        this._handleVitalChange('symptom', sym);
      });
    });

    // 5. AI Whisper Prompt Chips (opens floating AiFy drawer & sends prompt directly)
    document.querySelectorAll('.ai-quick-prompt-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const prompt = chip.getAttribute('data-prompt');
        if (this.aiCoach && prompt) {
          this.aiCoach.openFloatingDrawer();
          this.aiCoach.sendMessage(prompt);
        }
      });
    });

    // 6. Dashboard Date Switcher
    const btnDashPrev = document.getElementById('btn-dash-prev-day');
    const btnDashNext = document.getElementById('btn-dash-next-day');
    if (btnDashPrev) {
      btnDashPrev.addEventListener('click', () => {
        this.today = addDays(this.today, -1);
        this.renderAll();
      });
    }
    if (btnDashNext) {
      btnDashNext.addEventListener('click', () => {
        this.today = addDays(this.today, 1);
        this.renderAll();
      });
    }

    // 7. Period Started Today Quick Button handled above

    // 8. Logout
    const btnLogout = document.getElementById('btn-logout');
    if (btnLogout) {
      btnLogout.addEventListener('click', async () => {
        await this.auth.logout();
        ui.showToast('Signed out successfully', '👋');
        this._routeUser();
      });
    }
  }
}

// Instantiate on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  const app = new AifyCycleApp();
  app.init();
});
