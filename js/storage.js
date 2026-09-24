/**
 * AifyCycle - Storage & Persistence Engine
 * Manages local storage, preloaded demo data, and import/export.
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
  AGENT_MEMORY: 'aifycycle_agent_memory_v1'
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

  // Seed default learned memories for the agent
  const defaultMemories = [
    {
      id: 'mem_seed_1',
      category: 'remedy_preference',
      fact: 'Prefers warm chamomile tea and a heating pad for easing cramps.',
      source: 'Initial onboarding profile',
      confidence: 'high',
      createdAt: new Date(Date.now() - 7 * 86400000).toISOString()
    },
    {
      id: 'mem_seed_2',
      category: 'cycle_pattern',
      fact: 'Energy and confidence peak around Day 12-14 with high motivation.',
      source: 'Cycle tracking pattern',
      confidence: 'high',
      createdAt: new Date(Date.now() - 5 * 86400000).toISOString()
    },
    {
      id: 'mem_seed_3',
      category: 'lifestyle_habit',
      fact: 'Enjoys morning gentle stretching or yoga during follicular phase.',
      source: 'Activity log history',
      confidence: 'medium',
      createdAt: new Date(Date.now() - 3 * 86400000).toISOString()
    }
  ];

  return { defaultProfile, defaultLogs, defaultMemories };
}

export class StorageService {
  constructor() {
    this.init();
  }

  init() {
    if (!localStorage.getItem(STORAGE_KEYS.PROFILE)) {
      const { defaultProfile, defaultLogs, defaultMemories } = createDefaultSeedData();
      this.saveProfile(defaultProfile);
      this.saveAllLogs(defaultLogs);
      this.saveAgentMemories(defaultMemories);
    }

    // Asynchronously connect Supabase if configured and reconcile with cloud
    supabaseService.init().then(() => {
      this.syncFromCloud();
    }).catch(() => {});
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
    this._syncProfileToCloud(profile);
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
      version: '1.1.0',
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
      if (parsed.profile) this.saveProfile(parsed.profile);
      if (parsed.logs) this.saveAllLogs(parsed.logs);
      if (parsed.memories) this.saveAgentMemories(parsed.memories);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  resetAllData() {
    localStorage.removeItem(STORAGE_KEYS.PROFILE);
    localStorage.removeItem(STORAGE_KEYS.LOGS);
    localStorage.removeItem(STORAGE_KEYS.AGENT_MEMORY);
    this.init();
  }

  /**
   * GDPR Article 17: Right to Erasure ("Right to Be Forgotten")
   * Completely purges all user data, profile, history, session, agent memories,
   * client keys, and telemetry from the browser storage.
   */
  async purgeAllUserData() {
    Object.values(STORAGE_KEYS).forEach(key => localStorage.removeItem(key));
    localStorage.removeItem('aifycycle_telemetry_v1');
    localStorage.removeItem('aifycycle_audit_log_v1');
    localStorage.removeItem('aifycycle_consent_v1');

    // Purge cloud data if Supabase connected
    const client = supabaseService.getClient();
    if (client) {
      try {
        await client.rpc('delete_user_data');
      } catch (e) {
        console.warn('Cloud purge notice:', e.message);
      }
    }
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

  // --- Agent Memory & Continuous Learning System ---

  getAgentMemories() {
    try {
      const data = localStorage.getItem(STORAGE_KEYS.AGENT_MEMORY);
      if (!data) {
        const { defaultMemories } = createDefaultSeedData();
        this.saveAgentMemories(defaultMemories);
        return defaultMemories;
      }
      return JSON.parse(data);
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
    const cleanFact = fact.trim();
    const memories = this.getAgentMemories();

    // Check for near-duplicate memory
    const existingIndex = memories.findIndex(m => 
      m.fact.toLowerCase() === cleanFact.toLowerCase() ||
      m.fact.toLowerCase().includes(cleanFact.toLowerCase()) ||
      cleanFact.toLowerCase().includes(m.fact.toLowerCase())
    );

    if (existingIndex >= 0) {
      // Update existing memory
      memories[existingIndex].fact = cleanFact;
      memories[existingIndex].category = category || memories[existingIndex].category;
      memories[existingIndex].confidence = confidence;
      memories[existingIndex].updatedAt = new Date().toISOString();
      this.saveAgentMemories(memories);
      return memories[existingIndex];
    }

    const newMemory = {
      id: `mem_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
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
   * Reconcile local storage with Supabase cloud records
   */
  async syncFromCloud() {
    const client = supabaseService.getClient();
    if (!client) return { success: false, reason: 'unconfigured' };

    try {
      const { data: { user } } = await client.auth.getUser();
      if (!user) return { success: false, reason: 'not_authenticated' };

      // 1. Fetch Profile
      const { data: profileRow } = await client.from('profiles').select('*').eq('id', user.id).single();
      if (profileRow) {
        const localProfile = this.getProfile();
        this.saveProfile({
          ...localProfile,
          userName: profileRow.user_name || localProfile.userName,
          partnerName: profileRow.partner_name || localProfile.partnerName,
          cycleLength: profileRow.cycle_length || localProfile.cycleLength,
          periodLength: profileRow.period_length || localProfile.periodLength,
          lastPeriodStart: profileRow.last_period_start || localProfile.lastPeriodStart,
          reminderEnabled: profileRow.reminder_enabled !== false,
          notifications: profileRow.notifications || localProfile.notifications
        });
      }

      // 2. Fetch Daily Logs
      const { data: logRows } = await client.from('cycle_logs').select('*').eq('user_id', user.id);
      if (logRows && logRows.length > 0) {
        const currentLogs = this.getAllLogs();
        logRows.forEach(row => {
          const key = row.date_key;
          currentLogs[key] = {
            flow: row.flow,
            symptoms: row.symptoms || [],
            moods: row.moods || [],
            waterGlasses: row.water_glasses || 0,
            sleepHours: Number(row.sleep_hours || 0),
            notes: row.notes || '',
            updatedAt: row.updated_at
          };
        });
        localStorage.setItem(STORAGE_KEYS.LOGS, JSON.stringify(currentLogs));
      }

      // 3. Fetch Learned AI Memories
      const { data: memRows } = await client.from('ai_memories').select('*').eq('user_id', user.id);
      if (memRows && memRows.length > 0) {
        const cloudMems = memRows.map(r => ({
          id: r.id,
          category: r.category,
          fact: r.fact,
          source: r.source,
          confidence: r.confidence,
          createdAt: r.created_at
        }));
        this.saveAgentMemories(cloudMems);
      }

      console.info('✨ AifyCycle: Supabase cloud data synchronized with local store.');
      return { success: true };
    } catch (e) {
      console.warn('[Supabase Sync] Sync from cloud deferred:', e.message);
      return { success: false, error: e.message };
    }
  }

  /**
   * Upload all local logs, profile, and memories to Supabase
   */
  async uploadLocalToCloud() {
    const client = supabaseService.getClient();
    if (!client) return { success: false };

    try {
      const { data: { user } } = await client.auth.getUser();
      if (!user) return { success: false };

      // Upload profile
      await this._syncProfileToCloud(this.getProfile());

      // Upload daily logs
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
        await client.from('cycle_logs').upsert(logEntries, { onConflict: 'user_id,date_key' });
      }

      // Upload agent memories
      const memories = this.getAgentMemories();
      const memEntries = memories.map(m => ({
        user_id: user.id,
        category: m.category || 'general',
        fact: m.fact,
        source: m.source || 'Chat conversation',
        confidence: m.confidence || 'high'
      }));

      if (memEntries.length > 0) {
        await client.from('ai_memories').upsert(memEntries);
      }

      return { success: true };
    } catch (e) {
      console.warn('[Supabase Sync] Upload to cloud error:', e.message);
      return { success: false, error: e.message };
    }
  }

  async _syncProfileToCloud(profile) {
    const client = supabaseService.getClient();
    if (!client) return;
    try {
      const { data: { user } } = await client.auth.getUser();
      if (!user) return;
      await client.from('profiles').upsert({
        id: user.id,
        user_name: profile.userName || 'User',
        partner_name: profile.partnerName || 'Partner',
        cycle_length: profile.cycleLength || 28,
        period_length: profile.periodLength || 5,
        last_period_start: profile.lastPeriodStart || new Date().toISOString().split('T')[0],
        reminder_enabled: profile.reminderEnabled !== false,
        notifications: profile.notifications || {},
        updated_at: new Date().toISOString()
      });
    } catch (e) {
      // Quiet background failure
    }
  }

  async _syncLogToCloud(dateKey, logEntry) {
    const client = supabaseService.getClient();
    if (!client) return;
    try {
      const { data: { user } } = await client.auth.getUser();
      if (!user) return;
      await client.from('cycle_logs').upsert({
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
    } catch (e) {
      // Quiet background failure
    }
  }

  async _deleteLogFromCloud(dateKey) {
    const client = supabaseService.getClient();
    if (!client) return;
    try {
      const { data: { user } } = await client.auth.getUser();
      if (!user) return;
      await client.from('cycle_logs').delete().match({ user_id: user.id, date_key: dateKey });
    } catch (e) {
      // Quiet background failure
    }
  }

  async _syncMemoryToCloud(memory) {
    const client = supabaseService.getClient();
    if (!client) return;
    try {
      const { data: { user } } = await client.auth.getUser();
      if (!user) return;
      await client.from('ai_memories').upsert({
        user_id: user.id,
        category: memory.category || 'general',
        fact: memory.fact,
        source: memory.source || 'Chat conversation',
        confidence: memory.confidence || 'high',
        updated_at: new Date().toISOString()
      });
    } catch (e) {
      // Quiet background failure
    }
  }

  async _deleteMemoryFromCloud(id) {
    const client = supabaseService.getClient();
    if (!client) return;
    try {
      const { data: { user } } = await client.auth.getUser();
      if (!user) return;
      await client.from('ai_memories').delete().match({ user_id: user.id, id });
    } catch (e) {
      // Quiet background failure
    }
  }
}

export const storage = new StorageService();
