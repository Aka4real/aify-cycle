/**
 * AifyCycle - Authentication Manager
 * Handles login, signup, guest mode, session persistence, and form validation.
 */

import { storage } from './storage.js';

export class AuthManager {
  constructor() {
    this.isAuthenticated = false;
    this.currentUser = null;
    this._loadSession();
  }

  _loadSession() {
    const session = storage.getAuthSession();
    if (session && session.isLoggedIn) {
      this.isAuthenticated = true;
      this.currentUser = session.user;
    }
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
   * Signup a new user
   */
  signup({ name, email, password, dateOfBirth }) {
    const errors = this._validateSignup({ name, email, password, dateOfBirth });
    if (errors.length > 0) {
      return { success: false, errors };
    }

    // Check if email already exists
    const existingUsers = storage.getUsers();
    if (existingUsers.find(u => u.email.toLowerCase() === email.toLowerCase())) {
      return { success: false, errors: ['An account with this email already exists.'] };
    }

    const user = {
      id: this._generateId(),
      name: name.trim(),
      email: email.trim().toLowerCase(),
      dateOfBirth,
      createdAt: new Date().toISOString()
    };

    // Save user
    existingUsers.push({ ...user, passwordHash: this._simpleHash(password) });
    storage.saveUsers(existingUsers);

    // Create session
    this._createSession(user);

    return { success: true, user };
  }

  /**
   * Login an existing user
   */
  login({ email, password }) {
    const errors = this._validateLogin({ email, password });
    if (errors.length > 0) {
      return { success: false, errors };
    }

    const users = storage.getUsers();
    const user = users.find(u => u.email === email.trim().toLowerCase());

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
   * Continue as guest
   */
  guestLogin() {
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
   * Logout the current user
   */
  logout() {
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
    // Simple hash for demo — NOT cryptographic
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
