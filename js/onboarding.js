/**
 * AifyCycle - Onboarding Wizard
 * Multi-step guided wizard to collect cycle data before entering the main app.
 */

import { storage } from './storage.js';
import { formatDateKey } from './cycle-engine.js';
import { escapeHtml } from './dom-utils.js';

const ONBOARDING_STEPS = [
  {
    id: 'welcome',
    title: 'Welcome to Aify Cycle',
    subtitle: 'Your intelligent period & wellness companion',
    skippable: false
  },
  {
    id: 'cycle-basics',
    title: 'Your Cycle Basics',
    subtitle: 'Help us understand your body\'s rhythm',
    skippable: false
  },
  {
    id: 'last-period',
    title: 'Last Period',
    subtitle: 'When did your most recent period start?',
    skippable: false
  },
  {
    id: 'symptoms',
    title: 'Symptoms to Track',
    subtitle: 'Select what matters most to you',
    skippable: true
  },
  {
    id: 'ai-coach',
    title: 'Meet Your AI Coach',
    subtitle: 'Powered by Google Gemini',
    skippable: true
  },
  {
    id: 'complete',
    title: 'You\'re All Set! 🎉',
    subtitle: 'Your personalized tracker is ready',
    skippable: false
  }
];

export class OnboardingWizard {
  constructor(onComplete) {
    this.currentStep = 0;
    this.totalSteps = ONBOARDING_STEPS.length;
    this.onComplete = onComplete;
    this._renderTimer = null;
    this._hasRenderedOnce = false;

    // Collected data
    this.data = {
      userName: '',
      cycleLength: 28,
      periodLength: 5,
      lastPeriodStart: formatDateKey(new Date()),
      trackedSymptoms: [],
      aiCoachEnabled: true
    };
  }

  /**
   * Initialize the wizard and render step 0
   */
  init() {
    this.renderStep();
    this.attachNavListeners();
  }

  /**
   * Get current step info
   */
  getCurrentStep() {
    return ONBOARDING_STEPS[this.currentStep];
  }

  /**
   * Render the current step content
   */
  renderStep() {
    const step = this.getCurrentStep();
    const container = document.getElementById('onboarding-step-content');
    const screen = document.getElementById('view-onboarding');
    const progressBar = document.getElementById('onboarding-progress-fill');
    const stepLabel = document.getElementById('onboarding-step-label');
    const prevBtn = document.getElementById('onboarding-prev');
    const nextBtn = document.getElementById('onboarding-next');
    const skipBtn = document.getElementById('onboarding-skip');

    if (!container) return;

    if (this._renderTimer) {
      clearTimeout(this._renderTimer);
      this._renderTimer = null;
    }

    if (screen) {
      screen.scrollTop = 0;
    }

    // Progress
    const progress = ((this.currentStep) / (this.totalSteps - 1)) * 100;
    if (progressBar) progressBar.style.width = `${progress}%`;
    if (stepLabel) stepLabel.textContent = `Step ${this.currentStep + 1} of ${this.totalSteps}`;

    // Navigation buttons
    if (prevBtn) prevBtn.style.display = this.currentStep > 0 ? 'flex' : 'none';
    if (skipBtn) skipBtn.style.display = step.skippable ? 'flex' : 'none';

    if (nextBtn) {
      if (this.currentStep === this.totalSteps - 1) {
        nextBtn.innerHTML = '<span>Start tracking</span>';
      } else {
        nextBtn.innerHTML = '<span>Continue</span>';
      }
    }

    const applyStepContent = () => {
      container.innerHTML = this._getStepHTML(step.id);
      this._attachStepListeners(step.id);
      container.style.transform = '';
      container.style.transition = 'opacity 0.2s ease';
      requestAnimationFrame(() => {
        container.style.opacity = '1';
      });
    };

    if (!this._hasRenderedOnce) {
      this._hasRenderedOnce = true;
      container.style.transition = '';
      container.style.transform = '';
      container.style.opacity = '1';
      container.innerHTML = this._getStepHTML(step.id);
      this._attachStepListeners(step.id);
      return;
    }

    // Opacity-only transition (avoids lingering GPU transform layers on mobile)
    container.style.transition = 'opacity 0.12s ease';
    container.style.opacity = '0';

    this._renderTimer = setTimeout(() => {
      this._renderTimer = null;
      applyStepContent();
    }, 120);
  }

  /**
   * Navigate to next step
   */
  next() {
    this._collectStepData();

    if (this.currentStep < this.totalSteps - 1) {
      this.currentStep++;
      this.renderStep();
    } else {
      this._finishOnboarding();
    }
  }

  /**
   * Navigate to previous step
   */
  prev() {
    if (this.currentStep > 0) {
      this.currentStep--;
      this.renderStep();
    }
  }

  /**
   * Skip current step
   */
  skip() {
    if (this.currentStep < this.totalSteps - 1) {
      this.currentStep++;
      this.renderStep();
    }
  }

