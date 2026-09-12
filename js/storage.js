/**
 * AifyCycle - Storage & Persistence Engine
 * Manages local storage, preloaded demo data, and import/export.
 */

import { formatDateKey, addDays } from './cycle-engine.js';

const STORAGE_KEYS = {
  PROFILE: 'aifycycle_profile_v1',
  LOGS: 'aifycycle_logs_v1',
  THEME: 'aifycycle_theme_v1',
  AUTH_SESSION: 'aifycycle_auth_session_v1',
  USERS: 'aifycycle_users_v1',
  ONBOARDING_DONE: 'aifycycle_onboarding_done_v1',
  CHAT_HISTORY: 'aifycycle_chat_history_v1'
};

/**
 * Build realistic starter seed data based on today's real date
 */
function createDefaultSeedData() {
  const today = new Date();
  
  // Set last period start to 13 days ago (puts today at Day 14: Peak Ovulation phase)
  const lastPeriodStart = addDays(today, -13);
  const previousCycleStart = addDays(lastPeriodStart, -28);

  const defaultProfile = {
    userName: 'Agatha',
    partnerName: 'Aify',
    cycleLength: 28,
    periodLength: 5,
    lastPeriodStart: formatDateKey(lastPeriodStart),
    reminderEnabled: true,
    notifications: {
      periodReminderDays: 2,
      fertileWindowAlert: true
    }
  };

  // Seed historical logs
  const defaultLogs = {};

  // Previous cycle period (41 to 37 days ago)
  for (let i = 0; i < 5; i++) {
    const dayDate = addDays(previousCycleStart, i);
    const key = formatDateKey(dayDate);
    defaultLogs[key] = {
      flow: i === 0 ? 'light' : i < 3 ? 'heavy' : 'light',
      symptoms: i < 3 ? ['Cramps', 'Lower Back Pain', 'Fatigue'] : ['Fatigue'],
      moods: i < 2 ? ['Sensitive', 'Low Energy'] : ['Calm'],
      waterGlasses: 7,
      sleepHours: 8,
      notes: i === 1 ? 'Aify made warm herbal tea and brought a heating pad 💕 feeling loved.' : ''
    };
  }

  // Current cycle period (13 to 9 days ago)
  for (let i = 0; i < 5; i++) {
    const dayDate = addDays(lastPeriodStart, i);
    const key = formatDateKey(dayDate);
    defaultLogs[key] = {
      flow: i === 0 ? 'spotting' : i < 3 ? 'heavy' : 'medium',
      symptoms: i < 3 ? ['Cramps', 'Bloating'] : ['Tender Breasts'],
      moods: i < 2 ? ['Sensitive', 'Calm'] : ['Calm', 'Happy'],
      waterGlasses: 8,
      sleepHours: 8.5,
      notes: i === 0 ? 'Cycle started. Taking it easy today with restorative evening stretch.' : ''
    };
  }

  // Follicular spark (4 days ago)
  const follicularDay = addDays(today, -4);
  defaultLogs[formatDateKey(follicularDay)] = {
    flow: null,
    symptoms: [],
    moods: ['High Energy', 'Happy'],
    waterGlasses: 9,
    sleepHours: 7.5,
    notes: 'Great 5km morning run, feeling inspired and full of creative spark!'
  };

  // Today log (Ovulation)
  const todayKey = formatDateKey(today);
  defaultLogs[todayKey] = {
    flow: null,
    symptoms: [],
    moods: ['High Energy', 'Romantic', 'Happy'],
    waterGlasses: 8,
    sleepHours: 8,
    notes: 'Peak vitality today! Glowing energy and feeling centered.'
  };

  return { defaultProfile, defaultLogs };
}

export class StorageService {
  constructor() {
    this.init();
  }

  init() {
    if (!localStorage.getItem(STORAGE_KEYS.PROFILE)) {
      const { defaultProfile, defaultLogs } = createDefaultSeedData();
      this.saveProfile(defaultProfile);
      this.saveAllLogs(defaultLogs);
    }
  }

