/**
 * AifyCycle - Cycle Engine
 * Handles period calculations, phase detection, ovulation, fertility windows,
 * and cycle analytics.
 */

export const PHASES = {
  MENSTRUAL: {
    key: 'menstrual',
    name: 'Menstrual Phase',
    shortName: 'Menstrual',
    color: '#FF6B8B',
    bgGradient: 'linear-gradient(135deg, #FF6B8B, #FF8E53)',
    icon: '🩸',
    energy: 'Restorative & Gentle',
    tagline: 'Time to rest, nourish, and reset.',
    description: 'Hormone levels (estrogen & progesterone) are at their baseline. Prioritize rest, warm meals, hydration, and gentle stretching.'
  },
  FOLLICULAR: {
    key: 'follicular',
    name: 'Follicular Phase',
    shortName: 'Follicular',
    color: '#845EC2',
    bgGradient: 'linear-gradient(135deg, #845EC2, #D65DB1)',
    icon: '🌱',
    energy: 'Rising & Creative',
    tagline: 'Energy, motivation, and creativity are surging.',
    description: 'Estrogen is steadily increasing to thicken the uterine lining and mature a follicle. Great time for learning, cardio, and fresh ideas.'
  },
  OVULATORY: {
    key: 'ovulatory',
    name: 'Ovulatory Phase',
    shortName: 'Ovulation',
    color: '#FF9671',
    bgGradient: 'linear-gradient(135deg, #FF9671, #FFC75F)',
    icon: '✨',
    energy: 'Peak Vitality & Magnetic',
    tagline: 'Peak confidence, stamina, and fertility.',
    description: 'Estrogen peaks and luteinizing hormone (LH) triggers egg release. Communication, libido, and strength training thrive now.'
  },
  LUTEAL: {
    key: 'luteal',
    name: 'Luteal Phase',
    shortName: 'Luteal',
    color: '#008E9B',
    bgGradient: 'linear-gradient(135deg, #2C73D2, #008E9B)',
    icon: '🌙',
    energy: 'Grounded & Intuitive',
    tagline: 'Turning inward with mindful completion.',
    description: 'Progesterone rises to support potential pregnancy, then tapers. Metabolism slightly speeds up; focus on magnesium-rich foods and steady endurance.'
  }
};

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
 * Get comprehensive cycle status for a specific target date
 * @param {Date|string} targetDate
 * @param {Object} profile - { cycleLength, periodLength, lastPeriodStart }
 */
export function getCycleStatus(targetDate, profile) {
  const target = typeof targetDate === 'string' ? parseDateKey(targetDate) : new Date(targetDate);
  const lastPeriod = typeof profile.lastPeriodStart === 'string' 
    ? parseDateKey(profile.lastPeriodStart) 
    : new Date(profile.lastPeriodStart);

  const cycleLength = profile.cycleLength || 28;
  const periodLength = profile.periodLength || 5;

  // Days since last period start
  const diffDays = daysBetween(lastPeriod, target);
  
  // Normalized cycle day (1 to cycleLength)
  let cycleDay = (diffDays % cycleLength);
  if (cycleDay < 0) {
    cycleDay = cycleLength + cycleDay;
  }
  cycleDay = cycleDay + 1; // 1-indexed

  // Estimated Ovulation Day: typically cycleLength - 14
  const ovulationDay = Math.max(cycleLength - 14, periodLength + 2);

  // Fertile window: 5 days before ovulation up to 1 day after
  const fertileStart = ovulationDay - 5;
  const fertileEnd = ovulationDay + 1;

  // Determine phase
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

  // Fertility Chance Level
  let fertilityChance = 'Low';
  let fertilityBadgeClass = 'fertility-low';
  if (cycleDay === ovulationDay) {
    fertilityChance = 'Peak (Ovulation)';
    fertilityBadgeClass = 'fertility-peak';
  } else if (cycleDay >= fertileStart && cycleDay <= fertileEnd) {
    fertilityChance = 'High Chance';
    fertilityBadgeClass = 'fertility-high';
  } else if (cycleDay === fertileStart - 1 || cycleDay === fertileEnd + 1) {
    fertilityChance = 'Moderate Chance';
    fertilityBadgeClass = 'fertility-medium';
  }

  // Days until next period
  const daysUntilNextPeriod = cycleLength - cycleDay + 1;

  // Next predicted period start date
  const cyclesPassed = Math.floor(diffDays / cycleLength);
  const currentCycleStart = addDays(lastPeriod, cyclesPassed * cycleLength);
  const nextPeriodStart = addDays(currentCycleStart, cycleLength);
  const nextOvulationDate = addDays(currentCycleStart, ovulationDay - 1);

  // Calculate percentage of cycle completed
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
  // month is 0-indexed (0 = Jan, 11 = Dec)
  const firstDayOfMonth = new Date(year, month, 1);
  const lastDayOfMonth = new Date(year, month + 1, 0);
  const daysInMonth = lastDayOfMonth.getDate();

  const days = [];

  for (let day = 1; day <= daysInMonth; day++) {
    const dateObj = new Date(year, month, day);
    const dateKey = formatDateKey(dateObj);
    const status = getCycleStatus(dateObj, profile);
    const userLog = logs[dateKey] || null;

    days.push({
      date: dateObj,
      dateKey,
      dayNumber: day,
      dayOfWeek: dateObj.getDay(),
      status,
      log: userLog,
      hasSymptoms: userLog && ((userLog.symptoms && userLog.symptoms.length > 0) || (userLog.moods && userLog.moods.length > 0) || userLog.notes),
      flow: userLog?.flow || (status.isPeriodDay ? 'medium' : null)
    });
  }

  return days;
}

