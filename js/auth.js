/**
 * AifyCycle - Authentication Manager with Supabase & Offline-First Fallback
 * Handles Supabase cloud authentication, local session persistence, anonymous guest mode,
 * and seamless fallback when operating in standalone offline mode.
 */

import { storage } from './storage.js';
import { supabaseService } from './supabase-client.js';

export class AuthManager {
  constructor() {
    this.isAuthenticated = false;
    this.currentUser = null;
    this._loadSession();
    this._initSupabaseAuthSync();
  }

  _loadSession() {
    const session = storage.getAuthSession();
    if (session && session.isLoggedIn) {
      this.isAuthenticated = true;
      this.currentUser = session.user;
    }
  }

  _initSupabaseAuthSync() {
    supabaseService.onAuthStateChange(async (event, session) => {
      if (event === 'SIGNED_IN' && session?.user) {
        this.isAuthenticated = true;
        this.currentUser = {
          id: session.user.id,
          name: session.user.user_metadata?.name || session.user.email?.split('@')[0] || 'User',
          email: session.user.email,
          isGuest: session.user.is_anonymous || false,
          createdAt: session.user.created_at
        };
        this._createSession(this.currentUser);
        // Automatically sync cloud logs down to local cache
        await storage.syncFromCloud().catch(() => {});
      } else if (event === 'SIGNED_OUT') {
        this.isAuthenticated = false;
        this.currentUser = null;
        storage.clearAuthSession();
      }
    });
  }

  /**
   * Check if the user is logged in
   */
  isLoggedIn() {
    return this.isAuthenticated;
  }

  /**
   * Check if onboarding has been completed
   */
  hasCompletedOnboarding() {
    return storage.getOnboardingCompleted();
  }

  /**
   * Signup a new user (Supabase Cloud + Local Fallback)
   */
  async signup({ name, email, password, dateOfBirth }) {
    const errors = this._validateSignup({ name, email, password, dateOfBirth });
    if (errors.length > 0) {
      return { success: false, errors };
    }

    const cleanEmail = email.trim().toLowerCase();
    const cleanName = name.trim();

    // 1. Try Supabase Auth if connected
    const client = supabaseService.getClient();
    if (client) {
      try {
        const { data, error } = await client.auth.signUp({
          email: cleanEmail,
          password,
          options: {
            data: {
              name: cleanName,
              dateOfBirth
            }
          }
        });

        if (error) {
          return { success: false, errors: [error.message] };
        }

        if (data?.user) {
          const user = {
            id: data.user.id,
            name: cleanName,
            email: cleanEmail,
            dateOfBirth,
            createdAt: data.user.created_at || new Date().toISOString()
          };
          this._createSession(user);

          // Sync initial profile
          const profile = storage.getProfile();
          profile.userName = cleanName;
          storage.saveProfile(profile);

          // Upload any pre-existing local logs to their new account
          await storage.uploadLocalToCloud().catch(() => {});

          return { success: true, user };
        }
      } catch (err) {
        console.warn('[Supabase Auth] Signup fallback to local:', err.message);
      }
    }

    // 2. Standalone Local Fallback Mode
    const existingUsers = storage.getUsers();
    if (existingUsers.find(u => u.email.toLowerCase() === cleanEmail)) {
      return { success: false, errors: ['An account with this email already exists.'] };
    }

    const user = {
      id: this._generateId(),
      name: cleanName,
      email: cleanEmail,
      dateOfBirth,
      createdAt: new Date().toISOString()
    };

    existingUsers.push({ ...user, passwordHash: this._simpleHash(password) });
    storage.saveUsers(existingUsers);
    this._createSession(user);

    return { success: true, user };
  }

  /**
   * Login an existing user (Supabase Cloud + Local Fallback)
   */
  async login({ email, password }) {
    const errors = this._validateLogin({ email, password });
    if (errors.length > 0) {
      return { success: false, errors };
    }

    const cleanEmail = email.trim().toLowerCase();

    // 1. Try Supabase Auth if connected
    const client = supabaseService.getClient();
    if (client) {
      try {
        const { data, error } = await client.auth.signInWithPassword({
          email: cleanEmail,
          password
        });

        if (error) {
          return { success: false, errors: [error.message] };
        }

        if (data?.user) {
          const user = {
            id: data.user.id,
            name: data.user.user_metadata?.name || cleanEmail.split('@')[0],
            email: cleanEmail,
            createdAt: data.user.created_at
          };
          this._createSession(user);
          await storage.syncFromCloud().catch(() => {});
          return { success: true, user };
        }
      } catch (err) {
        console.warn('[Supabase Auth] Login fallback to local:', err.message);
      }
    }

    // 2. Standalone Local Fallback Mode
    const users = storage.getUsers();
    const user = users.find(u => u.email === cleanEmail);

    if (!user) {
      return { success: false, errors: ['No account found with this email.'] };
    }

    if (user.passwordHash !== this._simpleHash(password)) {
      return { success: false, errors: ['Incorrect password. Please try again.'] };
    }

    const { passwordHash, ...safeUser } = user;
    this._createSession(safeUser);

    return { success: true, user: safeUser };
  }

  /**
   * Continue as guest (Anonymous Guest session)
   */
  async guestLogin() {
    const client = supabaseService.getClient();
    if (client) {
      try {
        const { data, error } = await client.auth.signInAnonymously();
        if (!error && data?.user) {
          const user = {
            id: data.user.id,
            name: 'Guest',
            email: 'guest@aifycycle.app',
            isGuest: true,
            createdAt: data.user.created_at
          };
          this._createSession(user);
          return { success: true, user };
        }
      } catch (e) {
        // Fallback to local guest
      }
    }

    const user = {
      id: 'guest-' + this._generateId(),
      name: 'Guest',
      email: 'guest@aifycycle.app',
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
    storage.clearAuthSession();
  }

  /**
   * Mark onboarding as completed
   */
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

  _validateSignup({ name, email, password, dateOfBirth }) {
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

  _simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return 'hash_' + Math.abs(hash).toString(36);
  }

  _generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 6);
  }
}
