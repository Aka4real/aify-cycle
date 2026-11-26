/**
 * AifyCycle - Cycle Engine
 * Pure functions for period run extraction, historical cycle statistics,
 * late-period detection, phase estimation, and calendar mapping.
 */

export const PHASES = {
  MENSTRUAL: {
    key: 'menstrual',
    name: 'Menstrual Phase',
    shortName: 'Menstrual',
    color: '#C4324E',
    bgGradient: 'linear-gradient(135deg, #C4324E, #E35D75)',
    icon: '',
    energy: 'Restorative and gentle',
    tagline: 'Time to rest, nourish, and reset.',
    description: 'Estrogen and progesterone are near their baseline. Prioritize rest, warm meals, hydration, and gentle movement.'
  },
  FOLLICULAR: {
    key: 'follicular',
    name: 'Follicular Phase',
    shortName: 'Follicular',
    color: '#227A58',
    bgGradient: 'linear-gradient(135deg, #1E6E50, #43A47E)',
    icon: '',
    energy: 'Rising and creative',
    tagline: 'Energy, motivation, and focus are rising.',
    description: 'Estrogen rises steadily as a follicle matures. Many people feel comfortable ramping up cardio, learning, and creative work.'
  },
  OVULATORY: {
    key: 'ovulatory',
    name: 'Ovulatory Phase',
    shortName: 'Ovulation',
    color: '#BF710E',
    bgGradient: 'linear-gradient(135deg, #BF710E, #EBA335)',
    icon: '',
    energy: 'Vibrant and social',
    tagline: 'Estimated peak fertility window and strong vitality.',
    description: 'Estrogen peaks and luteinizing hormone (LH) triggers egg release. Calendar estimates are approximate and not a substitute for contraception.'
  },
  LUTEAL: {
    key: 'luteal',
    name: 'Luteal Phase',
    shortName: 'Luteal',
    color: '#285C8E',
    bgGradient: 'linear-gradient(135deg, #23507B, #4A85BC)',
    icon: '',
    energy: 'Grounded and steady',
    tagline: 'Turning inward with steady, mindful pacing.',
    description: 'Progesterone rises and later tapers if pregnancy does not occur. Focus on steady movement, balanced meals, hydration, and sleep.'
  },
  LATE: {
    key: 'late',
    name: 'Period Late',
    shortName: 'Late',
    color: '#A85334',
    bgGradient: 'linear-gradient(135deg, #A85334, #D98A68)',
    icon: '',
    energy: 'Gentle and mindful',
    tagline: 'Your period has not been logged yet past your typical cycle length.',
    description: 'Normal cycle variation can come from stress, travel, sleep shifts, or illness. Log your period when it begins, or consider a pregnancy test or speaking with a clinician if unexpectedly delayed.'
  }
};

const PERIOD_FLOWS = new Set(['light', 'medium', 'heavy']);
const BLEEDING_FLOWS = new Set(['spotting', 'light', 'medium', 'heavy']);

/**
 * Format a Date object as YYYY-MM-DD in local time
 */