  /**
   * Attach navigation button listeners
   */
  attachNavListeners() {
    const prevBtn = document.getElementById('onboarding-prev');
    const nextBtn = document.getElementById('onboarding-next');
    const skipBtn = document.getElementById('onboarding-skip');

    if (prevBtn) prevBtn.onclick = () => this.prev();
    if (nextBtn) nextBtn.onclick = () => this.next();
    if (skipBtn) skipBtn.onclick = () => this.skip();
  }

  // --- Private Methods ---

  _getStepHTML(stepId) {
    switch (stepId) {
      case 'welcome':
        return `
          <div class="onboarding-welcome">
            <h2 class="onboarding-hero-title">Welcome to AifyCycle</h2>
            <p class="onboarding-hero-subtitle">
              A private companion for cycle forecasting, biological phase tracking, and adaptive wellness guidance.
            </p>
            <div class="onboarding-features-grid">
              <div class="onboarding-feature-card">
                <span class="feature-text">Adaptive cycle forecasting</span>
              </div>
              <div class="onboarding-feature-card">
                <span class="feature-text">Private AI wellness guide</span>
              </div>
              <div class="onboarding-feature-card">
                <span class="feature-text">Phase syncing nutrition</span>
              </div>
              <div class="onboarding-feature-card">
                <span class="feature-text">Local-first privacy</span>
              </div>
            </div>
            <div class="onboarding-name-field">
              <label for="onboarding-name" class="form-label">What should we call you?</label>
              <input type="text" id="onboarding-name" class="form-input" placeholder="Enter your name" value="${escapeHtml(this.data.userName)}" autocomplete="given-name" />
            </div>
          </div>
        `;

      case 'cycle-basics':
        return `
          <div class="onboarding-cycle-basics">
            <h2 class="onboarding-step-heading">Tell us about your cycle</h2>
            <p class="onboarding-help-text">You can refine these estimates anytime in settings, and AifyCycle adapts automatically as you log.</p>

            <div class="onboarding-slider-group">
              <label for="ob-cycle-length" class="form-label">Average cycle length</label>
              <div class="onboarding-slider-row">
                <input type="range" id="ob-cycle-length" class="range-slider" min="20" max="45" step="1" value="${this.data.cycleLength}" />
                <span id="ob-cycle-length-val" class="range-value-lg">${this.data.cycleLength} days</span>
              </div>
              <p class="onboarding-slider-hint">Most cycles range between 24 and 35 days, with 28 days as the median.</p>
            </div>

            <div class="onboarding-slider-group">
              <label for="ob-period-length" class="form-label">Average period duration</label>
              <div class="onboarding-slider-row">
                <input type="range" id="ob-period-length" class="range-slider" min="2" max="10" step="1" value="${this.data.periodLength}" />
                <span id="ob-period-length-val" class="range-value-lg">${this.data.periodLength} days</span>
              </div>
              <p class="onboarding-slider-hint">Typical menstrual flow lasts 3 to 7 days.</p>
            </div>
          </div>
        `;

      case 'last-period':
        return `
          <div class="onboarding-last-period">
            <h2 class="onboarding-step-heading">When did your last period start?</h2>
            <p class="onboarding-help-text">This anchor date calibrates your current cycle day, phase window, and upcoming forecasts.</p>

            <div class="onboarding-date-picker-wrap">
              <input type="date" id="ob-last-period" class="form-input form-input-lg" value="${this.data.lastPeriodStart}" />
            </div>

            <div class="onboarding-info-box">
              <p>If you are not certain of the exact date, pick your closest estimate. Predictions calibrate automatically as you log future cycles.</p>
            </div>
          </div>
        `;

      case 'symptoms': {
        const symptoms = [
          { value: 'Cramps', label: 'Cramps' },
          { value: 'Headache', label: 'Headaches' },
          { value: 'Bloating', label: 'Bloating' },
          { value: 'Tender Breasts', label: 'Breast tenderness' },
          { value: 'Acne', label: 'Acne' },
          { value: 'Fatigue', label: 'Fatigue' },
          { value: 'Mood Swings', label: 'Mood shifts' },
          { value: 'Back Pain', label: 'Lower back pain' },
          { value: 'Cravings', label: 'Food cravings' },
          { value: 'Insomnia', label: 'Sleep disruption' },
          { value: 'Anxiety', label: 'Anxiety' },
          { value: 'Nausea', label: 'Nausea' }
        ];

        const chipsHtml = symptoms.map(s => {
          const isActive = this.data.trackedSymptoms.includes(s.value);
          return `<button type="button" class="ob-symptom-chip ${isActive ? 'active' : ''}" data-value="${s.value}">${s.label}</button>`;
        }).join('');

        return `
          <div class="onboarding-symptoms">
            <h2 class="onboarding-step-heading">What do you want to track?</h2>
            <p class="onboarding-help-text">Select the symptoms you commonly notice. Tap to toggle each item.</p>

            <div class="onboarding-symptom-grid">
              ${chipsHtml}
            </div>
          </div>
        `;
      }

      case 'ai-coach':
        return `
          <div class="onboarding-ai-coach">
            <h2 class="onboarding-step-heading">Meet your private wellness guide</h2>
            <p class="onboarding-help-text">
              Powered by Google Gemini with full offline fallback, your guide answers cycle questions and drafts log updates only with your confirmation.
            </p>

            <div class="onboarding-ai-features">
              <div class="ai-feature-row">
                <span class="ai-check-icon" aria-hidden="true">&#10003;</span>
                <div>
                  <strong>Cycle and phase education</strong>
                  <p>Clear explanations of hormonal transitions, fertility windows, and normal cycle variation.</p>
                </div>
              </div>
              <div class="ai-feature-row">
                <span class="ai-check-icon" aria-hidden="true">&#10003;</span>
                <div>
                  <strong>Nutrition and movement guidance</strong>
                  <p>Practical food and activity suggestions matched to your current phase and symptoms.</p>
                </div>
              </div>
              <div class="ai-feature-row">
                <span class="ai-check-icon" aria-hidden="true">&#10003;</span>
                <div>
                  <strong>User-confirmed record updates</strong>
                  <p>No health log is ever written silently. You review and approve every proposed update.</p>
                </div>
              </div>
            </div>

            <div class="onboarding-info-box" style="margin-top: 1.5rem;">
              <p>Conversations stay local in your browser sandbox unless you sign in to enable encrypted cloud sync.</p>
            </div>
          </div>
        `;

      case 'complete':
        return `
          <div class="onboarding-complete">
            <h2 class="onboarding-hero-title">Your tracker is ready</h2>
            <p class="onboarding-hero-subtitle">
              Review your initial cycle calibration below before opening your live dashboard.
            </p>

            <div class="onboarding-summary-card">
              <h4>Initial profile summary</h4>
              <div class="summary-row">
                <span>Name</span>
                <strong>${escapeHtml(this.data.userName || 'Guest')}</strong>
              </div>
              <div class="summary-row">
                <span>Cycle length</span>
                <strong>${this.data.cycleLength} days</strong>
              </div>
              <div class="summary-row">
                <span>Period duration</span>
                <strong>${this.data.periodLength} days</strong>
              </div>
              <div class="summary-row">
                <span>Last period start</span>
                <strong>${this.data.lastPeriodStart}</strong>
              </div>
              <div class="summary-row">
                <span>Tracked symptoms</span>
                <strong>${this.data.trackedSymptoms.length > 0 ? escapeHtml(this.data.trackedSymptoms.join(', ')) : 'All symptoms'}</strong>
              </div>
            </div>
          </div>
        `;

      default:
        return '<p>Unknown step</p>';
    }
  }

