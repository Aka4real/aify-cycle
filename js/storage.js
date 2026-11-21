/**
 * AifyCycle - Storage & Persistence Engine
 * Local-first storage with clean Supabase Cloud synchronization,
 * UUID-stable upserts, account isolation, and explicit opt-in demo data.
 */

import { formatDateKey, addDays } from './cycle-engine.js';
import { supabaseService } from './supabase-client.js';

const STORAGE_KEYS = {
  PROFILE: 'aifycycle_profile_v1',
  LOGS: 'aifycycle_logs_v1',
  THEME: 'aifycycle_theme_v1',
  AUTH_SESSION: 'aifycycle_auth_session_v1',
  USERS: 'aifycycle_users_v1',
  ONBOARDING_DONE: 'aifycycle_onboarding_done_v1',
  CHAT_HISTORY: 'aifycycle_chat_history_v1',
  AGENT_MEMORY: 'aifycycle_agent_memory_v1',
  DEMO_MODE: 'aifycycle_demo_mode_v1',
  LAST_USER_ID: 'aifycycle_last_user_id_v1'
};

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(val) {
  return typeof val === 'string' && UUID_REGEX.test(val);
}

function generateUuid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.floor(Math.random() * 16);
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function createEmptyProfile() {
  return {
    userName: '',
    partnerName: '',
    cycleLength: 28,
    periodLength: 5,
    lastPeriodStart: formatDateKey(new Date()),
    reminderEnabled: true,
    notifications: {
      periodReminderDays: 2,
      fertileWindowAlert: true
    }
  };
}

/**
 * Build optional demo data (only loaded when the user explicitly clicks "Reset Demo Data")
 */
function createDefaultSeedData() {
  const today = new Date();
  const lastPeriodStart = addDays(today, -13);
  const previousCycleStart = addDays(lastPeriodStart, -28);

  const defaultProfile = {
    userName: 'Demo User',
    partnerName: 'Partner',
    cycleLength: 28,
    periodLength: 5,
    lastPeriodStart: formatDateKey(lastPeriodStart),
    reminderEnabled: true,
    notifications: {
      periodReminderDays: 2,
      fertileWindowAlert: true
    }
  };

  const defaultLogs = {};

  for (let i = 0; i < 5; i++) {
    const dayDate = addDays(previousCycleStart, i);
    const key = formatDateKey(dayDate);
    defaultLogs[key] = {
      flow: i === 0 ? 'light' : i < 3 ? 'heavy' : 'light',
      symptoms: i < 3 ? ['Cramps', 'Lower Back Pain', 'Fatigue'] : ['Fatigue'],
      moods: i < 2 ? ['Sensitive', 'Low Energy'] : ['Calm'],
      waterGlasses: 7,
      sleepHours: 8,
      notes: i === 1 ? 'Sample log: warm herbal tea and heating pad helped ease cramps.' : ''
    };
  }

  for (let i = 0; i < 5; i++) {
    const dayDate = addDays(lastPeriodStart, i);
    const key = formatDateKey(dayDate);
    defaultLogs[key] = {
      flow: i === 0 ? 'spotting' : i < 3 ? 'heavy' : 'medium',
      symptoms: i < 3 ? ['Cramps', 'Bloating'] : ['Tender Breasts'],
      moods: i < 2 ? ['Sensitive', 'Calm'] : ['Calm', 'Happy'],
      waterGlasses: 8,
      sleepHours: 8.5,
      notes: i === 0 ? 'Sample log: cycle started. Restorative evening stretch.' : ''
    };
  }

  const follicularDay = addDays(today, -4);
  defaultLogs[formatDateKey(follicularDay)] = {
    flow: null,
    symptoms: [],
    moods: ['High Energy', 'Happy'],
    waterGlasses: 9,
    sleepHours: 7.5,
    notes: 'Sample log: great morning run and steady focus.'
  };

  const todayKey = formatDateKey(today);
  defaultLogs[todayKey] = {
    flow: null,
    symptoms: [],
    moods: ['High Energy', 'Happy'],
    waterGlasses: 8,
    sleepHours: 8,
    notes: 'Sample log: feeling centered and energized.'
  };

  const defaultMemories = [
    {
      id: generateUuid(),
      category: 'remedy_preference',
      fact: 'Prefers warm chamomile tea and a heating pad for easing cramps.',
      source: 'Demo seed',
      confidence: 'high',
      createdAt: new Date(Date.now() - 7 * 86400000).toISOString()
    },
    {
      id: generateUuid(),
      category: 'cycle_pattern',
      fact: 'Energy and focus tend to peak around Day 12-14.',
      source: 'Demo seed',
      confidence: 'high',
      createdAt: new Date(Date.now() - 5 * 86400000).toISOString()
    }
  ];

  return { defaultProfile, defaultLogs, defaultMemories };
}

