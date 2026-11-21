/**
 * AifyCycle - Authentication Manager (Supabase Cloud PKCE OAuth + Private Guest Mode)
 * Handles real Google/Apple OAuth, email/password auth via Supabase Cloud,
 * cloud-to-local profile synchronization, and offline private guest mode.
 */

import { storage } from './storage.js';
import { supabaseService } from './supabase-client.js';

export class AuthManager {
  constructor() {
    this.isAuthenticated = false;
    this.currentUser = null;
    this._onAuthRedirectCallback = null;
    this._lastSyncedUserId = null;
    this._applyPromise = null;
    this._loadSession();
    this._initSupabaseAuthSync();
  }

  _loadSession() {
    const session = storage.getAuthSession();
    if (session && session.isLoggedIn && session.user) {
      this.isAuthenticated = true;
      this.currentUser = session.user;
    }
  }

  _mapSupabaseUser(sbUser) {
    const meta = sbUser.user_metadata || {};
    const appMeta = sbUser.app_metadata || {};
    const provider = sbUser.is_anonymous ? 'guest' : (appMeta.provider || 'email');
    return {
      id: sbUser.id,
      name: sbUser.is_anonymous
        ? 'Guest'
        : (meta.full_name || meta.name || sbUser.email?.split('@')[0] || 'User'),
      email: sbUser.email || (sbUser.is_anonymous ? 'guest@aifycycle.app' : ''),
      avatarUrl: meta.avatar_url || meta.picture || null,
      provider,
      isGuest: Boolean(sbUser.is_anonymous),
      createdAt: sbUser.created_at
    };
  }

  async _applySupabaseUser(sbUser, { notifyRoute = false } = {}) {
    if (!sbUser) return null;

    if (this._applyPromise && this._lastSyncedUserId === sbUser.id) {
      return this._applyPromise;
    }

    this._lastSyncedUserId = sbUser.id;
    const mapped = this._mapSupabaseUser(sbUser);
    this._createSession(mapped);

    this._applyPromise = (async () => {
      const syncRes = await storage.syncFromCloud().catch(() => ({ success: false, hasCloudProfile: false }));

      // Returning or migrated user already has cloud records: skip onboarding
      if (syncRes?.hasCloudProfile) {
        storage.setOnboardingCompleted(true);
      } else if (!mapped.isGuest) {
        // Brand-new account: prefill display name locally without pushing an incomplete row
        const profile = storage.getProfile();
        if ((!profile.userName || profile.userName === 'User') && mapped.name && mapped.name !== 'User') {
          profile.userName = mapped.name;
          storage.saveProfile(profile, { skipCloudSync: true });
        }
      }

      if (notifyRoute && typeof this._onAuthRedirectCallback === 'function') {
        this._onAuthRedirectCallback(this.currentUser);
      }

      return this.currentUser;
    })();

    try {
      return await this._applyPromise;
    } finally {
      this._applyPromise = null;
    }
  }

  _initSupabaseAuthSync() {
    supabaseService.onAuthStateChange(async (event, session) => {
      if ((event === 'SIGNED_IN' || event === 'INITIAL_SESSION') && session?.user) {
        const wasAuthenticated = this.isAuthenticated && this.currentUser?.id === session.user.id;
        await this._applySupabaseUser(session.user, {
          notifyRoute: !wasAuthenticated || event === 'SIGNED_IN'
        });
      } else if (event === 'USER_UPDATED' && session?.user) {
        this._createSession(this._mapSupabaseUser(session.user));
      } else if (event === 'SIGNED_OUT') {
        this.isAuthenticated = false;
        this.currentUser = null;
        this._lastSyncedUserId = null;
        storage.clearAuthSession();
      }
    });
  }

  setOnAuthRedirectCallback(callback) {
    this._onAuthRedirectCallback = callback;
  }