  _attachStepListeners(stepId) {
    if (stepId === 'cycle-basics') {
      const cycleSlider = document.getElementById('ob-cycle-length');
      const cycleVal = document.getElementById('ob-cycle-length-val');
      const periodSlider = document.getElementById('ob-period-length');
      const periodVal = document.getElementById('ob-period-length-val');

      if (cycleSlider && cycleVal) {
        cycleSlider.addEventListener('input', (e) => {
          cycleVal.textContent = `${e.target.value} days`;
        });
      }
      if (periodSlider && periodVal) {
        periodSlider.addEventListener('input', (e) => {
          periodVal.textContent = `${e.target.value} days`;
        });
      }
    }

    if (stepId === 'symptoms') {
      document.querySelectorAll('.ob-symptom-chip').forEach(chip => {
        chip.addEventListener('click', () => {
          chip.classList.toggle('active');
        });
      });
    }
  }

  _collectStepData() {
    const stepId = this.getCurrentStep().id;

    switch (stepId) {
      case 'welcome': {
        const nameInput = document.getElementById('onboarding-name');
        if (nameInput) this.data.userName = nameInput.value.trim();
        break;
      }
      case 'cycle-basics': {
        const cycleSlider = document.getElementById('ob-cycle-length');
        const periodSlider = document.getElementById('ob-period-length');
        if (cycleSlider) this.data.cycleLength = parseInt(cycleSlider.value, 10);
        if (periodSlider) this.data.periodLength = parseInt(periodSlider.value, 10);
        break;
      }
      case 'last-period': {
        const dateInput = document.getElementById('ob-last-period');
        if (dateInput && dateInput.value) this.data.lastPeriodStart = dateInput.value;
        break;
      }
      case 'symptoms': {
        const activeChips = document.querySelectorAll('.ob-symptom-chip.active');
        this.data.trackedSymptoms = Array.from(activeChips).map(c => c.getAttribute('data-value'));
        break;
      }
    }
  }

  _finishOnboarding() {
    // Save everything to profile
    const profile = storage.getProfile();
    profile.userName = this.data.userName || profile.userName || 'User';
    profile.cycleLength = this.data.cycleLength;
    profile.periodLength = this.data.periodLength;
    profile.lastPeriodStart = this.data.lastPeriodStart;
    profile.trackedSymptoms = this.data.trackedSymptoms;
    profile.aiCoachEnabled = this.data.aiCoachEnabled;

    storage.saveProfile(profile);
    storage.setOnboardingCompleted(true);

    if (this.onComplete) {
      this.onComplete(this.data);
    }
  }
}