export function formatDateKey(date) {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Parse a YYYY-MM-DD string into a local Date object (midnight local time)
 */
export function parseDateKey(str) {
  const [year, month, day] = str.split('-').map(Number);
  return new Date(year, month - 1, day);
}

/**
 * Add days to a date without mutation
 */
export function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

/**
 * Difference in calendar days between two dates (date2 - date1)
 */
export function daysBetween(date1, date2) {
  const d1 = new Date(date1.getFullYear(), date1.getMonth(), date1.getDate());
  const d2 = new Date(date2.getFullYear(), date2.getMonth(), date2.getDate());
  const diffTime = d2.getTime() - d1.getTime();
  return Math.round(diffTime / (1000 * 60 * 60 * 24));
}

/**
 * Extract contiguous menstrual period runs from daily logs.
 * Groups flow days separated by <= 2 gap days and excludes isolated spotting-only days.
 * Returns array sorted oldest -> newest: [{ startDateKey, endDateKey, length }]
 */
export function extractPeriodRuns(logs = {}) {
  if (!logs || typeof logs !== 'object') return [];

  const bleedingKeys = Object.entries(logs)
    .filter(([key, val]) => /^\d{4}-\d{2}-\d{2}$/.test(key) && val && BLEEDING_FLOWS.has(val.flow))
    .map(([key, val]) => ({ key, date: parseDateKey(key), flow: val.flow }))
    .sort((a, b) => a.date - b.date);

  if (bleedingKeys.length === 0) return [];

  const runs = [];
  let current = {
    start: bleedingKeys[0].date,
    startKey: bleedingKeys[0].key,
    end: bleedingKeys[0].date,
    endKey: bleedingKeys[0].key,
    hasTrueFlow: PERIOD_FLOWS.has(bleedingKeys[0].flow)
  };

  for (let i = 1; i < bleedingKeys.length; i++) {
    const item = bleedingKeys[i];
    const gap = daysBetween(current.end, item.date);
    if (gap <= 2) {
      current.end = item.date;
      current.endKey = item.key;
      if (PERIOD_FLOWS.has(item.flow)) current.hasTrueFlow = true;
    } else {
      if (current.hasTrueFlow) {
        runs.push({
          startDateKey: current.startKey,
          endDateKey: current.endKey,
          length: daysBetween(current.start, current.end) + 1
        });
      }
      current = {
        start: item.date,
        startKey: item.key,
        end: item.date,
        endKey: item.key,
        hasTrueFlow: PERIOD_FLOWS.has(item.flow)
      };
    }
  }

  if (current.hasTrueFlow) {
    runs.push({
      startDateKey: current.startKey,
      endDateKey: current.endKey,
      length: daysBetween(current.start, current.end) + 1
    });
  }

  return runs;
}

/**
 * Compute real historical cycle statistics from logs (falling back to profile settings)
 */
export function computeCycleStats(logs = {}, profile = {}) {
  const runs = extractPeriodRuns(logs);
  const intervals = [];

  for (let i = 1; i < runs.length; i++) {
    const diff = daysBetween(parseDateKey(runs[i - 1].startDateKey), parseDateKey(runs[i].startDateKey));
    if (diff >= 18 && diff <= 60) {
      intervals.push(diff);
    }
  }

  const recentIntervals = intervals.slice(-6);
  const hasHistoricalCycleAvg = recentIntervals.length >= 1;
  const averageCycleLength = hasHistoricalCycleAvg
    ? Math.round(recentIntervals.reduce((a, b) => a + b, 0) / recentIntervals.length)
    : (profile.cycleLength || 28);

  const recentPeriodLengths = runs.slice(-6).map(r => r.length).filter(len => len >= 1 && len <= 12);
  const hasHistoricalPeriodAvg = recentPeriodLengths.length >= 1;
  const averagePeriodLength = hasHistoricalPeriodAvg
    ? Math.round(recentPeriodLengths.reduce((a, b) => a + b, 0) / recentPeriodLengths.length)
    : (profile.periodLength || 5);

  let variabilityDays = 0;
  if (recentIntervals.length >= 2) {
    variabilityDays = Math.max(...recentIntervals) - Math.min(...recentIntervals);
  }

  const latestPeriodStart = runs.length > 0 ? runs[runs.length - 1].startDateKey : null;
  const earliestPeriodStart = runs.length > 0 ? runs[0].startDateKey : null;

  return {
    runs,
    recordedCyclesCount: recentIntervals.length,
    averageCycleLength,
    averagePeriodLength,
    variabilityDays,
    hasHistoricalCycleAvg,
    hasHistoricalPeriodAvg,
    latestPeriodStart,
    earliestPeriodStart
  };
}

/**
 * Get comprehensive cycle status for a specific target date.
 * Detects late periods instead of modulo-wrapping into a fake Menstrual Phase.
 */
export function getCycleStatus(targetDate, profile, logs = null, options = {}) {
  const target = typeof targetDate === 'string' ? parseDateKey(targetDate) : new Date(targetDate);
  const referenceDate = options.referenceDate
    ? (typeof options.referenceDate === 'string' ? parseDateKey(options.referenceDate) : new Date(options.referenceDate))
    : new Date();

  const stats = logs ? computeCycleStats(logs, profile) : null;
  const cycleLength = stats?.hasHistoricalCycleAvg ? stats.averageCycleLength : (profile.cycleLength || 28);
  const periodLength = stats?.hasHistoricalPeriodAvg ? stats.averagePeriodLength : (profile.periodLength || 5);

  let anchorStr = profile.lastPeriodStart || formatDateKey(referenceDate);
  if (stats?.latestPeriodStart && parseDateKey(stats.latestPeriodStart) > parseDateKey(anchorStr)) {
    anchorStr = stats.latestPeriodStart;
  }
  const lastPeriod = typeof anchorStr === 'string' ? parseDateKey(anchorStr) : new Date(anchorStr);

  const diffDays = daysBetween(lastPeriod, target);
  const refDiffDays = daysBetween(lastPeriod, referenceDate);
  const ovulationDay = Math.max(cycleLength - 14, periodLength + 2);
  const fertileStart = Math.max(ovulationDay - 5, periodLength + 1);
  const fertileEnd = Math.min(ovulationDay + 1, cycleLength - 1);

  // 1. Date before earliest known cycle history
  const earliestAnchor = stats?.earliestPeriodStart && parseDateKey(stats.earliestPeriodStart) < lastPeriod
    ? parseDateKey(stats.earliestPeriodStart)
    : lastPeriod;

  if (daysBetween(earliestAnchor, target) < 0) {
    return {
      targetDate: formatDateKey(target),
      cycleDay: null,
      cycleLength,
      periodLength,
      phase: PHASES.FOLLICULAR,
      ovulationDay,
      isPeriodDay: false,
      isOvulationDay: false,
      isFertileWindow: false,
      isLate: false,
      daysLate: 0,
      isPredicted: false,
      isBeforeHistory: true,
      fertilityChance: 'No Data',
      fertilityBadgeClass: 'fertility-low',
      daysUntilNextPeriod: null,
      nextPeriodStart: formatDateKey(addDays(lastPeriod, cycleLength)),
      nextOvulationDate: formatDateKey(addDays(lastPeriod, ovulationDay - 1)),
      progressPercent: 0
    };
  }

  // 2. Late-period detection (past expected cycle end and on/before today without new period logged)
  const isTargetOnOrBeforeToday = daysBetween(referenceDate, target) <= 0;
  if (diffDays >= cycleLength && isTargetOnOrBeforeToday) {
    const daysLate = diffDays - cycleLength + 1;
    return {
      targetDate: formatDateKey(target),
      cycleDay: diffDays + 1,
      cycleLength,
      periodLength,
      phase: PHASES.LATE,
      ovulationDay,
      isPeriodDay: false,
      isOvulationDay: false,
      isFertileWindow: false,
      isLate: true,
      daysLate,
      isPredicted: false,
      isBeforeHistory: false,
      fertilityChance: 'Uncertain (Late)',
      fertilityBadgeClass: 'fertility-medium',
      daysUntilNextPeriod: 0,
      nextPeriodStart: formatDateKey(addDays(lastPeriod, cycleLength)),
      nextOvulationDate: formatDateKey(addDays(lastPeriod, ovulationDay - 1)),
      progressPercent: 100
    };
  }

  // 3. Past historical day between earliest logged run and lastPeriod
  if (diffDays < 0 && stats?.runs?.length > 0) {
    const targetKey = formatDateKey(target);
    const matchingRun = [...stats.runs].reverse().find(r => parseDateKey(r.startDateKey) <= target);
    const runStart = matchingRun ? parseDateKey(matchingRun.startDateKey) : earliestAnchor;
    const histDay = daysBetween(runStart, target) + 1;
    const targetLog = logs?.[targetKey];
    const loggedBleeding = Boolean(targetLog && BLEEDING_FLOWS.has(targetLog.flow));

    let histPhase = PHASES.LUTEAL;
    if (loggedBleeding || histDay <= periodLength) histPhase = PHASES.MENSTRUAL;
    else if (histDay < fertileStart) histPhase = PHASES.FOLLICULAR;
    else if (histDay <= fertileEnd) histPhase = PHASES.OVULATORY;

    return {
      targetDate: targetKey,
      cycleDay: histDay,
      cycleLength,
      periodLength,
      phase: histPhase,
      ovulationDay,
      isPeriodDay: loggedBleeding,
      isOvulationDay: histDay === ovulationDay,
      isFertileWindow: histDay >= fertileStart && histDay <= fertileEnd,
      isLate: false,
      daysLate: 0,
      isPredicted: false,
      isBeforeHistory: false,
      fertilityChance: histDay === ovulationDay ? 'Est. Peak (Ovulation)' : (histDay >= fertileStart && histDay <= fertileEnd ? 'Est. High' : 'Est. Low'),
      fertilityBadgeClass: histDay === ovulationDay ? 'fertility-peak' : (histDay >= fertileStart && histDay <= fertileEnd ? 'fertility-high' : 'fertility-low'),
      daysUntilNextPeriod: Math.max(0, cycleLength - histDay + 1),
      nextPeriodStart: formatDateKey(addDays(runStart, cycleLength)),
      nextOvulationDate: formatDateKey(addDays(runStart, ovulationDay - 1)),
      progressPercent: Math.min(100, Math.round((histDay / cycleLength) * 100))
    };
  }

  // 4. Current cycle or future predicted cycle
  const isPredicted = diffDays >= cycleLength || daysBetween(referenceDate, target) > 0;
  const effectiveDiff = refDiffDays >= cycleLength && daysBetween(referenceDate, target) > 0
    ? daysBetween(addDays(referenceDate, 1), target)
    : diffDays;

  let cycleDay = (effectiveDiff % cycleLength);
  if (cycleDay < 0) cycleDay = cycleLength + cycleDay;
  cycleDay = cycleDay + 1;

  let phase;
  if (cycleDay <= periodLength) {
    phase = PHASES.MENSTRUAL;
  } else if (cycleDay < fertileStart) {
    phase = PHASES.FOLLICULAR;
  } else if (cycleDay <= fertileEnd) {
    phase = PHASES.OVULATORY;
  } else {
    phase = PHASES.LUTEAL;
  }

  let fertilityChance = 'Est. Low';
  let fertilityBadgeClass = 'fertility-low';
  if (cycleDay === ovulationDay) {
    fertilityChance = 'Est. Peak (Ovulation)';
    fertilityBadgeClass = 'fertility-peak';
  } else if (cycleDay >= fertileStart && cycleDay <= fertileEnd) {
    fertilityChance = 'Est. High';
    fertilityBadgeClass = 'fertility-high';
  } else if (cycleDay === fertileStart - 1 || cycleDay === fertileEnd + 1) {
    fertilityChance = 'Est. Moderate';
    fertilityBadgeClass = 'fertility-medium';
  }

  const daysUntilNextPeriod = cycleLength - cycleDay + 1;
  const cyclesPassed = Math.floor(Math.max(0, diffDays) / cycleLength);
  const currentCycleStart = addDays(lastPeriod, cyclesPassed * cycleLength);
  const nextPeriodStart = addDays(currentCycleStart, cycleLength);
  const nextOvulationDate = addDays(currentCycleStart, ovulationDay - 1);
  const progressPercent = Math.min(100, Math.round((cycleDay / cycleLength) * 100));

  return {
    targetDate: formatDateKey(target),
    cycleDay,
    cycleLength,
    periodLength,
    phase,
    ovulationDay,
    isPeriodDay: cycleDay <= periodLength,
    isOvulationDay: cycleDay === ovulationDay,
    isFertileWindow: cycleDay >= fertileStart && cycleDay <= fertileEnd,
    isLate: false,
    daysLate: 0,
    isPredicted,
    isBeforeHistory: false,
    fertilityChance,
    fertilityBadgeClass,
    daysUntilNextPeriod,
    nextPeriodStart: formatDateKey(nextPeriodStart),
    nextOvulationDate: formatDateKey(nextOvulationDate),
    progressPercent
  };
}

/**
 * Generate calendar day metadata for a given month
 */
export function getMonthCycleMap(year, month, profile, logs = {}) {
  const lastDayOfMonth = new Date(year, month + 1, 0);
  const daysInMonth = lastDayOfMonth.getDate();
  const days = [];

  for (let day = 1; day <= daysInMonth; day++) {
    const dateObj = new Date(year, month, day);
    const dateKey = formatDateKey(dateObj);
    const status = getCycleStatus(dateObj, profile, logs);
    const userLog = logs[dateKey] || null;
    const hasLoggedFlow = Boolean(userLog?.flow && userLog.flow !== 'none');

    days.push({
      date: dateObj,
      dateKey,
      dayNumber: day,
      dayOfWeek: dateObj.getDay(),
      status,
      log: userLog,
      hasLoggedFlow,
      isPredictedPeriod: !hasLoggedFlow && status.isPeriodDay && status.isPredicted,
      hasSymptoms: Boolean(
        userLog &&
        ((userLog.symptoms && userLog.symptoms.length > 0) ||
          (userLog.moods && userLog.moods.length > 0) ||
          userLog.notes)
      ),
      flow: userLog?.flow || null
    });
  }

  return days;
}

/**
 * Cycle syncing general wellness recommendations by phase
 */
export const CYCLE_SYNCING_GUIDE = {
  menstrual: {
    title: 'Menstrual Phase (Restorative)',
    foods: ['Iron-rich leafy greens (spinach, kale)', 'Warm soups and broths', 'Berries and dark chocolate', 'Chamomile or ginger herbal tea'],
    workouts: ['Gentle restorative yoga', 'Easy walks outdoors', 'Passive mobility and stretching', 'Extra rest when needed'],
    mindset: ['Journaling and light reflection', 'Setting simple intentions for the cycle', 'Protecting quiet recharge time', 'Keeping commitments manageable'],
    partnerTip: 'Care note: Offer a warm drink, a cozy blanket, or quiet support. Small comforts go a long way during period days.'
  },
  follicular: {
    title: 'Follicular Phase (Rising Energy)',
    foods: ['Colorful salads, avocado, and citrus', 'Fermented foods (yogurt, kimchi, sauerkraut)', 'Whole grains and pumpkin seeds', 'Balanced lean proteins'],
    workouts: ['Cardio or brisk cycling', 'Upbeat dance or group classes', 'Hiking or steady jogging', 'Flow yoga'],
    mindset: ['Brainstorming new ideas', 'Starting fresh projects', 'Planning upcoming outings or goals', 'Connecting with friends or collaborators'],
    partnerTip: 'Care note: Rising energy is a great time to plan an outing, try a new activity, or sketch shared plans together.'
  },
  ovulatory: {
    title: 'Ovulatory Phase (Estimated Peak)',
    foods: ['Cruciferous vegetables (broccoli, greens)', 'Berries, figs, and chia seeds', 'Light balanced proteins (salmon, quinoa, legumes)', 'Plenty of water and electrolytes'],
    workouts: ['Strength training or resistance sessions', 'Higher-intensity interval work if feeling good', 'Fast-paced running or swimming', 'Active group sports'],
    mindset: ['Important conversations and presentations', 'Collaborative work and social plans', 'Celebrating recent wins', 'Channeling high energy intentionally'],
    partnerTip: 'Care note: Social energy and confidence often feel strong around mid-cycle. Enjoy quality time together.'
  },
  luteal: {
    title: 'Luteal Phase (Grounded)',
    foods: ['Complex carbs (sweet potatoes, oats, brown rice)', 'Magnesium-rich snacks (dark chocolate, pumpkin seeds)', 'Warm roasted vegetables and soups', 'Peppermint or ginger tea for comfort'],
    workouts: ['Pilates and steady strength maintenance', 'Brisk low-impact walking', 'Resistance band routines', 'Mindful breathwork and stretching'],
    mindset: ['Wrapping up ongoing projects', 'Detail-oriented organizing and editing', 'Prioritizing consistent bedtime routines', 'Checking in gently with your mood'],
    partnerTip: 'Care note: Energy and mood can fluctuate in the late luteal window. Keep favorite comfort foods handy and offer extra patience.'
  },
  late: {
    title: 'Late Cycle Check-In',
    foods: ['Balanced regular meals to keep blood sugar steady', 'Magnesium-rich foods and leafy greens', 'Warm herbal infusions (ginger, chamomile)', 'Steady hydration throughout the day'],
    workouts: ['Gentle walking or restorative stretching', 'Low-stress movement that feels supportive', 'Avoid overtraining while your body adjusts', 'Prioritize sleep recovery'],
    mindset: ['Take a deep breath, as cycle shifts of a few days are common', 'Note any recent stress, travel, or sleep changes', 'Log your period as soon as bleeding starts', 'Consider a pregnancy test or speaking with a clinician if unexpectedly delayed'],
    partnerTip: 'Care note: A late period can feel stressful. Offer calm reassurance without pressure and support whatever next step feels right.'
  }
};
