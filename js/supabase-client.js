/**
 * AifyCycle - Supabase Client & Realtime Connectivity Adapter
 * Connects to Supabase Cloud (PKCE OAuth + RLS sync) with graceful local-first fallback
 * when unconfigured or offline.
 */

const SUPABASE_CDN_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
const CONFIG_ENDPOINT = '/api/supabase/config';
const CUSTOM_CONFIG_KEY = 'aifycycle_supabase_config_v1';

class SupabaseService {
  constructor() {
    this.client = null;
    this.isConfigured = false;
    this.activeUrl = null;
    this.configSource = null;
    this._initPromise = null;
    this._authListeners = [];
    this._authSubscription = null;
    this._cachedSettings = null;
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
      const config = await this._resolveConfig();
      if (!config || !config.url || !config.anonKey) {
        console.info('🌸 AifyCycle: Supabase not configured. Operating in Local-First Mode.');
        this.isConfigured = false;
        this.activeUrl = null;
        this.configSource = null;
        return null;
      }

      const { createClient } = await import(/* webpackIgnore: true */ SUPABASE_CDN_URL);

      this.client = createClient(config.url, config.anonKey, {
        auth: {
          flowType: 'pkce',
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
      this.activeUrl = config.url;
      this.configSource = config.source;
      console.info(`🚀 AifyCycle: Supabase connected (${this.getConnectionInfo().host}, source: ${config.source}).`);

      if (this._authSubscription) {
        try { this._authSubscription.unsubscribe(); } catch (e) {}
      }
      const { data } = this.client.auth.onAuthStateChange((event, session) => {
        this._notifyAuthListeners(event, session);
      });
      this._authSubscription = data?.subscription || null;

      return this.client;
    } catch (err) {
      console.warn('🌸 AifyCycle: Supabase initialization deferred or offline. Running locally.', err.message);
      this.isConfigured = false;
      this._initPromise = null;
      return null;
    }
  }

  /**
   * Resolve Supabase URL & Anon Key
   */
  async _resolveConfig() {
    // 1. Check local storage override (Settings -> Custom Credentials)
    try {
      const localCustom = localStorage.getItem(CUSTOM_CONFIG_KEY);
      if (localCustom) {
        const parsed = JSON.parse(localCustom);
        if (parsed.url && parsed.anonKey) {
          return {
            url: parsed.url.trim().replace(/\/+$/, ''),
            anonKey: parsed.anonKey.trim(),
            source: 'custom'
          };
        }
      }
    } catch (e) {}

    // 2. Check window injected config
    if (window.AIFY_SUPABASE_CONFIG?.url && window.AIFY_SUPABASE_CONFIG?.anonKey) {
      return {
        url: window.AIFY_SUPABASE_CONFIG.url.trim().replace(/\/+$/, ''),
        anonKey: window.AIFY_SUPABASE_CONFIG.anonKey.trim(),
        source: 'window'
      };
    }

    // 3. Fetch from backend config endpoint (reads SUPABASE_URL + SUPABASE_ANON_KEY from env)
    try {
      const res = await fetch(CONFIG_ENDPOINT, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const data = await res.json();
        if (data.configured && data.url && data.anonKey) {
          return {
            url: data.url.trim().replace(/\/+$/, ''),
            anonKey: data.anonKey.trim(),
            source: 'server'
          };
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

  getConnectionInfo() {
    let host = null;
    if (this.activeUrl) {
      try {
        host = new URL(this.activeUrl).host;
      } catch (e) {
        host = this.activeUrl;
      }
    }
    return {
      configured: this.hasConfig(),
      url: this.activeUrl,
      host,
      source: this.configSource
    };
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
   * Fetch Supabase GoTrue Auth settings to check which providers are enabled
   */
  async getAuthSettings(forceRefresh = false) {
    if (this._cachedSettings && !forceRefresh) return this._cachedSettings;
    const config = await this._resolveConfig();
    if (!config?.url || !config?.anonKey) return null;

    try {
      const res = await fetch(`${config.url}/auth/v1/settings`, {
        headers: { apikey: config.anonKey },
        signal: AbortSignal.timeout(5000)
      });
      if (res.ok) {
        this._cachedSettings = await res.json();
        return this._cachedSettings;
      }
    } catch (e) {
      console.warn('[Supabase] Could not fetch auth settings:', e.message);
    }
    return null;
  }

  /**
   * Check if an external OAuth provider ('google', 'apple') is enabled in Supabase.
   * Returns true, false, or null if settings could not be queried.
   */
  async isProviderEnabled(provider) {
    const settings = await this.getAuthSettings();
    if (!settings || !settings.external) return null;
    return Boolean(settings.external[provider]);
  }

  /**
   * Return availability map for supported auth providers
   */
  async getAuthProviderStatus() {
    const settings = await this.getAuthSettings();
    if (!settings) {
      return { google: null, apple: null, anonymous: null };
    }
    return {
      google: Boolean(settings.external?.google),
      apple: Boolean(settings.external?.apple),
      anonymous: Boolean(settings.external?.anonymous_users)
    };
  }

  /**
   * Save or clear custom Supabase credentials from Settings modal
   */
  async setCustomConfig(url, anonKey) {
    this._cachedSettings = null;
    if (this._authSubscription) {
      try { this._authSubscription.unsubscribe(); } catch (e) {}
      this._authSubscription = null;
    }

    if (url && anonKey) {
      const cleanUrl = url.trim().replace(/\/+$/, '');
      localStorage.setItem(CUSTOM_CONFIG_KEY, JSON.stringify({ url: cleanUrl, anonKey: anonKey.trim() }));
      this.client = null;
      this.isConfigured = false;
      this.activeUrl = null;
      this.configSource = null;
      this._initPromise = null;
      return this.init();
    } else {
      localStorage.removeItem(CUSTOM_CONFIG_KEY);
      this.client = null;
      this.isConfigured = false;
      this.activeUrl = null;
      this.configSource = null;
      this._initPromise = null;
      // Re-initialize from server env if available
      return this.init();
    }
  }
}

export const supabaseService = new SupabaseService();
