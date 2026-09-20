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
   * Render Cycle Syncing Guide (with Gemini 3.8 Flash Intelligence support)
   */
  renderCycleSyncingGuide(status, insights = null, isLoading = false) {
    const guide = CYCLE_SYNCING_GUIDE[status.phase.key];
    if (!guide) return;

    const phaseTitleEl = document.getElementById('sync-phase-title');
    const phaseTaglineEl = document.getElementById('sync-phase-tagline');
    const cycleDayPill = document.getElementById('sync-cycle-day-pill');
    const hormoneDescEl = document.getElementById('sync-hormone-desc');
    const energyDescEl = document.getElementById('sync-energy-desc');
    const nutritionListEl = document.getElementById('sync-nutrition-list');
    const workoutListEl = document.getElementById('sync-workout-list');
    const mindsetListEl = document.getElementById('sync-mindset-list');
    const partnerNoteEl = document.getElementById('sync-partner-tip');
    const scientificWhyEl = document.getElementById('sync-scientific-why');
    const refreshBtn = document.getElementById('btn-refresh-gemini-sync');

    if (cycleDayPill) {
      cycleDayPill.textContent = `Day ${status.cycleDay} of ${status.cycleLength}`;
    }

    if (isLoading) {
      if (refreshBtn) {
        refreshBtn.classList.add('loading');
        refreshBtn.innerHTML = `<span class="refresh-icon spinning">✨</span> <span class="refresh-text">Consulting Gemini 3.8...</span>`;
      }
      const skeletonItems = `
        <li class="skeleton-shimmer" style="height: 16px; border-radius: 6px; margin-bottom: 6px;"></li>
        <li class="skeleton-shimmer" style="height: 16px; border-radius: 6px; width: 85%; margin-bottom: 6px;"></li>
        <li class="skeleton-shimmer" style="height: 16px; border-radius: 6px; width: 70%;"></li>
      `;
      if (nutritionListEl) nutritionListEl.innerHTML = skeletonItems;
      if (workoutListEl) workoutListEl.innerHTML = skeletonItems;
      if (mindsetListEl) mindsetListEl.innerHTML = skeletonItems;
      if (partnerNoteEl) partnerNoteEl.innerHTML = `<span class="skeleton-shimmer" style="display:block; height: 18px; border-radius: 6px; width: 90%;"></span>`;
      if (scientificWhyEl) scientificWhyEl.innerHTML = '';
      return;
    }

    if (refreshBtn) {
      refreshBtn.classList.remove('loading');
      refreshBtn.innerHTML = `<span class="refresh-icon">✨</span> <span class="refresh-text">Refresh with Gemini</span>`;
    }

    // Default hormone description and energy capacity by phase if not returned by Gemini
    const defaultHormones = {
      menstrual: 'Estrogen & progesterone at lowest baseline • Uterine lining shedding',
      follicular: 'FSH stimulates follicle recruitment • Estrogen steadily rising',
      ovulatory: 'Estrogen peak • LH surge triggering follicle release',
      luteal: 'Progesterone surge from corpus luteum • Thermogenic body temp rise'
    };

    const defaultEnergy = {
      menstrual: 'Restorative Inward Energy (40-50%)',
      follicular: 'Rising Creative Vitality (75-85%)',
      ovulatory: 'Peak Dynamic Power (95-100%)',
      luteal: 'Grounded Focused Energy (65-75%)'
    };

    if (phaseTitleEl) {
      phaseTitleEl.textContent = `${status.phase.icon} ${insights?.title || guide.title}`;
    }
    if (phaseTaglineEl) {
      phaseTaglineEl.textContent = insights?.tagline || status.phase.tagline;
    }
    if (hormoneDescEl) {
      hormoneDescEl.textContent = insights?.hormoneSnapshot || defaultHormones[status.phase.key] || 'Natural endocrine rhythm in progress';
    }
    if (energyDescEl) {
      energyDescEl.textContent = insights?.energyCapacity || defaultEnergy[status.phase.key] || 'Normal bio-rhythm energy';
    }

    // Render lists with rich formatting
    const foods = (insights && Array.isArray(insights.foods) && insights.foods.length > 0) ? insights.foods : guide.foods;
    const workouts = (insights && Array.isArray(insights.workouts) && insights.workouts.length > 0) ? insights.workouts : guide.workouts;
    const mindset = (insights && Array.isArray(insights.mindset) && insights.mindset.length > 0) ? insights.mindset : guide.mindset;

    if (nutritionListEl) {
      nutritionListEl.innerHTML = foods.map(item => `<li><span class="sync-item-bullet">🥑</span><span>${item}</span></li>`).join('');
    }

    if (workoutListEl) {
      workoutListEl.innerHTML = workouts.map(item => `<li><span class="sync-item-bullet">⚡</span><span>${item}</span></li>`).join('');
    }

    if (mindsetListEl) {
      mindsetListEl.innerHTML = mindset.map(item => `<li><span class="sync-item-bullet">💡</span><span>${item}</span></li>`).join('');
    }

    if (partnerNoteEl) {
      partnerNoteEl.textContent = insights?.partnerTip || guide.partnerTip;
    }

    if (scientificWhyEl) {
      if (insights?.scientificWhy) {
        scientificWhyEl.innerHTML = `
          <div class="ai-scientific-pill">
            <span>🧬</span> <strong>Endocrine Rationale (Gemini 3.8):</strong> ${insights.scientificWhy}
          </div>
        `;
      } else {
        scientificWhyEl.innerHTML = `
          <div class="ai-scientific-pill">
            <span>🧬</span> <strong>Phase Biology:</strong> Tailored to support your natural hormone shifts during the ${status.phase.name}.
          </div>
        `;
      }
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

    // Render Data Privacy & Usage Telemetry section
    this.renderTelemetryDashboard();
  }

  /**
   * Render the Data Privacy & Usage Telemetry Dashboard
   */
  renderTelemetryDashboard() {
    const aiQueriesEl = document.getElementById('telemetry-ai-queries');
    const aiBreakdownEl = document.getElementById('telemetry-ai-breakdown');
    const aiLatencyEl = document.getElementById('telemetry-ai-latency');
    const storageKbEl = document.getElementById('telemetry-storage-kb');
    const consentStatusEl = document.getElementById('telemetry-consent-status');
    const auditListEl = document.getElementById('telemetry-audit-list');

    // Dynamically retrieve summary from storage/tracker
    let telemetry = {};
    let auditLogs = [];
    try {
      const telRaw = localStorage.getItem('aifycycle_telemetry_v1');
      telemetry = telRaw ? JSON.parse(telRaw) : {};
      const auditRaw = localStorage.getItem('aifycycle_audit_log_v1');
      auditLogs = auditRaw ? JSON.parse(auditRaw) : [];
    } catch (e) {}

    const totalQueries = telemetry.featureUsage?.aiCoachQueries || 0;
    const liveQueries = telemetry.featureUsage?.aiLiveGeminiQueries || 0;
    const localQueries = telemetry.featureUsage?.aiLocalQueries || 0;
    const avgLatency = telemetry.aiPerformance?.avgResponseTimeMs || 0;

    let totalStorageBytes = 0;
    for (let key in localStorage) {
      if (localStorage.hasOwnProperty(key)) {
        totalStorageBytes += (key.length + (localStorage[key] || '').length) * 2;
      }
    }
    const storageKb = (totalStorageBytes / 1024).toFixed(2);

    let isConsentActive = true;
    try {
      const consentRaw = localStorage.getItem('aifycycle_consent_v1');
      if (consentRaw) isConsentActive = JSON.parse(consentRaw).analyticsAllowed !== false;
    } catch (e) {}

    if (aiQueriesEl) aiQueriesEl.textContent = totalQueries;
    if (aiBreakdownEl) aiBreakdownEl.textContent = `${liveQueries} Live • ${localQueries} Local`;
    if (aiLatencyEl) aiLatencyEl.textContent = avgLatency > 0 ? `${avgLatency}ms` : '< 200ms';
    if (storageKbEl) storageKbEl.textContent = `${storageKb} KB`;
    if (consentStatusEl) {
      consentStatusEl.textContent = isConsentActive ? 'Active' : 'Disabled';
      consentStatusEl.style.color = isConsentActive ? 'var(--color-teal)' : 'var(--text-muted)';
    }

    if (auditListEl) {
      auditListEl.innerHTML = '';
      const recent = auditLogs.slice(0, 8);
      if (recent.length === 0) {
        auditListEl.innerHTML = '<p style="color: var(--text-muted); font-size: 0.8rem;">No audit records recorded yet.</p>';
        return;
      }

      recent.forEach(log => {
        const item = document.createElement('div');
        item.className = 'audit-log-item';
        const timeFormatted = new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const dateFormatted = new Date(log.timestamp).toLocaleDateString([], { month: 'short', day: 'numeric' });

        item.innerHTML = `
          <div class="audit-log-badge">${log.action}</div>
          <div class="audit-log-detail">${log.detail}</div>
          <div class="audit-log-time">${dateFormatted} ${timeFormatted}</div>
        `;
        auditListEl.appendChild(item);
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