  /**
   * Inspect URL for OAuth callback (PKCE ?code=, implicit #access_token=, or ?error=)
   * and finalize the Supabase session cleanly before rendering the auth screen.
   */
  async handleOAuthCallback() {
    const searchParams = new URLSearchParams(window.location.search);
    const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));

    const oauthError = searchParams.get('error') || hashParams.get('error');
    const oauthErrorDesc = searchParams.get('error_description') || hashParams.get('error_description');

    if (oauthError || oauthErrorDesc) {
      window.history.replaceState({}, document.title, window.location.pathname);
      const rawMessage = (oauthErrorDesc || `Sign-in failed (${oauthError}).`).trim();
      const friendlyMessage = /unable to exchange external code/i.test(rawMessage)
        ? 'Google sign-in could not complete the token exchange in Supabase. Verify that your Google OAuth Client Secret in Supabase (Authentication → Providers → Google) matches your Web OAuth client in Google Cloud Console, then try again.'
        : rawMessage;
      return { user: null, error: friendlyMessage };
    }

    const hasCallbackParams =
      searchParams.has('code') ||
      hashParams.has('access_token') ||
      hashParams.has('refresh_token');

    const client = await supabaseService.init();
    if (!client) {
      if (hasCallbackParams) {
        window.history.replaceState({}, document.title, window.location.pathname);
        return { user: null, error: 'Supabase is not configured on this server, so sign-in could not complete.' };
      }
      return { user: this.currentUser, error: null };
    }

    try {
      const { data: { session }, error } = await client.auth.getSession();
      if (hasCallbackParams) {
        window.history.replaceState({}, document.title, window.location.pathname);
      }
      if (error) {
        return { user: null, error: error.message };
      }
      if (session?.user) {
        const user = await this._applySupabaseUser(session.user, { notifyRoute: false });
        return { user, error: null };
      }
      if (hasCallbackParams) {
        return {
          user: null,
          error: 'Sign-in callback could not establish a session (the link or code may have expired or been opened in a different browser). Please try signing in again.'
        };
      }
      // If local cached session belonged to a cloud user whose session expired, clear stale local flag
      if (this.currentUser && !this.currentUser.isGuest) {
        this.isAuthenticated = false;
        this.currentUser = null;
        storage.clearAuthSession();
      }
      return { user: this.currentUser, error: null };
    } catch (e) {
      if (hasCallbackParams) {
        window.history.replaceState({}, document.title, window.location.pathname);
      }
      return { user: null, error: e.message || 'Could not verify authentication session.' };
    }
  }

  /**
   * Check for an existing active session on page load
   */
  async checkSession() {
    const res = await this.handleOAuthCallback();
    return res.user;
  }

  isLoggedIn() {
    return this.isAuthenticated;
  }

  hasCompletedOnboarding() {
    return storage.getOnboardingCompleted();
  }

  /**
   * Signup a new user via Supabase Cloud
   */
  async signup({ name, email, password, dateOfBirth }) {
    const errors = this._validateSignup({ name, email, password, dateOfBirth });
    if (errors.length > 0) {
      return { success: false, errors };
    }

    const cleanEmail = email.trim().toLowerCase();
    const cleanName = name.trim();

    const client = await supabaseService.init();
    if (!client) {
      return {
        success: false,
        errors: ['Cloud accounts require Supabase to be configured. Use "Continue as Guest" for private local-only tracking.']
      };
    }

    try {
      const { data, error } = await client.auth.signUp({
        email: cleanEmail,
        password,
        options: {
          emailRedirectTo: window.location.origin + '/',
          data: {
            full_name: cleanName,
            name: cleanName,
            dateOfBirth: dateOfBirth || null
          }
        }
      });

      if (error) {
        return { success: false, errors: [error.message] };
      }

      // Existing email when email confirmation is enabled (Supabase returns empty identities)
      if (data?.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
        return {
          success: false,
          errors: ['An account with this email already exists. Try logging in or using Continue with Google.']
        };
      }

      // Supabase requires email confirmation before granting a session
      if (data?.user && !data?.session) {
        return {
          success: false,
          requiresEmailConfirmation: true,
          notice: `Account created! Check ${cleanEmail} (including Spam) for your confirmation link, then log in.`
        };
      }

      if (data?.user && data?.session) {
        const user = await this._applySupabaseUser(data.user, { notifyRoute: false });
        const profile = storage.getProfile();
        profile.userName = cleanName;
        storage.saveProfile(profile);
        return { success: true, user };
      }

      return { success: false, errors: ['Unable to complete sign up. Please try again.'] };
    } catch (err) {
      return { success: false, errors: [err.message || 'Network error while creating your account.'] };
    }
  }

  /**
   * Login an existing user via Supabase Cloud
   */
  async login({ email, password }) {
    const errors = this._validateLogin({ email, password });
    if (errors.length > 0) {
      return { success: false, errors };
    }

    const cleanEmail = email.trim().toLowerCase();

    const client = await supabaseService.init();
    if (!client) {
      return {
        success: false,
        errors: ['Cloud login requires Supabase to be configured. Use "Continue as Guest" for private local-only tracking.']
      };
    }

    try {
      const { data, error } = await client.auth.signInWithPassword({
        email: cleanEmail,
        password
      });

      if (error) {
        return { success: false, errors: [error.message] };
      }

      if (data?.user) {
        const user = await this._applySupabaseUser(data.user, { notifyRoute: false });
        return { success: true, user };
      }

      return { success: false, errors: ['Login failed. Please check your credentials and try again.'] };
    } catch (err) {
      return { success: false, errors: [err.message || 'Network error while logging in.'] };
    }
  }

  /**
   * Real OAuth Sign-In via Supabase Cloud (Google / Apple)
   */
  async signInWithOAuth(provider) {
    const validProviders = ['google', 'apple'];
    if (!validProviders.includes(provider)) {
      return { success: false, error: 'Unsupported sign-in provider.' };
    }

    const providerLabel = provider === 'google' ? 'Google' : 'Apple';
    const client = await supabaseService.init();

    if (!client) {
      return {
        success: false,
        error: `Cloud authentication is not configured yet. Set SUPABASE_URL and SUPABASE_ANON_KEY to enable ${providerLabel} sign-in, or continue as Guest.`
      };
    }

    try {
      const oauthOptions = {
        redirectTo: window.location.origin + '/'
      };
      if (provider === 'google') {
        oauthOptions.queryParams = { prompt: 'select_account' };
      }

      const { data, error } = await client.auth.signInWithOAuth({
        provider,
        options: oauthOptions
      });

      if (error) {
        return { success: false, error: error.message || `${providerLabel} sign-in failed.` };
      }

      if (data?.url) {
        return { success: true, redirecting: true };
      }

      return { success: false, error: `Could not start ${providerLabel} sign-in.` };
    } catch (err) {
      return { success: false, error: err.message || `${providerLabel} sign-in failed.` };
    }
  }

  /**
   * Continue as private Guest (uses Supabase Anonymous Auth if enabled, else local-only guest)
   */
  async guestLogin() {
    const client = await supabaseService.init();
    if (client) {
      const providers = await supabaseService.getAuthProviderStatus();
      if (providers.anonymous !== false) {
        try {
          const { data, error } = await client.auth.signInAnonymously();
          if (!error && data?.user) {
            const user = this._mapSupabaseUser(data.user);
            this._createSession(user);
            return { success: true, user };
          }
        } catch (e) {
          // Fall back to local private guest mode
        }
      }
    }

    const user = {
      id: 'guest-' + this._generateId(),
      name: 'Guest',
      email: 'guest@aifycycle.app',
      provider: 'guest',
      isGuest: true,
      createdAt: new Date().toISOString()
    };

    this._createSession(user);
    return { success: true, user };
  }

  /**
   * Logout current user
   */
  async logout() {
    const client = supabaseService.getClient();
    if (client) {
      try {
        await client.auth.signOut();
      } catch (e) {}
    }

    this.isAuthenticated = false;
    this.currentUser = null;
    this._lastSyncedUserId = null;
    storage.clearAuthSession();
  }

  completeOnboarding() {
    storage.setOnboardingCompleted(true);
  }

  // --- Private helpers ---

  _createSession(user) {
    this.isAuthenticated = true;
    this.currentUser = user;
    storage.saveAuthSession({
      isLoggedIn: true,
      user,
      loginAt: new Date().toISOString()
    });
  }

  _validateSignup({ name, email, password }) {
    const errors = [];
    if (!name || name.trim().length < 2) errors.push('Name must be at least 2 characters.');
    if (!email || !this._isValidEmail(email)) errors.push('Please enter a valid email address.');
    if (!password || password.length < 6) errors.push('Password must be at least 6 characters.');
    return errors;
  }

  _validateLogin({ email, password }) {
    const errors = [];
    if (!email || !this._isValidEmail(email)) errors.push('Please enter a valid email address.');
    if (!password || password.length < 1) errors.push('Please enter your password.');
    return errors;
  }

  _isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  _generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
}