  getProfile() {
    try {
      const data = localStorage.getItem(STORAGE_KEYS.PROFILE);
      return data ? JSON.parse(data) : createDefaultSeedData().defaultProfile;
    } catch (e) {
      console.error('Error reading profile from storage', e);
      return createDefaultSeedData().defaultProfile;
    }
  }

  saveProfile(profile) {
    localStorage.setItem(STORAGE_KEYS.PROFILE, JSON.stringify(profile));
  }

  getAllLogs() {
    try {
      const data = localStorage.getItem(STORAGE_KEYS.LOGS);
      return data ? JSON.parse(data) : {};
    } catch (e) {
      console.error('Error reading logs from storage', e);
      return {};
    }
  }

  saveAllLogs(logs) {
    localStorage.setItem(STORAGE_KEYS.LOGS, JSON.stringify(logs));
  }

  getLog(dateKey) {
    const logs = this.getAllLogs();
    return logs[dateKey] || null;
  }

  saveLog(dateKey, logData) {
    const logs = this.getAllLogs();
    logs[dateKey] = {
      ...(logs[dateKey] || {}),
      ...logData,
      updatedAt: new Date().toISOString()
    };
    this.saveAllLogs(logs);
    return logs[dateKey];
  }

  deleteLog(dateKey) {
    const logs = this.getAllLogs();
    if (logs[dateKey]) {
      delete logs[dateKey];
      this.saveAllLogs(logs);
    }
  }

  getTheme() {
    return localStorage.getItem(STORAGE_KEYS.THEME) || 'dark';
  }

  saveTheme(theme) {
    localStorage.setItem(STORAGE_KEYS.THEME, theme);
  }

  exportBackup() {
    const exportObject = {
      app: 'AifyCycle',
      version: '1.0.0',
      exportedAt: new Date().toISOString(),
      profile: this.getProfile(),
      logs: this.getAllLogs()
    };
    return JSON.stringify(exportObject, null, 2);
  }

  importBackup(jsonString) {
    try {
      const parsed = JSON.parse(jsonString);
      if (parsed.profile) this.saveProfile(parsed.profile);
      if (parsed.logs) this.saveAllLogs(parsed.logs);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  resetAllData() {
    localStorage.removeItem(STORAGE_KEYS.PROFILE);
    localStorage.removeItem(STORAGE_KEYS.LOGS);
    this.init();
  }

  // --- Auth Session ---

  getAuthSession() {
    try {
      const data = localStorage.getItem(STORAGE_KEYS.AUTH_SESSION);
      return data ? JSON.parse(data) : null;
    } catch (e) {
      return null;
    }
  }

  saveAuthSession(session) {
    localStorage.setItem(STORAGE_KEYS.AUTH_SESSION, JSON.stringify(session));
  }

  clearAuthSession() {
    localStorage.removeItem(STORAGE_KEYS.AUTH_SESSION);
  }

  // --- Users ---

  getUsers() {
    try {
      const data = localStorage.getItem(STORAGE_KEYS.USERS);
      return data ? JSON.parse(data) : [];
    } catch (e) {
      return [];
    }
  }

  saveUsers(users) {
    localStorage.setItem(STORAGE_KEYS.USERS, JSON.stringify(users));
  }

  // --- Onboarding ---

  getOnboardingCompleted() {
    return localStorage.getItem(STORAGE_KEYS.ONBOARDING_DONE) === 'true';
  }

  setOnboardingCompleted(done) {
    localStorage.setItem(STORAGE_KEYS.ONBOARDING_DONE, done ? 'true' : 'false');
  }

  // --- Chat History ---

  getChatHistory() {
    try {
      const data = localStorage.getItem(STORAGE_KEYS.CHAT_HISTORY);
      return data ? JSON.parse(data) : [];
    } catch (e) {
      return [];
    }
  }

  saveChatHistory(history) {
    // Keep last 50 messages to avoid localStorage bloat
    const trimmed = history.slice(-50);
    localStorage.setItem(STORAGE_KEYS.CHAT_HISTORY, JSON.stringify(trimmed));
  }
}

export const storage = new StorageService();
