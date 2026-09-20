/**
 * AifyCycle - Application Controller
 * Main entry point coordinating auth, onboarding, storage, cycle predictions,
 * AI coaching, UI rendering, and user interactions.
 */

import { storage } from './storage.js';
import { getCycleStatus, formatDateKey, parseDateKey } from './cycle-engine.js';
import { ui } from './ui-components.js';
import { AuthManager } from './auth.js';
import { OnboardingWizard } from './onboarding.js';
import { AICoach } from './ai-coach.js';
import { analytics } from './analytics-tracker.js';

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
  }

  init() {
    this.setupTheme();
    this._initComplianceAndConsent();
    this._routeUser();
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
    document.getElementById('view-auth').style.display = '';
    document.getElementById('view-onboarding').style.display = 'none';
    document.getElementById('main-app-container').style.display = 'none';

    this._attachAuthListeners();
  }

  _attachAuthListeners() {
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
      loginForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const email = document.getElementById('login-email').value;
        const password = document.getElementById('login-password').value;

        const result = this.auth.login({ email, password });
        if (result.success) {
          this._routeUser();
        } else {
          this._showAuthErrors(result.errors);
        }
      });
    }

    // Signup form submit
    if (signupForm) {
      signupForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const name = document.getElementById('signup-name').value;
        const email = document.getElementById('signup-email').value;
        const password = document.getElementById('signup-password').value;
        const dateOfBirth = document.getElementById('signup-dob').value || null;

        const result = this.auth.signup({ name, email, password, dateOfBirth });
        if (result.success) {
          // Set user name in profile
          const profile = storage.getProfile();
          profile.userName = name.trim();
          storage.saveProfile(profile);
          this._routeUser();
        } else {
          this._showAuthErrors(result.errors);
        }
      });
    }

    // Guest login
    const guestBtn = document.getElementById('btn-guest-login');
    if (guestBtn) {
      guestBtn.addEventListener('click', () => {
        this.auth.guestLogin();
        this._routeUser();
      });
    }
  }

  _showAuthErrors(errors) {
    const display = document.getElementById('auth-error-display');
    if (display) {
      display.style.display = 'block';
      display.innerHTML = errors.map(e => `<p>⚠️ ${e}</p>`).join('');
      // Shake animation
      display.classList.remove('shake');
      void display.offsetWidth;
      display.classList.add('shake');
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
    document.getElementById('view-auth').style.display = 'none';
    document.getElementById('view-onboarding').style.display = '';
    document.getElementById('main-app-container').style.display = 'none';

    // Pre-fill name from auth
    const user = this.auth.currentUser;
    
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
    document.getElementById('view-auth').style.display = 'none';
    document.getElementById('view-onboarding').style.display = 'none';
    document.getElementById('main-app-container').style.display = '';

    this.renderAll();
    this.attachEventListeners();

    // Initialize AI Coach
    this.aiCoach = new AICoach();
    this.aiCoach.init();
  }

  setupTheme() {
    const savedTheme = storage.getTheme();
    document.documentElement.setAttribute('data-theme', savedTheme);
    const themeIcon = document.getElementById('theme-toggle-icon');
    if (themeIcon) {
      themeIcon.textContent = savedTheme === 'light' ? '🌙' : '☀️';
    }
  }

  toggleTheme() {
    const currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
    const nextTheme = currentTheme === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', nextTheme);
    storage.saveTheme(nextTheme);

    const themeIcon = document.getElementById('theme-toggle-icon');
    if (themeIcon) {
      themeIcon.textContent = nextTheme === 'light' ? '🌙' : '☀️';
    }
    ui.showToast(`Switched to ${nextTheme === 'light' ? 'Light' : 'Dark'} mode`, '🎨');
  }

  async _refreshAiSettingsStatus() {
    const statusPill = document.getElementById('ai-settings-status');
    if (!statusPill) return;

    statusPill.textContent = 'Checking...';
    statusPill.className = 'ai-status-pill';

    let serverConfigured = false;
    let modelName = 'gemini-3.8-flash';
    try {
      const res = await fetch('/api/gemini/status');
      if (res.ok) {
        const data = await res.json();
        serverConfigured = Boolean(data.configured);
        if (data.model) modelName = data.model;
      }
    } catch (e) {}

    if (serverConfigured) {
      statusPill.textContent = `✨ Gemini 3.8 Flash Active`;
      statusPill.className = 'ai-status-pill pill-server';
    } else {
      statusPill.textContent = '🧠 Local Intelligence Active';
      statusPill.className = 'ai-status-pill pill-local';
    }
  }

  async loadCycleSyncingInsights(forceRefresh = false) {
    const profile = storage.getProfile();
    const logs = storage.getAllLogs();
    const todayStatus = getCycleStatus(this.today, profile);

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
    const todayStatus = getCycleStatus(this.today, profile);

    // Update greeting
    const greetingEl = document.getElementById('user-greeting');
    if (greetingEl) {
      greetingEl.textContent = `Hello, ${profile.userName || 'there'} ✨`;
    }

    // Render Dial
    ui.renderCycleDial(todayStatus, profile);

    // Render Calendar
    ui.renderCalendar(
      this.currentYear,
      this.currentMonth,
      profile,
      logs,
      (dateKey) => this.openLoggerModalForDate(dateKey)
    );

    // Render Syncing Guide with Gemini 3.8 Flash intelligence
    this.loadCycleSyncingInsights(false);

    // Render Analytics
    ui.renderHistoryAnalytics(profile, logs);
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

    // Also write a daily log with medium flow
    const existingLog = storage.getLog(todayKey) || {};
    storage.saveLog(todayKey, {
      ...existingLog,
      flow: 'medium',
      symptoms: existingLog.symptoms || ['Cramps'],
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

    // Theme Toggle
    const btnThemeToggle = document.getElementById('btn-theme-toggle');
    if (btnThemeToggle) {
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
        
        // Refresh Gemini AI settings
        this._refreshAiSettingsStatus();

        settingsModal.classList.add('active');
      });
    }

    // Cycle Syncing: Refresh with Gemini 3.8 Flash
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
      btnGdprWipe.addEventListener('click', () => {
        const confirmed = confirm(
          '⚠️ GDPR DATA ERASURE WARNING:\n\n' +
          'This will permanently delete all your account credentials, menstrual cycle logs, symptom entries, AI chat history, learned health memories, API keys, and local analytics from this device.\n\n' +
          'This action is irreversible. Do you wish to proceed?'
        );

        if (confirmed) {
          storage.purgeAllUserData();
          alert('All your personal data, cycle records, and sessions have been permanently erased from this device.');
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

    // Logout
    const btnLogout = document.getElementById('btn-logout');
    if (btnLogout) {
      btnLogout.addEventListener('click', () => {
        if (confirm('Are you sure you want to log out?')) {
          this.auth.logout();
          // Reload the page to show auth screen cleanly
          window.location.reload();
        }
      });
    }
  }
}

// Instantiate on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  const app = new AifyCycleApp();
  app.init();
});
