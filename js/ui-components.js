/**
 * AifyCycle - UI Components & Renderers
 * Manages visual rendering of the Cycle Dial, Calendar, Syncing Guide,
 * Analytics, and Modals.
 */

import { CYCLE_SYNCING_GUIDE, getMonthCycleMap, formatDateKey, parseDateKey, addDays, PHASES, getCycleStatus } from './cycle-engine.js';

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
   * Helper to calculate SVG arc path between degrees (0 deg is 12 o'clock top)
   */
  _describeArc(cx, cy, r, startAngleDeg, endAngleDeg) {
    const startRad = (startAngleDeg - 90) * Math.PI / 180;
    const endRad = (endAngleDeg - 90) * Math.PI / 180;
    const x1 = cx + r * Math.cos(startRad);
    const y1 = cy + r * Math.sin(startRad);
    const x2 = cx + r * Math.cos(endRad);
    const y2 = cy + r * Math.sin(endRad);
    const diff = endAngleDeg - startAngleDeg;
    const largeArcFlag = diff <= 180 ? '0' : '1';
    return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${largeArcFlag} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
  }

  /**
   * Render the Grand Biological Cycle Wheel / Compass
   */
  renderCycleDial(status, profile, onDaySelect = null) {
    const cx = 170;
    const cy = 170;
    const r = 130;
    const totalDays = profile.cycleLength || 28;
    const periodLength = profile.periodLength || 5;
    const ovulationDay = Math.max(totalDays - 14, periodLength + 2);
    const fertileStart = Math.max(ovulationDay - 5, periodLength + 1);
    const fertileEnd = Math.min(ovulationDay + 1, totalDays - 1);

    // 1. Calculate Arc Angles (in degrees, 0 is top)
    const degPerDay = 360 / totalDays;
    
    // Menstrual Arc: Days 0 to periodLength
    const menstrualEndDeg = periodLength * degPerDay;
    // Follicular Arc: Days periodLength to fertileStart - 1
    const follicularEndDeg = (fertileStart - 1) * degPerDay;
    // Fertile Arc: Days fertileStart - 1 to fertileEnd
    const fertileEndDeg = fertileEnd * degPerDay;
    // Luteal Arc: Days fertileEnd to totalDays (359.99 for clean SVG render)
    const lutealEndDeg = 359.99;

    const arcMenstrual = document.getElementById('arc-menstrual');
    const arcFollicular = document.getElementById('arc-follicular');
    const arcOvulatory = document.getElementById('arc-ovulatory');
    const arcLuteal = document.getElementById('arc-luteal');
    const fertileUnderlay = document.getElementById('dial-fertile-underlay');

    if (arcMenstrual) arcMenstrual.setAttribute('d', this._describeArc(cx, cy, r, 0.5, menstrualEndDeg - 0.5));
    if (arcFollicular && follicularEndDeg > menstrualEndDeg) {
      arcFollicular.setAttribute('d', this._describeArc(cx, cy, r, menstrualEndDeg + 0.5, follicularEndDeg - 0.5));
    }
    if (arcOvulatory && fertileEndDeg > follicularEndDeg) {
      arcOvulatory.setAttribute('d', this._describeArc(cx, cy, r, follicularEndDeg + 0.5, fertileEndDeg - 0.5));
    }
    if (arcLuteal && lutealEndDeg > fertileEndDeg) {
      arcLuteal.setAttribute('d', this._describeArc(cx, cy, r, fertileEndDeg + 0.5, lutealEndDeg));
    }
    if (fertileUnderlay && fertileEndDeg > follicularEndDeg) {
      fertileUnderlay.setAttribute('d', this._describeArc(cx, cy, r + 2, follicularEndDeg, fertileEndDeg));
    }

    // 2. Main Progress Ring
    const circumference = 2 * Math.PI * r; // ~816.81
    const progressOffset = circumference - (circumference * (status.cycleDay / totalDays));
    const dialProgress = document.getElementById('dial-progress');
    if (dialProgress) {
      dialProgress.style.strokeDasharray = `${circumference}`;
      dialProgress.style.strokeDashoffset = `${progressOffset}`;
    }

    // 3. Radial Day Pips
    const dayTicksGroup = document.getElementById('dial-day-ticks');
    if (dayTicksGroup) {
      dayTicksGroup.innerHTML = '';
      for (let d = 1; d <= totalDays; d++) {
        const midDeg = ((d - 0.5) / totalDays) * 360 - 90;
        const rad = midDeg * Math.PI / 180;
        const pipRadius = 148;
        const px = cx + pipRadius * Math.cos(rad);
        const py = cy + pipRadius * Math.sin(rad);

        const isCompleted = d < status.cycleDay;
        const isToday = d === status.cycleDay;
        const isOvulation = d === ovulationDay;
        const isFertile = d >= fertileStart && d <= fertileEnd;
        const isPeriod = d <= periodLength;

        let phaseClass = isPeriod ? 'phase-period' : isFertile ? 'phase-fertile' : d < fertileStart ? 'phase-follicular' : 'phase-luteal';

        const pip = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        pip.setAttribute('cx', px.toFixed(2));
        pip.setAttribute('cy', py.toFixed(2));
        pip.setAttribute('r', isToday ? '4.5' : isOvulation ? '3.5' : '2.2');
        pip.setAttribute('class', `dial-tick-pip ${phaseClass} ${isCompleted ? 'completed' : ''} ${isToday ? 'active-today' : ''}`);
        pip.setAttribute('data-day', d);
        pip.innerHTML = `<title>Day ${d}: ${isPeriod ? 'Period' : isOvulation ? 'Ovulation Peak' : isFertile ? 'Fertile Window' : d < fertileStart ? 'Follicular' : 'Luteal Phase'}</title>`;

        pip.addEventListener('click', () => {
          this.inspectDialDay(d, profile, status);
          if (typeof onDaySelect === 'function') onDaySelect(d);
        });

        dayTicksGroup.appendChild(pip);
      }
    }

    // 4. Dedicated Ovulation Star Marker Position
    const ovMarker = document.getElementById('dial-ovulation-marker');
    if (ovMarker) {
      const ovMidDeg = ((ovulationDay - 0.5) / totalDays) * 360 - 90;
      const ovRad = ovMidDeg * Math.PI / 180;
      const ovX = cx + r * Math.cos(ovRad);
      const ovY = cy + r * Math.sin(ovRad);
      ovMarker.setAttribute('transform', `translate(${ovX.toFixed(2)}, ${ovY.toFixed(2)})`);
    }

    // 5. Orbital Celestial Bead Position
    const bead = document.getElementById('dial-orbital-bead');
    if (bead) {
      const beadMidDeg = ((status.cycleDay - 0.5) / totalDays) * 360 - 90;
      const beadRad = beadMidDeg * Math.PI / 180;
      const bx = cx + r * Math.cos(beadRad);
      const by = cy + r * Math.sin(beadRad);
      bead.setAttribute('transform', `translate(${bx.toFixed(2)}, ${by.toFixed(2)})`);
    }

    // 6. Dynamic Ambient Glow Backdrop
    const ambientGlow = document.getElementById('dial-ambient-glow');
    if (ambientGlow) {
      const phaseColor = status.phase.key === 'menstrual' ? 'rgba(255, 46, 99, 0.22)' :
                         status.phase.key === 'follicular' ? 'rgba(199, 125, 255, 0.18)' :
                         status.phase.key === 'ovulatory' ? 'rgba(255, 158, 0, 0.28)' :
                         'rgba(44, 115, 210, 0.22)';
      ambientGlow.style.background = `radial-gradient(circle at 50% 50%, ${phaseColor} 0%, rgba(255,255,255,0) 70%)`;
    }

    // 7. Center Phase Console Text
    const dialDayNumber = document.getElementById('dial-day-number');
    const dialTotalDays = document.getElementById('dial-total-days');
    const dialPhaseTitle = document.getElementById('dial-phase-title');
    const dialFertilityBadge = document.getElementById('dial-fertility-badge');
    const dialCountdownPill = document.getElementById('dial-countdown-pill');
    const dialCycleTag = document.getElementById('dial-cycle-tag');
    const resetTodayBtn = document.getElementById('btn-dial-reset-today');

    if (dialDayNumber) dialDayNumber.textContent = status.cycleDay;
    if (dialTotalDays) dialTotalDays.textContent = `/ ${status.cycleLength} days`;
    if (dialCycleTag) dialCycleTag.textContent = 'CURRENT CYCLE';
    if (resetTodayBtn) resetTodayBtn.style.display = 'none';

    if (dialPhaseTitle) {
      dialPhaseTitle.innerHTML = `${status.phase.icon} ${status.phase.name}`;
      dialPhaseTitle.style.color = status.phase.color;
    }

    if (dialFertilityBadge) {
      dialFertilityBadge.className = `dial-fertility-badge ${status.fertilityBadgeClass}`;
      dialFertilityBadge.innerHTML = `<span class="badge-dot"></span> Fertility: ${status.fertilityChance}`;
    }

    if (dialCountdownPill) {
      dialCountdownPill.textContent = `${status.daysUntilNextPeriod} days until next period`;
    }

    // 8. Bottom Stats Cards
    const statDaysNextPeriod = document.getElementById('stat-days-next-period');
    const statPeriodStartDate = document.getElementById('stat-period-start-date');
    const statOvulationDate = document.getElementById('stat-ovulation-date');

    if (statDaysNextPeriod) statDaysNextPeriod.textContent = `${status.daysUntilNextPeriod} days`;
    if (statPeriodStartDate) {
      const nextDate = parseDateKey(status.nextPeriodStart);
      statPeriodStartDate.textContent = nextDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }
    if (statOvulationDate) {
      const ovDate = parseDateKey(status.nextOvulationDate);
      statOvulationDate.textContent = ovDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }

    // 9. Reset Today button callback
    if (resetTodayBtn) {
      resetTodayBtn.onclick = () => {
        this.renderCycleDial(status, profile, onDaySelect);
      };
    }

    // 10. Horizon Legend interactive clicks
    document.querySelectorAll('.wheel-legend-pill').forEach(pill => {
      pill.onclick = () => {
        const phaseKey = pill.getAttribute('data-phase');
        document.querySelectorAll('.wheel-legend-pill').forEach(p => p.classList.remove('active-phase'));
        pill.classList.add('active-phase');

        const targetDay = phaseKey === 'menstrual' ? 2 :
                          phaseKey === 'follicular' ? Math.floor((periodLength + fertileStart) / 2) :
                          phaseKey === 'ovulatory' ? ovulationDay :
                          Math.floor((fertileEnd + totalDays) / 2);
        this.inspectDialDay(targetDay, profile, status);
      };
    });
  }

  /**
   * Inspect a specific day around the wheel
   */
  inspectDialDay(dayNumber, profile, todayStatus) {
    const totalDays = profile.cycleLength || 28;
    const periodLength = profile.periodLength || 5;
    const ovulationDay = Math.max(totalDays - 14, periodLength + 2);
    const fertileStart = Math.max(ovulationDay - 5, periodLength + 1);
    const fertileEnd = Math.min(ovulationDay + 1, totalDays - 1);

    let phase = PHASES.LUTEAL;
    if (dayNumber <= periodLength) phase = PHASES.MENSTRUAL;
    else if (dayNumber < fertileStart) phase = PHASES.FOLLICULAR;
    else if (dayNumber <= fertileEnd) phase = PHASES.OVULATORY;

    const isToday = dayNumber === todayStatus.cycleDay;

    const dialDayNumber = document.getElementById('dial-day-number');
    const dialTotalDays = document.getElementById('dial-total-days');
    const dialPhaseTitle = document.getElementById('dial-phase-title');
    const dialFertilityBadge = document.getElementById('dial-fertility-badge');
    const dialCountdownPill = document.getElementById('dial-countdown-pill');
    const dialCycleTag = document.getElementById('dial-cycle-tag');
    const resetTodayBtn = document.getElementById('btn-dial-reset-today');

    if (dialDayNumber) dialDayNumber.textContent = dayNumber;
    if (dialTotalDays) dialTotalDays.textContent = `/ ${totalDays} days`;
    if (dialCycleTag) dialCycleTag.textContent = isToday ? 'TODAY' : `DAY ${dayNumber} PREVIEW`;
    if (resetTodayBtn) resetTodayBtn.style.display = isToday ? 'none' : 'inline-block';

    if (dialPhaseTitle) {
      dialPhaseTitle.innerHTML = `${phase.icon} ${phase.name}`;
      dialPhaseTitle.style.color = phase.color;
    }

    if (dialFertilityBadge) {
      let fertilityText = 'Low';
      let badgeClass = 'fertility-low';
      if (dayNumber === ovulationDay) {
        fertilityText = 'Peak (Ovulation)';
        badgeClass = 'fertility-peak';
      } else if (dayNumber >= fertileStart && dayNumber <= fertileEnd) {
        fertilityText = 'High Chance';
        badgeClass = 'fertility-high';
      }
      dialFertilityBadge.className = `dial-fertility-badge ${badgeClass}`;
      dialFertilityBadge.innerHTML = `<span class="badge-dot"></span> Fertility: ${fertilityText}`;
    }

    if (dialCountdownPill) {
      dialCountdownPill.textContent = phase.tagline || phase.energy;
    }
  }

  /**
   * Render Interactive Dashboard Vitals (Hydration, Sleep, Mood, Hormones, Timeline)
   */
  renderDashboardVitals(status, profile, todayLog = {}, onVitalsChange = null) {
    // 1. Banner Info
    const bannerName = document.getElementById('user-greeting');
    const headerGreeting = document.getElementById('header-user-greeting');
    const bannerPhaseText = document.getElementById('dashboard-phase-name-text');
    const bannerFertility = document.getElementById('dashboard-fertility-text');
    const bannerAvatar = document.getElementById('banner-user-avatar');
    const bannerProvider = document.getElementById('banner-provider-badge');

    const hour = new Date().getHours();
    const timeGreeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    const greetingText = `${timeGreeting}, ${profile.userName || 'Agatha'} 🌸`;
    if (bannerName) {
      bannerName.textContent = greetingText;
    }
    if (headerGreeting) {
      headerGreeting.textContent = greetingText;
    }

    if (bannerPhaseText) {
      bannerPhaseText.textContent = `${status.phase.name} • Day ${status.cycleDay}`;
    }

    if (bannerFertility) {
      bannerFertility.textContent = status.cycleDay === (profile.cycleLength - 14) ? '✨ Peak Ovulation Today' :
                                    status.fertilityChance.includes('High') ? '✨ Fertile Window Open' :
                                    `${status.fertilityChance} Fertility`;
    }

    // 2. Timeline Ribbon Active Cursor
    const cursor = document.getElementById('timeline-active-cursor');
    if (cursor) {
      const pct = Math.min(Math.max((status.cycleDay / (profile.cycleLength || 28)) * 100, 2), 98);
      cursor.style.left = `${pct}%`;
    }

    // 3. Hydration Glasses Rack
    const waterRack = document.getElementById('hydration-glasses-rack');
    const waterProgressSub = document.getElementById('water-progress-sub');
    const currentWater = todayLog.waterGlasses !== undefined ? todayLog.waterGlasses : 6;
    const targetWater = 8;

    if (waterProgressSub) {
      const ml = currentWater * 250;
      const pct = Math.round((currentWater / targetWater) * 100);
      waterProgressSub.textContent = `${currentWater} of ${targetWater} glasses • ${ml.toLocaleString()} ml (${pct}%)`;
    }

    if (waterRack) {
      waterRack.innerHTML = '';
      for (let i = 1; i <= targetWater; i++) {
        const isFilled = i <= currentWater;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `glass-btn ${isFilled ? 'filled' : 'empty'}`;
        btn.setAttribute('title', isFilled ? `Glass ${i}: Click to set to ${i - 1} glasses` : `Glass ${i}: Click to drink ${i * 250} ml`);
        btn.innerHTML = `
          <svg class="glass-svg" viewBox="0 0 24 30" width="22" height="28">
            <path class="glass-outline" d="M4 2 L20 2 L18 26 C17.8 28 16 29 14 29 L10 29 C8 29 6.2 28 6 26 Z" fill="none" stroke="currentColor" stroke-width="1.8" />
            ${isFilled ? '<path class="glass-water-fill" d="M4.8 11 L19.2 11 L18 26 C17.8 27.5 16.2 28.2 14 28.2 L10 28.2 C7.8 28.2 6.2 27.5 6 26 Z" />' : ''}
          </svg>
          <span class="glass-idx">${i}</span>
        `;

        btn.addEventListener('click', () => {
          const nextCount = isFilled && i === currentWater ? i - 1 : i;
          if (typeof onVitalsChange === 'function') {
            onVitalsChange('water', nextCount);
          }
        });

        waterRack.appendChild(btn);
      }
    }

    // 4. Sleep
    const sleepVal = document.getElementById('dashboard-sleep-val');
    if (sleepVal) {
      sleepVal.textContent = (todayLog.sleepHours || 8.0).toFixed(1);
    }

    // 5. Energy Battery & Moods
    const energyFill = document.getElementById('energy-fill-gauge');
    if (energyFill) {
      const energyPct = status.phase.key === 'ovulatory' ? 95 :
                        status.phase.key === 'follicular' ? 85 :
                        status.phase.key === 'luteal' ? 65 : 45;
      energyFill.style.width = `${energyPct}%`;
    }

    const currentMoods = todayLog.moods || ['Radiant'];
    document.querySelectorAll('.dash-mood-chip').forEach(chip => {
      const mood = chip.getAttribute('data-mood');
      chip.classList.toggle('active', currentMoods.includes(mood));
    });

    // 6. Hormone Matrix
    const eVal = document.getElementById('hormone-val-estrogen');
    const lhVal = document.getElementById('hormone-val-lh');
    const pVal = document.getElementById('hormone-val-progesterone');
    const fshVal = document.getElementById('hormone-val-fsh');

    const fillE = document.querySelector('.fill-estrogen');
    const fillLH = document.querySelector('.fill-lh');
    const fillP = document.querySelector('.fill-progesterone');
    const fillFSH = document.querySelector('.fill-fsh');

    const hormoneProfiles = {
      menstrual: { e: 22, lh: 15, p: 14, fsh: 60, eTag: '22% Baseline', lhTag: '15% Low', pTag: '14% Baseline', fshTag: '60% Active' },
      follicular: { e: 78, lh: 32, p: 16, fsh: 70, eTag: '78% Rising', lhTag: '32% Building', pTag: '16% Baseline', fshTag: '70% Stimulating' },
      ovulatory: { e: 96, lh: 94, p: 20, fsh: 44, eTag: '96% Peak', lhTag: '94% Surge', pTag: '20% Baseline', fshTag: '44% Steady' },
      luteal: { e: 46, lh: 12, p: 92, fsh: 22, eTag: '46% Moderate', lhTag: '12% Low', pTag: '92% Dominant', fshTag: '22% Resting' }
    };

    const hp = hormoneProfiles[status.phase.key] || hormoneProfiles.ovulatory;
    if (eVal) eVal.textContent = hp.eTag;
    if (lhVal) lhVal.textContent = hp.lhTag;
    if (pVal) pVal.textContent = hp.pTag;
    if (fshVal) fshVal.textContent = hp.fshTag;

    if (fillE) fillE.style.width = `${hp.e}%`;
    if (fillLH) fillLH.style.width = `${hp.lh}%`;
    if (fillP) fillP.style.width = `${hp.p}%`;
    if (fillFSH) fillFSH.style.width = `${hp.fsh}%`;

    // 7. Symptoms Chips Active State
    const currentSymptoms = todayLog.symptoms || [];
    document.querySelectorAll('.dash-symptom-chip').forEach(chip => {
      const sym = chip.getAttribute('data-symptom');
      chip.classList.toggle('active', currentSymptoms.includes(sym));
    });

    // 8. Update Hero Partner Tip
    const partnerNoteEl = document.getElementById('hero-partner-care-note');
    if (partnerNoteEl) {
      const guide = CYCLE_SYNCING_GUIDE[status.phase.key];
      if (guide && guide.partnerTip) {
        partnerNoteEl.textContent = `"${guide.partnerTip}"`;
      }
    }

    // 9. Update Phase Description
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
        badgeHtml = `<span class="indicator-badge badge-period" title="Period Day"><span class="badge-icon">🩸</span><span class="badge-text">Period</span></span>`;
      } else if (dayItem.status.isOvulationDay) {
        badgeHtml = `<span class="indicator-badge badge-ovulation" title="Ovulation Peak"><span class="badge-icon">✨</span><span class="badge-text">Ovulation</span></span>`;
      } else if (dayItem.status.isFertileWindow) {
        badgeHtml = `<span class="indicator-badge badge-fertile" title="Fertile Window"><span class="badge-icon">🌿</span><span class="badge-text">Fertile</span></span>`;
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
   * Render Cycle Syncing Guide (with Gemini 3.6 Flash Intelligence support)
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
        refreshBtn.innerHTML = `<span class="refresh-icon spinning">✨</span> <span class="refresh-text">Consulting Gemini 3.6...</span>`;
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
            <span>🧬</span> <strong>Endocrine Rationale (Gemini 3.6):</strong> ${insights.scientificWhy}
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
