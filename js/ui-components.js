/**
 * AifyCycle - UI Components & Renderers
 * Manages visual rendering of the Cycle Dial, Calendar, Syncing Guide,
 * Analytics, and Modals.
 */

import {
  CYCLE_SYNCING_GUIDE,
  getMonthCycleMap,
  computeCycleStats,
  formatDateKey,
  parseDateKey,
  addDays,
  PHASES,
  getCycleStatus,
  MIN_PERIOD_LENGTH
} from './cycle-engine.js';
import { escapeHtml } from './dom-utils.js';
import { svgIcon, phaseIconSvg } from './icons.js';

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
  showToast(message, iconName = 'check') {
    this.initToasts();
    const toast = document.createElement('div');
    toast.className = 'toast';
    if (iconName) {
      const iconSpan = document.createElement('span');
      iconSpan.className = 'toast-icon';
      iconSpan.innerHTML = svgIcon(iconName, 15);
      toast.appendChild(iconSpan);
    }
    const msgSpan = document.createElement('span');
    msgSpan.textContent = String(message ?? '');
    toast.appendChild(msgSpan);
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
    if (endAngleDeg <= startAngleDeg) return '';
    const clampedEnd = Math.min(endAngleDeg, startAngleDeg + 359.95);
    const startRad = (startAngleDeg - 90) * Math.PI / 180;
    const endRad = (clampedEnd - 90) * Math.PI / 180;
    const x1 = cx + r * Math.cos(startRad);
    const y1 = cy + r * Math.sin(startRad);
    const x2 = cx + r * Math.cos(endRad);
    const y2 = cy + r * Math.sin(endRad);
    const diff = clampedEnd - startAngleDeg;
    const largeArcFlag = diff <= 180 ? '0' : '1';
    return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${largeArcFlag} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
  }

  /**
   * Compute canonical cycle phase windows aligned 1-to-1 with cycle-engine.js
   */
  _getPhaseWindows(status, profile) {
    const totalDays = Math.max(15, Number(status?.cycleLength || profile?.cycleLength || 28));
    const periodLength = Math.max(MIN_PERIOD_LENGTH, Math.min(Number(status?.periodLength || profile?.periodLength || 5), totalDays - 4));
    const ovulationDay = Number(status?.ovulationDay) || Math.max(totalDays - 14, periodLength + 2);
    const fertileStart = Number(status?.fertileStart) || Math.max(ovulationDay - 5, periodLength + 1);
    const fertileEnd = Number(status?.fertileEnd) || Math.min(ovulationDay + 1, totalDays - 1);

    const degPerDay = 360 / totalDays;
    const buildWindow = (key, name, shortLabel, icon, startDay, endDay) => {
      const count = endDay >= startDay ? (endDay - startDay + 1) : 0;
      const rawStartDeg = (startDay - 1) * degPerDay;
      const rawEndDeg = endDay * degPerDay;
      const spanDeg = Math.max(0, rawEndDeg - rawStartDeg);
      // Inset rounded stroke caps (stroke-width 16 on r=130 => ~3.53deg protrusion) so adjacent phases have a crisp gap
      const capInset = count > 0 ? Math.min(4.2, Math.max(0.6, spanDeg * 0.22)) : 0;
      const startDeg = rawStartDeg + capInset;
      const endDeg = rawEndDeg - capInset;
      const rangeText = count <= 0 ? '' : (startDay === endDay ? `${startDay}` : `${startDay}-${endDay}`);
      return {
        key,
        name,
        shortLabel,
        icon,
        startDay,
        endDay,
        count,
        rawStartDeg,
        rawEndDeg,
        startDeg,
        endDeg,
        rangeText
      };
    };

    const windows = {
      menstrual: buildWindow('menstrual', 'Menstrual Phase', 'Period', 'droplet', 1, periodLength),
      follicular: buildWindow('follicular', 'Follicular Phase', 'Follicular', 'sprout', periodLength + 1, fertileStart - 1),
      ovulatory: buildWindow('ovulatory', 'Ovulatory Window', 'Ovulation', 'sparkles', fertileStart, fertileEnd),
      luteal: buildWindow('luteal', 'Luteal Phase', 'Luteal', 'moon', fertileEnd + 1, totalDays)
    };

    return { totalDays, periodLength, ovulationDay, fertileStart, fertileEnd, degPerDay, windows };
  }

  /**
   * Synchronize the SVG phase arcs, active halo, orbital bead, day pips, and legend pills
   */
  _updateDialVisuals({ activeDay, activePhaseKey, meta, isLate = false }) {
    const cx = 170;
    const cy = 170;
    const r = 130;
    const { totalDays, ovulationDay, windows } = meta;
    const clampedDay = Math.min(Math.max(Number(activeDay) || 1, 1), totalDays);
    const beadDeg = ((clampedDay - 0.5) / totalDays) * 360;

    // 1. Apply active phase theme token to card (syncs bead, halo, active pip, center border, badge)
    const dialCard = document.getElementById('cycle-dial-card') || document.querySelector('.cycle-dial-card');
    if (dialCard) {
      dialCard.setAttribute('data-phase', activePhaseKey || 'ovulatory');
    }

    // 2. Full-cycle soft background arcs + vibrant elapsed phase arcs (100% true phase colors)
    const phaseKeys = ['menstrual', 'follicular', 'ovulatory', 'luteal'];
    phaseKeys.forEach(key => {
      const win = windows[key];
      const bgArc = document.getElementById(`arc-bg-${key}`);
      const fgArc = document.getElementById(`arc-${key}`);

      if (!win || win.count <= 0 || win.endDeg <= win.startDeg) {
        if (bgArc) bgArc.setAttribute('d', '');
        if (fgArc) fgArc.setAttribute('d', '');
        return;
      }

      const fullPath = this._describeArc(cx, cy, r, win.startDeg, win.endDeg);
      if (bgArc) bgArc.setAttribute('d', fullPath);

      if (fgArc) {
        if (isLate || clampedDay >= win.endDay) {
          fgArc.setAttribute('d', fullPath);
        } else if (clampedDay >= win.startDay) {
          const partialEnd = Math.max(win.startDeg + 0.35, Math.min(win.endDeg, beadDeg));
          fgArc.setAttribute('d', this._describeArc(cx, cy, r, win.startDeg, partialEnd));
        } else {
          fgArc.setAttribute('d', '');
        }
      }
    });

    // 3. Soft fertile window underlay + active-phase outer accent halo
    const fertileUnderlay = document.getElementById('dial-fertile-underlay');
    const ovWin = windows.ovulatory;
    if (fertileUnderlay) {
      fertileUnderlay.setAttribute(
        'd',
        ovWin && ovWin.count > 0 ? this._describeArc(cx, cy, r, ovWin.startDeg, ovWin.endDeg) : ''
      );
    }

    const activeHalo = document.getElementById('dial-active-halo');
    const activeWin = windows[activePhaseKey];
    if (activeHalo) {
      activeHalo.setAttribute(
        'd',
        activeWin && activeWin.count > 0 ? this._describeArc(cx, cy, r, activeWin.startDeg, activeWin.endDeg) : ''
      );
    }

    // 4. Orbital Celestial Bead Position
    const bead = document.getElementById('dial-orbital-bead');
    if (bead) {
      const beadRad = (beadDeg - 90) * Math.PI / 180;
      const bx = cx + r * Math.cos(beadRad);
      const by = cy + r * Math.sin(beadRad);
      bead.setAttribute('transform', `translate(${bx.toFixed(2)}, ${by.toFixed(2)})`);
    }

    // 5. Update Day Pips active/completed/upcoming state
    const dayTicksGroup = document.getElementById('dial-day-ticks');
    if (dayTicksGroup) {
      dayTicksGroup.querySelectorAll('.dial-tick-pip').forEach(pip => {
        const d = Number(pip.getAttribute('data-day'));
        const isActive = d === clampedDay;
        const isCompleted = isLate ? true : d < clampedDay;
        const isUpcoming = !isLate && d > clampedDay;
        const isOvulation = d === ovulationDay;

        pip.classList.toggle('active-today', isActive);
        pip.classList.toggle('completed', isCompleted);
        pip.classList.toggle('upcoming', isUpcoming);
        pip.setAttribute('r', isActive ? '4.8' : isOvulation ? '3.5' : '2.4');
      });
    }

    // 6. Sync interactive phase legend pills active state
    document.querySelectorAll('.wheel-legend-pill').forEach(pill => {
      pill.classList.toggle('active-phase', pill.getAttribute('data-phase') === activePhaseKey);
    });
  }

  /**
   * Sync both the Cycle Horizon ribbon and the Compass legend pills to exact engine phase windows
   */
  _syncPhaseRangeLabels(meta) {
    const { totalDays, windows } = meta;

    const horizonTitle = document.getElementById('timeline-horizon-title');
    if (horizonTitle) {
      horizonTitle.textContent = `${totalDays}-Day Cycle Horizon`;
    }

    ['menstrual', 'follicular', 'ovulatory', 'luteal'].forEach(key => {
      const win = windows[key];
      const hasDays = win && win.count > 0;

      // Top Cycle Horizon legend label
      const horizonLegend = document.querySelector(`.timeline-legend-item[data-phase="${key}"]`);
      if (horizonLegend) {
        horizonLegend.style.display = hasDays ? '' : 'none';
        const labelEl = horizonLegend.querySelector('.timeline-legend-label');
        if (labelEl && hasDays) {
          labelEl.textContent = `${win.shortLabel} (${win.rangeText})`;
        }
      }

      // Top Cycle Horizon track segment proportions & text
      const seg = document.querySelector(`.timeline-track-segment[data-phase="${key}"]`);
      if (seg) {
        seg.style.display = hasDays ? '' : 'none';
        if (hasDays) {
          seg.style.flex = String(win.count);
          seg.title = `${win.name}: ${win.startDay === win.endDay ? `Day ${win.startDay}` : `Days ${win.rangeText}`}`;
          const segLabel = seg.querySelector('.track-seg-label');
          if (segLabel) {
            segLabel.textContent = win.startDay === win.endDay ? `Day ${win.startDay}` : `Days ${win.rangeText}`;
          }
        }
      }

      // Compass bottom interactive legend pills
      const wheelPill = document.querySelector(`.wheel-legend-pill[data-phase="${key}"]`);
      if (wheelPill) {
        wheelPill.style.display = hasDays ? '' : 'none';
        const pillText = wheelPill.querySelector('.legend-text');
        if (pillText && hasDays) {
          pillText.textContent = `${win.shortLabel} (${win.rangeText})`;
        }
      }
    });
  }

  /**
   * Render the Grand Biological Cycle Wheel / Compass
   */
  renderCycleDial(status, profile, onDaySelect = null) {
    const cx = 170;
    const cy = 170;
    const r = 130;
    const meta = this._getPhaseWindows(status, profile);
    const { totalDays, periodLength, ovulationDay, fertileStart, fertileEnd, windows } = meta;
    const activeDay = status.cycleDay ? Math.min(Math.max(status.cycleDay, 1), totalDays) : 1;

    // 1. Sync phase labels across Horizon ribbon & Compass legend pills
    this._syncPhaseRangeLabels(meta);

    // 2. Radial Day Pips
    const dayTicksGroup = document.getElementById('dial-day-ticks');
    if (dayTicksGroup) {
      dayTicksGroup.innerHTML = '';
      for (let d = 1; d <= totalDays; d++) {
        const midDeg = ((d - 0.5) / totalDays) * 360 - 90;
        const rad = midDeg * Math.PI / 180;
        const pipRadius = 148;
        const px = cx + pipRadius * Math.cos(rad);
        const py = cy + pipRadius * Math.sin(rad);

        const isOvulation = d === ovulationDay;
        const isFertile = d >= fertileStart && d <= fertileEnd;
        const isPeriod = d <= periodLength;

        const phaseClass = isPeriod ? 'phase-period' : isFertile ? 'phase-fertile' : d < fertileStart ? 'phase-follicular' : 'phase-luteal';

        const pip = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        pip.setAttribute('cx', px.toFixed(2));
        pip.setAttribute('cy', py.toFixed(2));
        pip.setAttribute('r', d === activeDay ? '4.8' : isOvulation ? '3.5' : '2.4');
        pip.setAttribute('class', `dial-tick-pip ${phaseClass}`);
        pip.setAttribute('data-day', d);
        pip.innerHTML = `<title>Day ${d}: ${isPeriod ? 'Period' : isOvulation ? 'Ovulation Peak' : isFertile ? 'Fertile Window' : d < fertileStart ? 'Follicular' : 'Luteal Phase'}</title>`;

        pip.addEventListener('click', () => {
          this.inspectDialDay(d, profile, status, onDaySelect);
          if (typeof onDaySelect === 'function') onDaySelect(d);
        });

        dayTicksGroup.appendChild(pip);
      }
    }

    // 3. Dedicated Ovulation Star Marker Position (centered at 0,0 inside SVG group)
    const ovMarker = document.getElementById('dial-ovulation-marker');
    if (ovMarker) {
      const ovMidDeg = ((ovulationDay - 0.5) / totalDays) * 360 - 90;
      const ovRad = ovMidDeg * Math.PI / 180;
      const ovX = cx + r * Math.cos(ovRad);
      const ovY = cy + r * Math.sin(ovRad);
      ovMarker.setAttribute('transform', `translate(${ovX.toFixed(2)}, ${ovY.toFixed(2)})`);
    }

    // 4. Sync True-Color Phase Arcs, Active Halo, Orbital Bead, Day Pips, and Legend Pills
    this._updateDialVisuals({
      activeDay,
      activePhaseKey: status.phase.key,
      meta,
      isLate: Boolean(status.isLate)
    });

    // 5. Center Phase Console Text
    const dialDayNumber = document.getElementById('dial-day-number');
    const dialTotalDays = document.getElementById('dial-total-days');
    const dialPhaseTitle = document.getElementById('dial-phase-title');
    const dialFertilityBadge = document.getElementById('dial-fertility-badge');
    const dialCountdownPill = document.getElementById('dial-countdown-pill');
    const dialCycleTag = document.getElementById('dial-cycle-tag');
    const resetTodayBtn = document.getElementById('btn-dial-reset-today');

    if (dialDayNumber) dialDayNumber.textContent = status.cycleDay ?? '—';
    if (dialTotalDays) dialTotalDays.textContent = `/ ${totalDays} days`;
    if (dialCycleTag) dialCycleTag.textContent = status.isLate ? 'LATE CYCLE' : 'CURRENT CYCLE';
    if (resetTodayBtn) resetTodayBtn.style.display = 'none';

    if (dialPhaseTitle) {
      dialPhaseTitle.innerHTML = `${phaseIconSvg(status.phase.key, 15, 'phase-title-icon')}<span>${escapeHtml(status.phase.name)}</span>`;
      dialPhaseTitle.style.color = status.phase.color;
    }

    if (dialFertilityBadge) {
      dialFertilityBadge.className = `dial-fertility-badge ${status.fertilityBadgeClass}`;
      dialFertilityBadge.title = 'Calendar estimate only — not a method of contraception.';
      dialFertilityBadge.innerHTML = `<span class="badge-dot"></span> ${escapeHtml(status.fertilityChance)}`;
    }

    if (dialCountdownPill) {
      if (status.isLate) {
        dialCountdownPill.textContent = `Period ${status.daysLate} ${status.daysLate === 1 ? 'day' : 'days'} late`;
      } else if (status.daysUntilNextPeriod === 0) {
        dialCountdownPill.textContent = 'Est. next period expected today';
      } else if (status.daysUntilNextPeriod != null) {
        dialCountdownPill.textContent = `${status.daysUntilNextPeriod} ${status.daysUntilNextPeriod === 1 ? 'day' : 'days'} until est. next period`;
      } else {
        dialCountdownPill.textContent = status.phase.tagline || status.phase.energy;
      }
    }

    // 6. Bottom Stats Cards
    const statDaysNextPeriod = document.getElementById('stat-days-next-period');
    const statPeriodStartDate = document.getElementById('stat-period-start-date');
    const statOvulationDate = document.getElementById('stat-ovulation-date');

    if (statDaysNextPeriod) {
      if (status.isLate) {
        statDaysNextPeriod.textContent = `${status.daysLate}d late`;
      } else if (status.daysUntilNextPeriod != null) {
        statDaysNextPeriod.textContent = `${status.daysUntilNextPeriod} ${status.daysUntilNextPeriod === 1 ? 'day' : 'days'}`;
      } else {
        statDaysNextPeriod.textContent = '—';
      }
    }
    if (statPeriodStartDate && status.nextPeriodStart) {
      const nextDate = parseDateKey(status.nextPeriodStart);
      statPeriodStartDate.textContent = nextDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }
    if (statOvulationDate && status.nextOvulationDate) {
      if (status.isOvulationDay) {
        statOvulationDate.textContent = 'Today';
      } else {
        const ovDate = parseDateKey(status.nextOvulationDate);
        statOvulationDate.textContent = ovDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      }
    }

    // 7. Reset Today button callback
    if (resetTodayBtn) {
      resetTodayBtn.onclick = () => {
        this.renderCycleDial(status, profile, onDaySelect);
      };
    }

    // 8. Horizon Legend interactive clicks
    document.querySelectorAll('.wheel-legend-pill').forEach(pill => {
      pill.onclick = () => {
        const phaseKey = pill.getAttribute('data-phase');
        const win = windows[phaseKey];
        if (!win || win.count <= 0) return;

        const targetDay = phaseKey === 'ovulatory'
          ? ovulationDay
          : Math.floor((win.startDay + win.endDay) / 2);
        this.inspectDialDay(targetDay, profile, status, onDaySelect);
      };
    });
  }

  /**
   * Inspect a specific day around the wheel
   */
  inspectDialDay(dayNumber, profile, todayStatus, onDaySelect = null) {
    const meta = this._getPhaseWindows(todayStatus, profile);
    const { totalDays, periodLength, ovulationDay, fertileStart, fertileEnd } = meta;

    let phase = PHASES.LUTEAL;
    if (dayNumber <= periodLength) phase = PHASES.MENSTRUAL;
    else if (dayNumber < fertileStart) phase = PHASES.FOLLICULAR;
    else if (dayNumber <= fertileEnd) phase = PHASES.OVULATORY;

    const isToday = dayNumber === todayStatus.cycleDay && !todayStatus.isLate;

    if (isToday) {
      this.renderCycleDial(todayStatus, profile, onDaySelect);
      return;
    }

    // Update rings, active halo, orbital bead, pips, and legend pills to inspected day
    this._updateDialVisuals({
      activeDay: dayNumber,
      activePhaseKey: phase.key,
      meta,
      isLate: false
    });

    const dialDayNumber = document.getElementById('dial-day-number');
    const dialTotalDays = document.getElementById('dial-total-days');
    const dialPhaseTitle = document.getElementById('dial-phase-title');
    const dialFertilityBadge = document.getElementById('dial-fertility-badge');
    const dialCountdownPill = document.getElementById('dial-countdown-pill');
    const dialCycleTag = document.getElementById('dial-cycle-tag');
    const resetTodayBtn = document.getElementById('btn-dial-reset-today');

    if (dialDayNumber) dialDayNumber.textContent = dayNumber;
    if (dialTotalDays) dialTotalDays.textContent = `/ ${totalDays} days`;
    if (dialCycleTag) dialCycleTag.textContent = `DAY ${dayNumber} PREVIEW`;
    if (resetTodayBtn) {
      resetTodayBtn.style.display = 'inline-flex';
      resetTodayBtn.onclick = () => {
        this.renderCycleDial(todayStatus, profile, onDaySelect);
      };
    }

    if (dialPhaseTitle) {
      dialPhaseTitle.innerHTML = `${phaseIconSvg(phase.key, 15, 'phase-title-icon')}<span>${escapeHtml(phase.name)}</span>`;
      dialPhaseTitle.style.color = phase.color;
    }

    if (dialFertilityBadge) {
      let fertilityText = 'Est. Low';
      let badgeClass = 'fertility-low';
      if (dayNumber === ovulationDay) {
        fertilityText = 'Est. Peak (Ovulation)';
        badgeClass = 'fertility-peak';
      } else if (dayNumber >= fertileStart && dayNumber <= fertileEnd) {
        fertilityText = 'Est. High';
        badgeClass = 'fertility-high';
      }
      dialFertilityBadge.className = `dial-fertility-badge ${badgeClass}`;
      dialFertilityBadge.title = 'Calendar estimate only — not a method of contraception.';
      dialFertilityBadge.innerHTML = `<span class="badge-dot"></span> ${escapeHtml(fertilityText)}`;
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

    const hour = new Date().getHours();
    const timeGreeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    const greetingText = profile.userName ? `${timeGreeting}, ${profile.userName}` : timeGreeting;
    if (bannerName) {
      bannerName.textContent = greetingText;
    }
    if (headerGreeting) {
      headerGreeting.textContent = greetingText;
    }

    if (bannerPhaseText) {
      bannerPhaseText.textContent = status.isLate
        ? `${status.phase.name} • ${status.daysLate}d overdue`
        : `${status.phase.name} • Day ${status.cycleDay}`;
    }

    if (bannerFertility) {
      bannerFertility.title = 'Calendar estimate only — not contraception.';
      bannerFertility.textContent = status.isLate
        ? 'Late Cycle • Not contraception'
        : status.isOvulationDay
          ? 'Est. Ovulation • Not contraception'
          : status.isFertileWindow
            ? 'Est. Fertile Window • Not contraception'
            : `${status.fertilityChance} • Not contraception`;
    }

    // 2. Timeline Ribbon Active Cursor & Phase Accent Sync
    const timelineRibbon = document.getElementById('cycle-timeline-ribbon') || document.querySelector('.cycle-timeline-ribbon');
    if (timelineRibbon) {
      timelineRibbon.setAttribute('data-phase', status.phase?.key || 'ovulatory');
    }
    const cursor = document.getElementById('timeline-active-cursor');
    if (cursor) {
      const totalDays = Math.max(15, Number(status?.cycleLength || profile?.cycleLength || 28));
      const clampedDay = status.cycleDay ? Math.min(Math.max(status.cycleDay, 1), totalDays) : 1;
      const pct = Math.min(Math.max(((clampedDay - 0.5) / totalDays) * 100, 4), 96);
      cursor.style.left = `${pct.toFixed(2)}%`;
      cursor.title = status.isLate
        ? `Period ${status.daysLate} ${status.daysLate === 1 ? 'day' : 'days'} late`
        : `You are here: Day ${status.cycleDay ?? 1}`;
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

      if (dayItem.hasLoggedFlow || dayItem.status.isPeriodDay) {
        cell.classList.add('period-day');
        if (dayItem.isPredictedPeriod) cell.classList.add('predicted-day');
      } else if (dayItem.status.isLate) {
        cell.classList.add('late-day');
      } else if (dayItem.status.isOvulationDay) {
        cell.classList.add('ovulation-day');
      } else if (dayItem.status.isFertileWindow) {
        cell.classList.add('fertile-day');
      }

      // Build inner cell markup with crisp vector icons
      let badgeHtml = '';
      if (dayItem.hasLoggedFlow) {
        badgeHtml = `<span class="indicator-badge badge-period" title="Logged Period Flow"><span class="badge-icon">${svgIcon('droplet', 11)}</span><span class="badge-text">Logged</span></span>`;
      } else if (dayItem.isPredictedPeriod || dayItem.status.isPeriodDay) {
        badgeHtml = `<span class="indicator-badge badge-period" style="opacity:0.75;" title="Estimated Period Day"><span class="badge-icon">${svgIcon('droplet', 11)}</span><span class="badge-text">Est. Period</span></span>`;
      } else if (dayItem.status.isLate) {
        badgeHtml = `<span class="indicator-badge" title="Period Late (Day +${dayItem.status.daysLate})"><span class="badge-icon">${svgIcon('hourglass', 11)}</span><span class="badge-text">Late</span></span>`;
      } else if (dayItem.status.isOvulationDay) {
        badgeHtml = `<span class="indicator-badge badge-ovulation" title="Estimated Ovulation (not contraception)"><span class="badge-icon">${svgIcon('sparkles', 11)}</span><span class="badge-text">Est. Ov.</span></span>`;
      } else if (dayItem.status.isFertileWindow) {
        badgeHtml = `<span class="indicator-badge badge-fertile" title="Estimated Fertile Window (not contraception)"><span class="badge-icon">${svgIcon('sprout', 11)}</span><span class="badge-text">Est. Fertile</span></span>`;
      }

      const symptomDotHtml = dayItem.hasSymptoms ? `<span class="badge-symptom-dot" title="Logged symptoms/notes"></span>` : '';
      const phaseDotHtml = dayItem.status.isBeforeHistory
        ? ''
        : `<span class="day-phase-dot" style="background-color: ${dayItem.status.phase.color}"></span>`;

      cell.innerHTML = `
        <div class="day-cell-top">
          <span class="day-number">${dayItem.dayNumber}</span>
          ${phaseDotHtml}
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
        refreshBtn.innerHTML = `<span class="refresh-icon spinning">${svgIcon('refresh', 14)}</span> <span class="refresh-text">Refreshing Insights...</span>`;
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
      refreshBtn.innerHTML = `<span class="refresh-icon">${svgIcon('refresh', 14)}</span> <span class="refresh-text">Refresh Insights</span>`;
    }

    // Default hormone description and energy capacity by phase
    const defaultHormones = {
      menstrual: 'Estrogen & progesterone at baseline • Uterine lining shedding',
      follicular: 'FSH stimulates follicle recruitment • Estrogen steadily rising',
      ovulatory: 'Estrogen peak • LH surge triggering follicle release',
      luteal: 'Progesterone rises from corpus luteum, then tapers before next period',
      late: 'Cycle duration can vary naturally with stress, travel, sleep, or hormonal shifts'
    };

    const defaultEnergy = {
      menstrual: 'Restorative & Gentle',
      follicular: 'Rising & Creative',
      ovulatory: 'Vibrant & Social',
      luteal: 'Grounded & Steady',
      late: 'Gentle & Mindful'
    };

    if (phaseTitleEl) {
      phaseTitleEl.innerHTML = `${phaseIconSvg(status.phase.key, 20, 'phase-title-icon')}<span>${escapeHtml(insights?.title || guide.title)}</span>`;
    }
    if (phaseTaglineEl) {
      phaseTaglineEl.textContent = insights?.tagline || status.phase.tagline;
    }
    if (hormoneDescEl) {
      hormoneDescEl.textContent = insights?.hormoneSnapshot || defaultHormones[status.phase.key] || 'Natural cycle rhythm in progress';
    }
    if (energyDescEl) {
      energyDescEl.textContent = insights?.energyCapacity || defaultEnergy[status.phase.key] || 'Steady daily rhythm';
    }

    // Render lists safely (escaped to prevent AI-driven XSS)
    const foods = (insights && Array.isArray(insights.foods) && insights.foods.length > 0) ? insights.foods : guide.foods;
    const workouts = (insights && Array.isArray(insights.workouts) && insights.workouts.length > 0) ? insights.workouts : guide.workouts;
    const mindset = (insights && Array.isArray(insights.mindset) && insights.mindset.length > 0) ? insights.mindset : guide.mindset;

    if (nutritionListEl) {
      nutritionListEl.innerHTML = foods.map(item => `<li><span class="sync-item-bullet">${svgIcon('check', 13)}</span><span>${escapeHtml(item)}</span></li>`).join('');
    }

    if (workoutListEl) {
      workoutListEl.innerHTML = workouts.map(item => `<li><span class="sync-item-bullet">${svgIcon('check', 13)}</span><span>${escapeHtml(item)}</span></li>`).join('');
    }

    if (mindsetListEl) {
      mindsetListEl.innerHTML = mindset.map(item => `<li><span class="sync-item-bullet">${svgIcon('check', 13)}</span><span>${escapeHtml(item)}</span></li>`).join('');
    }

    if (partnerNoteEl) {
      partnerNoteEl.textContent = insights?.partnerTip || guide.partnerTip;
    }

    if (scientificWhyEl) {
      if (insights?.scientificWhy) {
        scientificWhyEl.innerHTML = `
          <div class="ai-scientific-pill">
            <span class="scientific-pill-icon">${svgIcon('activity', 14)}</span> <strong>Wellness Context:</strong> ${escapeHtml(insights.scientificWhy)}
          </div>
        `;
      } else {
        scientificWhyEl.innerHTML = `
          <div class="ai-scientific-pill">
            <span class="scientific-pill-icon">${svgIcon('activity', 14)}</span> <strong>Phase Overview:</strong> General wellness ideas for the ${escapeHtml(status.phase.name)} (educational only, not medical advice).
          </div>
        `;
      }
    }
  }


  /**
   * Render History & Analytics Screen (uses real logged history averages when available)
   */
  renderHistoryAnalytics(profile, logs) {
    const avgCycleEl = document.getElementById('metric-avg-cycle');
    const avgPeriodEl = document.getElementById('metric-avg-period');
    const totalLoggedEl = document.getElementById('metric-total-logged');
    const timelineListEl = document.getElementById('cycle-timeline-list');

    const stats = computeCycleStats(logs, profile);
    if (avgCycleEl) {
      avgCycleEl.textContent = `${stats.averageCycleLength}d`;
      avgCycleEl.title = stats.hasHistoricalCycleAvg
        ? `Computed from ${stats.recordedCyclesCount} logged cycle interval(s)`
        : 'Based on your profile setting (log 2+ periods to auto-learn)';
    }
    if (avgPeriodEl) {
      avgPeriodEl.textContent = `${stats.averagePeriodLength}d`;
      avgPeriodEl.title = stats.hasHistoricalPeriodAvg
        ? `Computed from ${stats.recordedPeriodsCount} completed logged period(s)`
        : 'Based on your profile setting (log 2+ completed multi-day periods to auto-learn)';
    }

    const logKeys = Object.keys(logs || {});
    if (totalLoggedEl) totalLoggedEl.textContent = logKeys.length;

    if (timelineListEl) {
      timelineListEl.innerHTML = '';

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

        const flowTag = item.flow && item.flow !== 'none'
          ? `<span class="pill-tag" style="background: rgba(255,107,139,0.2); color: var(--color-rose); display: inline-flex; align-items: center; gap: 0.25rem;">${svgIcon('droplet', 11)} ${escapeHtml(item.flow)}</span>`
          : '';
        const moodTags = (item.moods || []).map(m => `<span class="pill-tag" style="background: rgba(132,94,194,0.2); color: var(--color-fuchsia);">${escapeHtml(m)}</span>`).join(' ');
        const symptomTags = (item.symptoms || []).map(s => `<span class="pill-tag" style="background: rgba(0,201,167,0.15); color: var(--color-teal);">${escapeHtml(s)}</span>`).join(' ');

        row.innerHTML = `
          <div class="timeline-dates">
            <span class="timeline-dates-main">${escapeHtml(dateFormatted)}</span>
            <span class="timeline-dates-sub">${item.notes ? `"${escapeHtml(item.notes)}"` : 'Daily log entry'}</span>
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
