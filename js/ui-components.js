/**
 * AifyCycle - UI Components & Renderers
 * Manages visual rendering of the Cycle Dial, Calendar, Syncing Guide,
 * Analytics, and Modals.
 */

import { CYCLE_SYNCING_GUIDE, getMonthCycleMap, formatDateKey, parseDateKey, addDays } from './cycle-engine.js';

export class UIComponents {
  constructor() {
    this.toastContainer = null;
  }

  /**
   * Initialize Toast Container
   */
  initToasts() {
    if (!document.getElementById('toast-container')) {
      const container = document.createElement('div');
      container.id = 'toast-container';
      container.className = 'toast-container';
      document.body.appendChild(container);
      this.toastContainer = container;
    } else {
      this.toastContainer = document.getElementById('toast-container');
    }
  }

  /**
   * Display a floating feedback toast
   */
  showToast(message, icon = '✨') {
    this.initToasts();
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = `<span>${icon}</span> <span>${message}</span>`;
    this.toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 3200);
  }

  /**
   * Render the Circular Cycle Visualizer / Dial
   */
  renderCycleDial(status, profile) {
    const dialProgress = document.getElementById('dial-progress');
    const dialDayNumber = document.getElementById('dial-day-number');
    const dialTotalDays = document.getElementById('dial-total-days');
    const dialPhaseTitle = document.getElementById('dial-phase-title');
    const dialFertilityBadge = document.getElementById('dial-fertility-badge');
    const statDaysNextPeriod = document.getElementById('stat-days-next-period');
    const statPeriodStartDate = document.getElementById('stat-period-start-date');
    const statOvulationDate = document.getElementById('stat-ovulation-date');

    // SVG Circle Calculations (r = 120, circumference = 2 * PI * 120 = ~753.98)
    const circumference = 753.98;
    const progressOffset = circumference - (circumference * (status.progressPercent / 100));

    if (dialProgress) {
      dialProgress.style.strokeDasharray = `${circumference}`;
      dialProgress.style.strokeDashoffset = `${progressOffset}`;
    }

    if (dialDayNumber) dialDayNumber.textContent = status.cycleDay;
    if (dialTotalDays) dialTotalDays.textContent = `/ ${status.cycleLength} days`;
    if (dialPhaseTitle) {
      dialPhaseTitle.innerHTML = `${status.phase.icon} ${status.phase.name}`;
      dialPhaseTitle.style.color = status.phase.color;
    }

    if (dialFertilityBadge) {
      dialFertilityBadge.className = `dial-fertility-badge ${status.fertilityBadgeClass}`;
      dialFertilityBadge.textContent = `Fertility: ${status.fertilityChance}`;
    }

    if (statDaysNextPeriod) {
      statDaysNextPeriod.textContent = `${status.daysUntilNextPeriod} days`;
    }

    if (statPeriodStartDate) {
      const nextDate = parseDateKey(status.nextPeriodStart);
      statPeriodStartDate.textContent = nextDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }

    if (statOvulationDate) {
      const ovDate = parseDateKey(status.nextOvulationDate);
      statOvulationDate.textContent = ovDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }

    // Update today's partner care note snippet in Hero
    const partnerNoteEl = document.getElementById('hero-partner-care-note');
    if (partnerNoteEl) {
      const guide = CYCLE_SYNCING_GUIDE[status.phase.key];
      partnerNoteEl.textContent = guide ? guide.partnerTip : 'Be gentle and supportive of your body’s rhythm today.';
    }

    // Update phase banner
    const phaseBannerDesc = document.getElementById('hero-phase-desc');
    if (phaseBannerDesc) {
      phaseBannerDesc.textContent = status.phase.description;
    }
  }

  /**
   * Render the Calendar View
   */
  renderCalendar(currentYear, currentMonth, profile, logs, onDayClick) {
    const calendarTitle = document.getElementById('calendar-month-year');
    const calendarGrid = document.getElementById('calendar-days-grid');
    if (!calendarGrid) return;

    // Month Title
    const monthDate = new Date(currentYear, currentMonth, 1);
    if (calendarTitle) {
      calendarTitle.textContent = monthDate.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    }

    calendarGrid.innerHTML = '';

    const days = getMonthCycleMap(currentYear, currentMonth, profile, logs);
    const firstDayIndex = new Date(currentYear, currentMonth, 1).getDay(); // 0 = Sun

    // Empty cells for leading offset
    for (let i = 0; i < firstDayIndex; i++) {
      const emptyCell = document.createElement('div');
      emptyCell.className = 'calendar-day-cell empty';
      calendarGrid.appendChild(emptyCell);
    }

    const todayStr = formatDateKey(new Date());

    // Populate day cells
    days.forEach(dayItem => {
      const cell = document.createElement('div');
      cell.className = 'calendar-day-cell';
      cell.setAttribute('data-date', dayItem.dateKey);

      if (dayItem.dateKey === todayStr) {
        cell.classList.add('today');
      }

      if (dayItem.status.isPeriodDay) {
        cell.classList.add('period-day');
      } else if (dayItem.status.isOvulationDay) {
        cell.classList.add('ovulation-day');
      } else if (dayItem.status.isFertileWindow) {
        cell.classList.add('fertile-day');
      }

      // Build inner cell markup
      let badgeHtml = '';
      if (dayItem.status.isPeriodDay) {
        badgeHtml = `<span class="indicator-badge badge-period">🩸 Period</span>`;
      } else if (dayItem.status.isOvulationDay) {
        badgeHtml = `<span class="indicator-badge badge-ovulation">✨ Ovulation</span>`;
      } else if (dayItem.status.isFertileWindow) {
        badgeHtml = `<span class="indicator-badge" style="background: rgba(255,142,83,0.2); color: var(--color-coral);">🌿 Fertile</span>`;
      }

      const symptomDotHtml = dayItem.hasSymptoms ? `<span class="badge-symptom-dot" title="Logged symptoms/notes"></span>` : '';

      cell.innerHTML = `
        <div class="day-cell-top">
          <span class="day-number">${dayItem.dayNumber}</span>
          <span class="day-phase-dot" style="background-color: ${dayItem.status.phase.color}"></span>
        </div>
        <div class="day-indicator-row">
          ${badgeHtml}
          ${symptomDotHtml}
        </div>
      `;

      cell.addEventListener('click', () => {
        if (onDayClick) onDayClick(dayItem.dateKey);
      });

      calendarGrid.appendChild(cell);
    });
  }

  /**
   * Render Cycle Syncing Guide
   */
  renderCycleSyncingGuide(status) {
    const guide = CYCLE_SYNCING_GUIDE[status.phase.key];
    if (!guide) return;

    const phaseTitleEl = document.getElementById('sync-phase-title');
    const phaseTaglineEl = document.getElementById('sync-phase-tagline');
    const nutritionListEl = document.getElementById('sync-nutrition-list');
    const workoutListEl = document.getElementById('sync-workout-list');
    const mindsetListEl = document.getElementById('sync-mindset-list');
    const partnerNoteEl = document.getElementById('sync-partner-tip');

    if (phaseTitleEl) phaseTitleEl.textContent = `${status.phase.icon} ${guide.title}`;
    if (phaseTaglineEl) phaseTaglineEl.textContent = status.phase.tagline;

    if (nutritionListEl) {
      nutritionListEl.innerHTML = guide.foods.map(item => `<li>${item}</li>`).join('');
    }

    if (workoutListEl) {
      workoutListEl.innerHTML = guide.workouts.map(item => `<li>${item}</li>`).join('');
    }

    if (mindsetListEl) {
      mindsetListEl.innerHTML = guide.mindset.map(item => `<li>${item}</li>`).join('');
    }

    if (partnerNoteEl) {
      partnerNoteEl.textContent = guide.partnerTip;
    }
  }

  /**
   * Render History & Analytics Screen
   */
  renderHistoryAnalytics(profile, logs) {
    const avgCycleEl = document.getElementById('metric-avg-cycle');
    const avgPeriodEl = document.getElementById('metric-avg-period');
    const totalLoggedEl = document.getElementById('metric-total-logged');
    const timelineListEl = document.getElementById('cycle-timeline-list');

    if (avgCycleEl) avgCycleEl.textContent = `${profile.cycleLength || 28}d`;
    if (avgPeriodEl) avgPeriodEl.textContent = `${profile.periodLength || 5}d`;

    const logKeys = Object.keys(logs || {});
    if (totalLoggedEl) totalLoggedEl.textContent = logKeys.length;

    if (timelineListEl) {
      timelineListEl.innerHTML = '';

      // Render recent log entries
      const sortedKeys = logKeys.sort().reverse().slice(0, 10);
      if (sortedKeys.length === 0) {
        timelineListEl.innerHTML = `<p style="color: var(--text-muted); font-size: 0.9rem;">No logs recorded yet. Start logging your days to see trends!</p>`;
        return;
      }

      sortedKeys.forEach(dateKey => {
        const item = logs[dateKey];
        const dateObj = parseDateKey(dateKey);
        const dateFormatted = dateObj.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

        const row = document.createElement('div');
        row.className = 'timeline-row';

        const flowTag = item.flow ? `<span class="pill-tag" style="background: rgba(255,107,139,0.2); color: var(--color-rose);">🩸 ${item.flow}</span>` : '';
        const moodTags = (item.moods || []).map(m => `<span class="pill-tag" style="background: rgba(132,94,194,0.2); color: var(--color-fuchsia);">${m}</span>`).join(' ');
        const symptomTags = (item.symptoms || []).map(s => `<span class="pill-tag" style="background: rgba(0,201,167,0.15); color: var(--color-teal);">${s}</span>`).join(' ');

        row.innerHTML = `
          <div class="timeline-dates">
            <span class="timeline-dates-main">${dateFormatted}</span>
            <span class="timeline-dates-sub">${item.notes ? `"${item.notes}"` : 'Daily log entry'}</span>
          </div>
          <div class="timeline-tags">
            ${flowTag}
            ${moodTags}
            ${symptomTags}
          </div>
        `;
        timelineListEl.appendChild(row);
      });
    }
  }

  /**
   * Populate Daily Logger Modal with active values
   */
  populateLoggerModal(dateKey, logData = {}) {
    const modalDateInput = document.getElementById('log-date-input');
    const waterVal = document.getElementById('log-water-val');
    const sleepSlider = document.getElementById('log-sleep-slider');
    const sleepVal = document.getElementById('log-sleep-val');
    const notesInput = document.getElementById('log-notes');

    if (modalDateInput) modalDateInput.value = dateKey;
    if (waterVal) waterVal.textContent = `${logData.waterGlasses || 8} glasses`;
    if (sleepSlider) sleepSlider.value = logData.sleepHours || 8;
    if (sleepVal) sleepVal.textContent = `${logData.sleepHours || 8}h`;
    if (notesInput) notesInput.value = logData.notes || '';

    // Flow selection
    document.querySelectorAll('.flow-chip').forEach(chip => {
      const val = chip.getAttribute('data-value');
      chip.classList.toggle('active', logData.flow === val);
    });

    // Symptoms selection
    const activeSymptoms = new Set(logData.symptoms || []);
    document.querySelectorAll('.symptom-chip').forEach(chip => {
      const val = chip.getAttribute('data-value');
      chip.classList.toggle('active', activeSymptoms.has(val));
    });

    // Moods selection
    const activeMoods = new Set(logData.moods || []);
    document.querySelectorAll('.mood-chip').forEach(chip => {
      const val = chip.getAttribute('data-value');
      chip.classList.toggle('active', activeMoods.has(val));
    });
  }
}

export const ui = new UIComponents();