export class StorageService {
  constructor() {
    this.init();
  }

  init() {
    // Do not seed fake health records automatically into real users' browsers.
    // Clean up legacy auto-seeded "Agatha" demo data if the user never finished onboarding.
    try {
      if (!this.getOnboardingCompleted()) {
        const rawProfile = localStorage.getItem(STORAGE_KEYS.PROFILE);
        if (rawProfile) {
          const parsed = JSON.parse(rawProfile);
          if (parsed?.userName === 'Agatha' && parsed?.partnerName === 'Aify') {
            localStorage.removeItem(STORAGE_KEYS.PROFILE);
            localStorage.removeItem(STORAGE_KEYS.LOGS);
            localStorage.removeItem(STORAGE_KEYS.AGENT_MEMORY);
            localStorage.removeItem(STORAGE_KEYS.DEMO_MODE);
          }
        }
      }
    } catch (e) {}
  }

  isDemoMode() {
    return localStorage.getItem(STORAGE_KEYS.DEMO_MODE) === 'true';
  }

  clearDemoMode() {
    localStorage.removeItem(STORAGE_KEYS.DEMO_MODE);
  }

  /**
   * Isolate local cache when switching authenticated cloud accounts (or leaving demo mode)
   */
  prepareForUser(userId) {
    if (!userId) return;
    const lastUserId = localStorage.getItem(STORAGE_KEYS.LAST_USER_ID);
    const switchingUser = Boolean(lastUserId && lastUserId !== userId);

    if (switchingUser || this.isDemoMode()) {
      localStorage.removeItem(STORAGE_KEYS.PROFILE);
      localStorage.removeItem(STORAGE_KEYS.LOGS);
      localStorage.removeItem(STORAGE_KEYS.AGENT_MEMORY);
      localStorage.removeItem(STORAGE_KEYS.CHAT_HISTORY);
      localStorage.removeItem(STORAGE_KEYS.ONBOARDING_DONE);
      this.clearDemoMode();
    }

    localStorage.setItem(STORAGE_KEYS.LAST_USER_ID, userId);
  }

  getProfile() {
    try {
      const data = localStorage.getItem(STORAGE_KEYS.PROFILE);
      return data ? { ...createEmptyProfile(), ...JSON.parse(data) } : createEmptyProfile();
    } catch (e) {
      console.error('Error reading profile from storage', e);
      return createEmptyProfile();
    }
  }

  saveProfile(profile, { skipCloudSync = false } = {}) {
    this.clearDemoMode();
    localStorage.setItem(STORAGE_KEYS.PROFILE, JSON.stringify(profile));
    if (!skipCloudSync) {
      this._syncProfileToCloud(profile);
    }
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
    localStorage.setItem(STORAGE_KEYS.LOGS, JSON.stringify(logs || {}));
  }

  getLog(dateKey) {
    const logs = this.getAllLogs();
    return logs[dateKey] || null;
  }

  saveLog(dateKey, logData) {
    this.clearDemoMode();
    const logs = this.getAllLogs();
    logs[dateKey] = {
      ...(logs[dateKey] || {}),
      ...logData,
      updatedAt: new Date().toISOString()
    };
    this.saveAllLogs(logs);
    this._syncLogToCloud(dateKey, logs[dateKey]);
    return logs[dateKey];
  }

  deleteLog(dateKey) {
    const logs = this.getAllLogs();
    if (logs[dateKey]) {
      delete logs[dateKey];
      this.saveAllLogs(logs);
      this._deleteLogFromCloud(dateKey);
    }
  }

  getTheme() {
    return localStorage.getItem(STORAGE_KEYS.THEME) || 'light';
  }

  saveTheme(theme) {
    localStorage.setItem(STORAGE_KEYS.THEME, theme);
  }

  exportBackup() {
    const exportObject = {
      app: 'AifyCycle',
      version: '1.2.0',
      exportedAt: new Date().toISOString(),
      profile: this.getProfile(),
      logs: this.getAllLogs(),
      memories: this.getAgentMemories()
    };
    return JSON.stringify(exportObject, null, 2);
  }

