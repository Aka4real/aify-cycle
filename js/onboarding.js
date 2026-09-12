/**
 * AifyCycle - Onboarding Wizard
 * Multi-step guided wizard to collect cycle data before entering the main app.
 */

import { storage } from './storage.js';
import { formatDateKey } from './cycle-engine.js';

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
   * Initialize the wizard — render step 0
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
    const progressBar = document.getElementById('onboarding-progress-fill');
    const stepLabel = document.getElementById('onboarding-step-label');
    const prevBtn = document.getElementById('onboarding-prev');
    const nextBtn = document.getElementById('onboarding-next');
    const skipBtn = document.getElementById('onboarding-skip');

    if (!container) return;

    // Progress
    const progress = ((this.currentStep) / (this.totalSteps - 1)) * 100;
    if (progressBar) progressBar.style.width = `${progress}%`;
    if (stepLabel) stepLabel.textContent = `Step ${this.currentStep + 1} of ${this.totalSteps}`;

    // Navigation buttons
    if (prevBtn) prevBtn.style.display = this.currentStep > 0 ? 'flex' : 'none';
    if (skipBtn) skipBtn.style.display = step.skippable ? 'flex' : 'none';

    if (nextBtn) {
      if (this.currentStep === this.totalSteps - 1) {
        nextBtn.innerHTML = '<span>Start Tracking</span><span>🚀</span>';
      } else {
        nextBtn.innerHTML = '<span>Continue</span><span>→</span>';
      }
    }

    // Animate transition
    container.style.opacity = '0';
    container.style.transform = 'translateX(30px)';

    setTimeout(() => {
      container.innerHTML = this._getStepHTML(step.id);
      this._attachStepListeners(step.id);

      requestAnimationFrame(() => {
        container.style.transition = 'all 0.4s cubic-bezier(0.16, 1, 0.3, 1)';
        container.style.opacity = '1';
        container.style.transform = 'translateX(0)';
      });
    }, 200);
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

    if (prevBtn) prevBtn.addEventListener('click', () => this.prev());
    if (nextBtn) nextBtn.addEventListener('click', () => this.next());
    if (skipBtn) skipBtn.addEventListener('click', () => this.skip());
  }

  // --- Private Methods ---

  _getStepHTML(stepId) {
    switch (stepId) {
      case 'welcome':
        return `
          <div class="onboarding-welcome">
            <div class="onboarding-hero-icon">🌸</div>
            <h2 class="onboarding-hero-title">Welcome to Aify Cycle</h2>
            <p class="onboarding-hero-subtitle">
              Your intelligent, beautiful companion for period tracking, cycle syncing, and holistic wellness — powered by AI.
            </p>
            <div class="onboarding-features-grid">
              <div class="onboarding-feature-card">
                <span class="feature-icon">🔄</span>
                <span class="feature-text">Smart Cycle Predictions</span>
              </div>
              <div class="onboarding-feature-card">
                <span class="feature-icon">🤖</span>
                <span class="feature-text">AI Health Coach</span>
              </div>
              <div class="onboarding-feature-card">
                <span class="feature-icon">🥗</span>
                <span class="feature-text">Cycle Syncing Guide</span>
              </div>
              <div class="onboarding-feature-card">
                <span class="feature-icon">📊</span>
                <span class="feature-text">Health Insights</span>
              </div>
            </div>
            <div class="onboarding-name-field">
              <label for="onboarding-name" class="form-label">What should we call you?</label>
              <input type="text" id="onboarding-name" class="form-input" placeholder="Enter your name" value="${this.data.userName}" autocomplete="given-name" />
            </div>
          </div>
        `;

      case 'cycle-basics':
        return `
          <div class="onboarding-cycle-basics">
            <div class="onboarding-section-icon">📅</div>
            <h3>Tell us about your cycle</h3>
            <p class="onboarding-help-text">Don't worry — you can always adjust these later in settings.</p>

            <div class="onboarding-slider-group">
              <label class="form-label">Average Cycle Length</label>
              <div class="onboarding-slider-row">
                <input type="range" id="ob-cycle-length" class="range-slider" min="20" max="45" step="1" value="${this.data.cycleLength}" />
                <span id="ob-cycle-length-val" class="range-value-lg">${this.data.cycleLength} days</span>
              </div>
              <p class="onboarding-slider-hint">Most cycles are 24–35 days. The average is 28 days.</p>
            </div>

            <div class="onboarding-slider-group">
              <label class="form-label">Average Period Duration</label>
              <div class="onboarding-slider-row">
                <input type="range" id="ob-period-length" class="range-slider" min="2" max="10" step="1" value="${this.data.periodLength}" />
                <span id="ob-period-length-val" class="range-value-lg">${this.data.periodLength} days</span>
              </div>
              <p class="onboarding-slider-hint">Typical periods last 3–7 days.</p>
            </div>
          </div>
        `;

      case 'last-period':
        return `
          <div class="onboarding-last-period">
            <div class="onboarding-section-icon">🩸</div>
            <h3>When did your last period start?</h3>
            <p class="onboarding-help-text">This helps us predict your upcoming cycles accurately.</p>

            <div class="onboarding-date-picker-wrap">
              <input type="date" id="ob-last-period" class="form-input form-input-lg" value="${this.data.lastPeriodStart}" />
            </div>

            <div class="onboarding-info-box">
              <span>💡</span>
              <p>If you're not sure, pick your best estimate. The app learns and improves over time.</p>
            </div>
          </div>
        `;

      case 'symptoms':
        const symptoms = [
          { value: 'Cramps', icon: '⚡', label: 'Cramps' },
          { value: 'Headache', icon: '💆', label: 'Headaches' },
          { value: 'Bloating', icon: '🎈', label: 'Bloating' },
          { value: 'Tender Breasts', icon: '🌸', label: 'Breast Tenderness' },
          { value: 'Acne', icon: '✨', label: 'Acne' },
          { value: 'Fatigue', icon: '😴', label: 'Fatigue' },
          { value: 'Mood Swings', icon: '🎭', label: 'Mood Swings' },
          { value: 'Back Pain', icon: '🦴', label: 'Back Pain' },
          { value: 'Cravings', icon: '🍫', label: 'Food Cravings' },
          { value: 'Insomnia', icon: '🌙', label: 'Sleep Issues' },
          { value: 'Anxiety', icon: '🌪️', label: 'Anxiety' },
          { value: 'Nausea', icon: '🍃', label: 'Nausea' }
        ];

        const chipsHtml = symptoms.map(s => {
          const isActive = this.data.trackedSymptoms.includes(s.value);
          return `<button type="button" class="ob-symptom-chip ${isActive ? 'active' : ''}" data-value="${s.value}">
            <span>${s.icon}</span> <span>${s.label}</span>
          </button>`;
        }).join('');

        return `
          <div class="onboarding-symptoms">
            <div class="onboarding-section-icon">📝</div>
            <h3>What do you want to track?</h3>
            <p class="onboarding-help-text">Select the symptoms you commonly experience. Tap to select/deselect.</p>

            <div class="onboarding-symptom-grid">
              ${chipsHtml}
            </div>
          </div>
        `;

      case 'ai-coach':
        return `
          <div class="onboarding-ai-coach">
            <div class="onboarding-ai-avatar">
              <span class="ai-avatar-glow">🤖</span>
            </div>
            <h3>Meet Your AI Health Coach</h3>
            <p class="onboarding-help-text">
              Powered by <strong>Google Gemini</strong>, your personal AI advisor is ready to help with:
            </p>

            <div class="onboarding-ai-features">
              <div class="ai-feature-row">
                <span class="ai-feature-icon">💬</span>
                <div>
                  <strong>Period & Cycle Q&A</strong>
                  <p>Ask anything about your cycle, phases, and symptoms</p>
                </div>
              </div>
              <div class="ai-feature-row">
                <span class="ai-feature-icon">🥗</span>
                <div>
                  <strong>Nutrition & Fitness Tips</strong>
                  <p>Phase-specific diet and workout recommendations</p>
                </div>
              </div>
              <div class="ai-feature-row">
                <span class="ai-feature-icon">💊</span>
                <div>
                  <strong>Symptom Guidance</strong>
                  <p>Understand your symptoms and when to seek help</p>
                </div>
              </div>
              <div class="ai-feature-row">
                <span class="ai-feature-icon">🧘</span>
                <div>
                  <strong>Wellness Support</strong>
                  <p>Emotional wellbeing and self-care advice</p>
                </div>
              </div>
            </div>

            <div class="onboarding-info-box" style="margin-top: 1.5rem;">
              <span>🔒</span>
              <p>Your conversations are private and stored only on your device.</p>
            </div>
          </div>
        `;

      case 'complete':
        return `
          <div class="onboarding-complete">
            <div class="onboarding-confetti-wrap">
              <div class="confetti-emoji">🎉</div>
            </div>
            <h2 class="onboarding-hero-title">You're All Set!</h2>
            <p class="onboarding-hero-subtitle">
              Your personalized Aify Cycle tracker is configured and ready to go.
            </p>

            <div class="onboarding-summary-card">
              <h4>Your Settings</h4>
              <div class="summary-row">
                <span>👤 Name</span>
                <strong>${this.data.userName || 'Guest'}</strong>
              </div>
              <div class="summary-row">
                <span>🔄 Cycle Length</span>
                <strong>${this.data.cycleLength} days</strong>
              </div>
              <div class="summary-row">
                <span>🩸 Period Duration</span>
                <strong>${this.data.periodLength} days</strong>
              </div>
              <div class="summary-row">
                <span>📅 Last Period</span>
                <strong>${this.data.lastPeriodStart}</strong>
              </div>
              <div class="summary-row">
                <span>📝 Tracking</span>
                <strong>${this.data.trackedSymptoms.length > 0 ? this.data.trackedSymptoms.join(', ') : 'All symptoms'}</strong>
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
