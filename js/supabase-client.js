/**
 * AifyCycle - Supabase Client & Realtime Connectivity Adapter
 * Provides resilient, zero-crash connectivity to Supabase.
 * Gracefully falls back to local-first mode when unconfigured or offline.
 */

const SUPABASE_CDN_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
const CONFIG_ENDPOINT = '/api/supabase/config';

class SupabaseService {
  constructor() {
    this.client = null;
    this.isConfigured = false;
    this.isInitializing = false;
    this._initPromise = null;
    this._authListeners = [];
  }

  /**
   * Initialize Supabase client dynamically
   */
  async init() {
    if (this.client) return this.client;
    if (this._initPromise) return this._initPromise;

    this._initPromise = this._doInit();
    return this._initPromise;
  }

  async _doInit() {
    try {
      // 1. Check for configuration (server endpoint or local storage override)
      const config = await this._resolveConfig();
      if (!config || !config.url || !config.anonKey) {
        console.info('🌸 AifyCycle: Supabase not configured. Operating in high-speed Local-First Mode.');
        this.isConfigured = false;
        return null;
      }

      // 2. Load Supabase JS SDK dynamically via ESM
      const { createClient } = await import(/* webpackIgnore: true */ SUPABASE_CDN_URL);

      this.client = createClient(config.url, config.anonKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
          storage: window.localStorage
        },
        realtime: {
          params: {
            eventsPerSecond: 10
          }
        }
      });

      this.isConfigured = true;
      console.info('🚀 AifyCycle: Supabase cloud sync & realtime connected successfully.');

      // Setup auth state forwarding
      this.client.auth.onAuthStateChange((event, session) => {
        this._notifyAuthListeners(event, session);
      });

      return this.client;
    } catch (err) {
      console.warn('🌸 AifyCycle: Supabase initialization deferred or offline. Running locally.', err.message);
      this.isConfigured = false;
      return null;
    }
  }

  /**
   * Resolve Supabase URL & Anon Key
   */
  async _resolveConfig() {
    // 1. Check local storage override (allows user to connect their own project in Settings)
    try {
      const localCustom = localStorage.getItem('aifycycle_supabase_config_v1');
      if (localCustom) {
        const parsed = JSON.parse(localCustom);
        if (parsed.url && parsed.anonKey) return parsed;
      }
    } catch (e) {}

    // 2. Check window injected config
    if (window.AIFY_SUPABASE_CONFIG?.url && window.AIFY_SUPABASE_CONFIG?.anonKey) {
      return window.AIFY_SUPABASE_CONFIG;
    }

    // 3. Fetch from backend proxy
    try {
      const res = await fetch(CONFIG_ENDPOINT, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const data = await res.json();
        if (data.configured && data.url && data.anonKey) {
          return { url: data.url, anonKey: data.anonKey };
        }
      }
    } catch (e) {
      // Backend not running or static host
    }

    return null;
  }

  getClient() {
    return this.client;
  }

  hasConfig() {
    return this.isConfigured && Boolean(this.client);
  }

  /**
   * Subscribe to auth changes
   */
  onAuthStateChange(callback) {
    if (typeof callback === 'function') {
      this._authListeners.push(callback);
    }
  }

  _notifyAuthListeners(event, session) {
    this._authListeners.forEach(cb => {
      try { cb(event, session); } catch (e) { console.error('Auth listener error:', e); }
    });
  }

  /**
   * Save custom Supabase credentials from Settings modal
   */
  setCustomConfig(url, anonKey) {
    if (url && anonKey) {
      localStorage.setItem('aifycycle_supabase_config_v1', JSON.stringify({ url: url.trim(), anonKey: anonKey.trim() }));
      this.client = null;
      this._initPromise = null;
      return this.init();
    } else {
      localStorage.removeItem('aifycycle_supabase_config_v1');
      this.client = null;
      this.isConfigured = false;
      this._initPromise = null;
      return Promise.resolve(null);
    }
  }
}

export const supabaseService = new SupabaseService();