/**
 * Cycle syncing recommendations by phase
 */
export const CYCLE_SYNCING_GUIDE = {
  menstrual: {
    title: 'Menstrual Phase (Winter Inner Season)',
    foods: ['Iron-rich leafy greens (spinach, kale)', 'Warm bone or veggie broths', 'Berries and dark chocolate', 'Chamomile and ginger tea'],
    workouts: ['Gentle restorative yoga', 'Leisurely nature walks', 'Full body passive stretching', 'Plenty of restorative naps'],
    mindset: ['Journaling and reflection', 'Setting intentions for the new cycle', 'Prioritizing quiet boundary time', 'Decluttering workspace'],
    partnerTip: 'Aify’s Care Note: Bring Agatha a warm beverage, cozy blanket, and ask how her comfort levels are today. Gentle back or foot massages work wonders!'
  },
  follicular: {
    title: 'Follicular Phase (Spring Inner Season)',
    foods: ['Fermented foods (kimchi, sauerkraut)', 'Light colorful salads and avocados', 'Sprouted grains and pumpkin seeds', 'Lean proteins & citrus'],
    workouts: ['Cardio and upbeat dance classes', 'High-tempo hiking or jogging', 'Novel group fitness workouts', 'Vinyasa flow yoga'],
    mindset: ['Brainstorming new creative ideas', 'Starting ambitious projects', 'Planning exciting travel or dates', 'Social networking and socializing'],
    partnerTip: 'Aify’s Care Note: Agatha’s creative inspiration and playful spark are blooming! Plan a spontaneous date night or try a fun new hobby together.'
  },
  ovulatory: {
    title: 'Ovulatory Phase (Summer Inner Season)',
    foods: ['Cruciferous vegetables (broccoli, cabbage)', 'Berries, figs, and chia seeds', 'Light proteins (salmon, quinoa)', 'Ample cool electrolyte water'],
    workouts: ['High-Intensity Interval Training (HIIT)', 'Challenging strength training / weight lifting', 'Fast-paced running', 'Group sports'],
    mindset: ['Public speaking and leadership', 'Having heartfelt, meaningful conversations', 'Peak social charisma and confidence', 'Celebrating accomplishments'],
    partnerTip: 'Aify’s Care Note: Peak energy and radiant confidence day! Compliment her glow, dress up, and celebrate her magnetic vibe.'
  },
  luteal: {
    title: 'Luteal Phase (Autumn Inner Season)',
    foods: ['Complex carbs (sweet potatoes, brown rice)', 'Magnesium foods (dark chocolate, pumpkin seeds)', 'Warm soups and roasted veggies', 'Peppermint tea to ease bloating'],
    workouts: ['Pilates and strength-maintenance', 'Brisk low-impact walking', 'Slow resistance band work', 'Mindful breathing sessions'],
    mindset: ['Organizing, finishing ongoing tasks', 'Editing and detail-oriented focus', 'Creating a cozy sanctuary at home', 'Honoring honest emotions'],
    partnerTip: 'Aify’s Care Note: Agatha might experience fluctuating energy or food cravings. Stock up on her favorite healthy treats, run a warm bath, and give her extra reassurance.'
  }
};