  importBackup(jsonString) {
    try {
      const parsed = JSON.parse(jsonString);
      if (!parsed || typeof parsed !== 'object') {
        return { success: false, error: 'Invalid backup file format.' };
      }
      this.clearDemoMode();
      if (parsed.profile && typeof parsed.profile === 'object') {
        this.saveProfile(parsed.profile);
      }
      if (parsed.logs && typeof parsed.logs === 'object') {
        this.saveAllLogs(parsed.logs);
      }
      if (Array.isArray(parsed.memories)) {
        const normalized = parsed.memories.map(m => ({
          ...m,
          id: isUuid(m.id) ? m.id : generateUuid()
        }));
        this.saveAgentMemories(normalized);
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Explicitly load sample demo data (marked so it is never uploaded to cloud)
   */
  resetAllData() {
    const { defaultProfile, defaultLogs, defaultMemories } = createDefaultSeedData();
    localStorage.setItem(STORAGE_KEYS.DEMO_MODE, 'true');
    localStorage.setItem(STORAGE_KEYS.PROFILE, JSON.stringify(defaultProfile));
    this.saveAllLogs(defaultLogs);
    this.saveAgentMemories(defaultMemories);
  }

  /**
   * GDPR Article 17: Right to Erasure ("Right to Be Forgotten")
   * Purges cloud data (via authenticated RPC) first, then clears all local storage.
   */
  async purgeAllUserData() {
    let cloudError = null;
    const client = supabaseService.getClient();
    if (client) {
      try {
        const { data: { session } } = await client.auth.getSession();
        if (session?.user) {
          const { error } = await client.rpc('delete_user_data');
          if (error) {
            cloudError = error.message;
            console.warn('Cloud purge error:', error.message);
          }
          await client.auth.signOut().catch(() => {});
        }
      } catch (e) {
        cloudError = e.message;
        console.warn('Cloud purge notice:', e.message);
      }
    }

    Object.values(STORAGE_KEYS).forEach(key => localStorage.removeItem(key));
    localStorage.removeItem('aifycycle_telemetry_v1');
    localStorage.removeItem('aifycycle_audit_log_v1');
    localStorage.removeItem('aifycycle_consent_v1');

    return { success: !cloudError, error: cloudError };
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

  // --- Users (legacy local fallback cache only) ---

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
    const trimmed = (history || []).slice(-50).map(msg => ({
      ...msg,
      id: isUuid(msg.id) ? msg.id : generateUuid()
    }));
    localStorage.setItem(STORAGE_KEYS.CHAT_HISTORY, JSON.stringify(trimmed));
    if (trimmed.length > 0 && !this.isDemoMode()) {
      const lastMsg = trimmed[trimmed.length - 1];
      this._syncChatMessageToCloud(lastMsg);
    }
  }

  async _getActiveCloudUser() {
    const client = supabaseService.getClient();
    if (!client) return { client: null, user: null };
    try {
      const { data: { session } } = await client.auth.getSession();
      return { client, user: session?.user || null };
    } catch (e) {
      return { client, user: null };
    }
  }

  async _syncChatMessageToCloud(msg) {
    if (!msg) return;
    const { client, user } = await this._getActiveCloudUser();
    if (!client || !user) return;
    try {
      const msgId = isUuid(msg.id) ? msg.id : generateUuid();
      const { error } = await client.from('ai_chat_history').upsert({
        id: msgId,
        user_id: user.id,
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: msg.content || '',
        action_card: msg.actionCard || null,
        created_at: msg.timestamp || new Date().toISOString()
      }, { onConflict: 'id' });
      if (error) console.warn('[Supabase Sync] Chat message upsert failed:', error.message);
    } catch (e) {
      console.warn('[Supabase Sync] Chat message sync error:', e.message);
    }
  }

  // --- Agent Memory & Continuous Learning System ---

  getAgentMemories() {
    try {
      const data = localStorage.getItem(STORAGE_KEYS.AGENT_MEMORY);
      if (!data) return [];
      const parsed = JSON.parse(data);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      console.error('Error reading agent memories from storage', e);
      return [];
    }
  }

  saveAgentMemories(memories) {
    localStorage.setItem(STORAGE_KEYS.AGENT_MEMORY, JSON.stringify(memories || []));
  }

  addAgentMemory({ category = 'general', fact, source = 'Chat conversation', confidence = 'high' }) {
    if (!fact || !fact.trim()) return null;
    this.clearDemoMode();
    const cleanFact = fact.trim();
    const memories = this.getAgentMemories();

    const existingIndex = memories.findIndex(m =>
      m.fact.toLowerCase() === cleanFact.toLowerCase()
    );

    if (existingIndex >= 0) {
      if (!isUuid(memories[existingIndex].id)) {
        memories[existingIndex].id = generateUuid();
      }
      memories[existingIndex].fact = cleanFact;
      memories[existingIndex].category = category || memories[existingIndex].category;
      memories[existingIndex].confidence = confidence;
      memories[existingIndex].updatedAt = new Date().toISOString();
      this.saveAgentMemories(memories);
      this._syncMemoryToCloud(memories[existingIndex]);
      return memories[existingIndex];
    }

    const newMemory = {
      id: generateUuid(),
      category,
      fact: cleanFact,
      source,
      confidence,
      createdAt: new Date().toISOString()
    };

    memories.unshift(newMemory);
    this.saveAgentMemories(memories);
    this._syncMemoryToCloud(newMemory);
    return newMemory;
  }

  deleteAgentMemory(id) {
    const memories = this.getAgentMemories();
    const filtered = memories.filter(m => m.id !== id);
    this.saveAgentMemories(filtered);
    this._deleteMemoryFromCloud(id);
    return filtered;
  }

  clearAgentMemories() {
    this.saveAgentMemories([]);
  }

  // =========================================================================
  // SUPABASE HYBRID SYNC & CLOUD CONTINUITY ENGINE
  // =========================================================================

  /**
   * Reconcile local storage with Supabase cloud records (no echo writes)
   */
  async syncFromCloud() {
    const { client, user } = await this._getActiveCloudUser();
    if (!client) return { success: false, reason: 'unconfigured', hasCloudProfile: false };
    if (!user) return { success: false, reason: 'not_authenticated', hasCloudProfile: false };

    try {
      this.prepareForUser(user.id);

      // 1. Fetch Profile (maybeSingle avoids 406 error when new user has no row yet)
      const { data: profileRow, error: profileErr } = await client
        .from('profiles')
        .select('*')
        .eq('id', user.id)
        .maybeSingle();

      if (profileErr) {
        console.warn('[Supabase Sync] Profile fetch warning:', profileErr.message);
      }

      let hasCloudProfile = false;
      if (profileRow) {
        hasCloudProfile = Boolean(profileRow.last_period_start);
        const localProfile = this.getProfile();
        const mergedProfile = {
          ...localProfile,
          userName: profileRow.user_name || localProfile.userName,
          partnerName: profileRow.partner_name ?? localProfile.partnerName,
          cycleLength: profileRow.cycle_length || localProfile.cycleLength,
          periodLength: profileRow.period_length || localProfile.periodLength,
          lastPeriodStart: profileRow.last_period_start || localProfile.lastPeriodStart,
          reminderEnabled: profileRow.reminder_enabled !== false,
          notifications: profileRow.notifications || localProfile.notifications
        };
        // Write locally without echoing back to Supabase
        localStorage.setItem(STORAGE_KEYS.PROFILE, JSON.stringify(mergedProfile));
      }

      // 2. Fetch Daily Logs
      const { data: logRows, error: logErr } = await client
        .from('cycle_logs')
        .select('*')
        .eq('user_id', user.id);

      if (logErr) {
        console.warn('[Supabase Sync] Logs fetch warning:', logErr.message);
      } else if (logRows && logRows.length > 0) {
        const currentLogs = this.getAllLogs();
        logRows.forEach(row => {
          const key = row.date_key;
          const existing = currentLogs[key];
          const cloudUpdated = row.updated_at ? Date.parse(row.updated_at) : 0;
          const localUpdated = existing?.updatedAt ? Date.parse(existing.updatedAt) : 0;
          if (!existing || cloudUpdated >= localUpdated) {
            currentLogs[key] = {
              flow: row.flow,
              symptoms: row.symptoms || [],
              moods: row.moods || [],
              waterGlasses: row.water_glasses || 0,
              sleepHours: Number(row.sleep_hours || 0),
              notes: row.notes || '',
              updatedAt: row.updated_at
            };
          }
        });
        localStorage.setItem(STORAGE_KEYS.LOGS, JSON.stringify(currentLogs));
      }

      // 3. Fetch Learned AI Memories
      const { data: memRows, error: memErr } = await client
        .from('ai_memories')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });

      if (memErr) {
        console.warn('[Supabase Sync] Memories fetch warning:', memErr.message);
      } else if (memRows && memRows.length > 0) {
        const cloudMems = memRows.map(r => ({
          id: r.id,
          category: r.category,
          fact: r.fact,
          source: r.source,
          confidence: r.confidence,
          createdAt: r.created_at,
          updatedAt: r.updated_at
        }));
        this.saveAgentMemories(cloudMems);
      }

      // 4. Fetch recent AI Chat History (newest 50, ordered chronologically)
      const { data: chatRows, error: chatErr } = await client
        .from('ai_chat_history')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(50);

      if (chatErr) {
        console.warn('[Supabase Sync] Chat fetch warning:', chatErr.message);
      } else if (chatRows && chatRows.length > 0) {
        const cloudChats = chatRows.reverse().map(r => ({
          id: r.id,
          role: r.role,
          content: r.content,
          actionCard: r.action_card || null,
          timestamp: r.created_at
        }));
        localStorage.setItem(STORAGE_KEYS.CHAT_HISTORY, JSON.stringify(cloudChats));
      }

      const hasAnyCloudData = hasCloudProfile || (logRows?.length || 0) > 0;
      console.info('✨ AifyCycle: Supabase cloud data synchronized.');
      return {
        success: true,
        hasCloudProfile: hasAnyCloudData,
        counts: {
          logs: logRows?.length || 0,
          memories: memRows?.length || 0,
          chats: chatRows?.length || 0
        }
      };
    } catch (e) {
      console.warn('[Supabase Sync] Sync from cloud deferred:', e.message);
      return { success: false, error: e.message, hasCloudProfile: false };
    }
  }

  /**
   * Upload local profile, logs, memories, and chat history to Supabase Cloud
   */
  async uploadLocalToCloud() {
    if (this.isDemoMode()) {
      return { success: false, reason: 'demo_mode' };
    }

    const { client, user } = await this._getActiveCloudUser();
    if (!client) return { success: false, reason: 'unconfigured' };
    if (!user) return { success: false, reason: 'not_authenticated' };

    try {
      // 1. Upload profile
      const profileRes = await this._syncProfileToCloud(this.getProfile());
      if (profileRes?.error) {
        throw new Error(`Profile sync failed: ${profileRes.error}`);
      }

      // 2. Upload daily logs
      const logs = this.getAllLogs();
      const logEntries = Object.entries(logs).map(([dateKey, log]) => ({
        user_id: user.id,
        date_key: dateKey,
        flow: log.flow || null,
        symptoms: log.symptoms || [],
        moods: log.moods || [],
        water_glasses: log.waterGlasses || 0,
        sleep_hours: log.sleepHours || 0.0,
        notes: log.notes || null,
        updated_at: log.updatedAt || new Date().toISOString()
      }));

      if (logEntries.length > 0) {
        const { error } = await client
          .from('cycle_logs')
          .upsert(logEntries, { onConflict: 'user_id,date_key' });
        if (error) throw new Error(`Logs sync failed: ${error.message}`);
      }

      // 3. Upload agent memories with stable UUIDs (no duplicates)
      const memories = this.getAgentMemories();
      if (memories.length > 0) {
        let mutatedIds = false;
        const memEntries = memories.map(m => {
          const validId = isUuid(m.id) ? m.id : generateUuid();
          if (validId !== m.id) {
            m.id = validId;
            mutatedIds = true;
          }
          return {
            id: validId,
            user_id: user.id,
            category: m.category || 'general',
            fact: m.fact,
            source: m.source || 'Chat conversation',
            confidence: m.confidence || 'high',
            created_at: m.createdAt || new Date().toISOString(),
            updated_at: m.updatedAt || new Date().toISOString()
          };
        });
        if (mutatedIds) this.saveAgentMemories(memories);

        const { error } = await client
          .from('ai_memories')
          .upsert(memEntries, { onConflict: 'id' });
        if (error) throw new Error(`Memories sync failed: ${error.message}`);
      }

      // 4. Upload recent AI chat messages with stable UUIDs (no duplicates)
      const chats = this.getChatHistory();
      if (chats && chats.length > 0) {
        let mutatedChatIds = false;
        const recent = chats.slice(-30);
        const chatEntries = recent.map(c => {
          const validId = isUuid(c.id) ? c.id : generateUuid();
          if (validId !== c.id) {
            c.id = validId;
            mutatedChatIds = true;
          }
          return {
            id: validId,
            user_id: user.id,
            role: c.role === 'assistant' ? 'assistant' : 'user',
            content: c.content || '',
            action_card: c.actionCard || null,
            created_at: c.timestamp || new Date().toISOString()
          };
        });
        if (mutatedChatIds) {
          localStorage.setItem(STORAGE_KEYS.CHAT_HISTORY, JSON.stringify(chats));
        }

        const { error } = await client
          .from('ai_chat_history')
          .upsert(chatEntries, { onConflict: 'id' });
        if (error) throw new Error(`Chat sync failed: ${error.message}`);
      }

      return { success: true };
    } catch (e) {
      console.warn('[Supabase Sync] Upload to cloud error:', e.message);
      return { success: false, error: e.message };
    }
  }

  async _syncProfileToCloud(profile) {
    if (this.isDemoMode()) return null;
    const { client, user } = await this._getActiveCloudUser();
    if (!client || !user) return null;
    try {
      const cycleLen = Math.min(45, Math.max(21, Number(profile.cycleLength) || 28));
      const periodLen = Math.min(10, Math.max(2, Number(profile.periodLength) || 5));
      const { error } = await client.from('profiles').upsert({
        id: user.id,
        user_name: profile.userName || 'User',
        partner_name: profile.partnerName || '',
        cycle_length: cycleLen,
        period_length: periodLen,
        last_period_start: profile.lastPeriodStart || null,
        reminder_enabled: profile.reminderEnabled !== false,
        notifications: profile.notifications || {},
        updated_at: new Date().toISOString()
      });
      if (error) {
        console.warn('[Supabase Sync] Profile upsert failed:', error.message);
        return { error: error.message };
      }
      return { error: null };
    } catch (e) {
      console.warn('[Supabase Sync] Profile sync error:', e.message);
      return { error: e.message };
    }
  }

  async _syncLogToCloud(dateKey, logEntry) {
    if (this.isDemoMode()) return;
    const { client, user } = await this._getActiveCloudUser();
    if (!client || !user) return;
    try {
      const { error } = await client.from('cycle_logs').upsert({
        user_id: user.id,
        date_key: dateKey,
        flow: logEntry.flow || null,
        symptoms: logEntry.symptoms || [],
        moods: logEntry.moods || [],
        water_glasses: logEntry.waterGlasses || 0,
        sleep_hours: logEntry.sleepHours || 0.0,
        notes: logEntry.notes || null,
        updated_at: new Date().toISOString()
      }, { onConflict: 'user_id,date_key' });
      if (error) console.warn('[Supabase Sync] Log upsert failed:', error.message);
    } catch (e) {
      console.warn('[Supabase Sync] Log sync error:', e.message);
    }
  }

  async _deleteLogFromCloud(dateKey) {
    const { client, user } = await this._getActiveCloudUser();
    if (!client || !user) return;
    try {
      const { error } = await client.from('cycle_logs').delete().match({ user_id: user.id, date_key: dateKey });
      if (error) console.warn('[Supabase Sync] Log delete failed:', error.message);
    } catch (e) {
      console.warn('[Supabase Sync] Log delete error:', e.message);
    }
  }

  async _syncMemoryToCloud(memory) {
    if (this.isDemoMode()) return;
    const { client, user } = await this._getActiveCloudUser();
    if (!client || !user) return;
    try {
      const memId = isUuid(memory.id) ? memory.id : generateUuid();
      const { error } = await client.from('ai_memories').upsert({
        id: memId,
        user_id: user.id,
        category: memory.category || 'general',
        fact: memory.fact,
        source: memory.source || 'Chat conversation',
        confidence: memory.confidence || 'high',
        updated_at: new Date().toISOString()
      }, { onConflict: 'id' });
      if (error) console.warn('[Supabase Sync] Memory upsert failed:', error.message);
    } catch (e) {
      console.warn('[Supabase Sync] Memory sync error:', e.message);
    }
  }

  async _deleteMemoryFromCloud(id) {
    if (!isUuid(id)) return;
    const { client, user } = await this._getActiveCloudUser();
    if (!client || !user) return;
    try {
      const { error } = await client.from('ai_memories').delete().match({ user_id: user.id, id });
      if (error) console.warn('[Supabase Sync] Memory delete failed:', error.message);
    } catch (e) {
      console.warn('[Supabase Sync] Memory delete error:', e.message);
    }
  }
}

export const storage = new StorageService();
