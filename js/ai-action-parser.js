/**
 * AifyCycle - Safe Semantic Action Proposal Parser & Validator
 * Pure module (browser & Node testable): parses & validates PROPOSED cycle updates
 * from chat messages and model JSON blocks without mutating storage directly.
 */

import { formatDateKey, parseDateKey, addDays, daysBetween } from './cycle-engine.js';

export const ALLOWED_FLOWS = new Set(['none', 'spotting', 'light', 'medium', 'heavy']);
export const ALLOWED_SYMPTOMS = new Set([
  'Cramps', 'Tender Breasts', 'Headache', 'Bloating',
  'Acne', 'Lower Back Pain', 'Fatigue', 'Nausea'
]);
export const ALLOWED_MOODS = new Set([
  'Calm', 'Happy', 'High Energy', 'Romantic',
  'Sensitive', 'Anxious', 'Irritable', 'Low Energy'
]);
export const ALLOWED_MEMORY_CATEGORIES = new Set([
  'remedy_preference', 'cycle_pattern', 'lifestyle_habit',
  'personal_goal', 'sensitivity_trigger', 'general'
]);

const NAME_STOPWORDS = new Set([
  'later', 'back', 'soon', 'today', 'tomorrow', 'tonight', 'anytime', 'now',
  'when', 'if', 'out', 'up', 'in', 'off', 'over', 'crazy', 'silly', 'maybe',
  'please', 'again', 'here', 'there', 'home', 'down', 'by', 'on', 'at'
]);

const TRIVIAL_PREFERENCE_TARGETS = new Set([
  'you', 'it', 'that', 'this', 'them', 'him', 'her', 'us', 'me', 'aify',
  'talking', 'chatting', 'here', 'this app', 'the app', 'your help'
]);

export function isValidActionDate(dateStr, referenceDate = new Date()) {
  if (typeof dateStr !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const parsed = parseDateKey(dateStr);
  if (Number.isNaN(parsed.getTime()) || formatDateKey(parsed) !== dateStr) return false;
  const diff = daysBetween(referenceDate, parsed);
  // Reject dates more than 1 day in the future or more than 1 year in the past
  return diff <= 1 && diff >= -365;
}

export function isQuestionOrHypothetical(text) {
  if (!text || typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (trimmed.endsWith('?')) return true;
  return /^(?:what\s+if|could\s+(?:my|i)|would\s+(?:my|i)|should\s+i|is\s+it\s+normal|why\s+(?:is|does|do|am|did)|how\s+(?:do|can|long|often)|can\s+i|if\s+my\s+period)\b/i.test(trimmed);
}

export function isNegatedMatch(text, matchIndex) {
  const start = Math.max(0, matchIndex - 32);
  const before = text.slice(start, matchIndex);
  // Only inspect within the same clause (after last punctuation or contrast conjunction)
  const clause = before.split(/[.,;!?]|\b(?:but|though|however|yet)\b/i).pop() || '';
  return /\b(?:no|not|never|without|zero|none|free\s+of|don'?t\s+have|doesn'?t\s+have|didn'?t\s+have|haven'?t\s+had|no\s+more|stopped|no\s+longer)\s*$/i.test(clause.trim())
    || /\b(?:no|not|never|without|zero|don'?t|haven'?t|no\s+more)\b/i.test(clause);
}

export function isRedFlagPain(text) {
  return /\b(?:sharp|severe|agonizing|excruciating|sudden|unbearable|stabbing)\s+(?:pelvic|abdominal|stomach|lower\s+belly)\s+pain\b/i.test(text);
}

/**
 * Extract safe PROPOSED actions from user chat text (never auto-writes)
 */
export function parseProposedActionsFromText(text, referenceDate = new Date()) {
  if (!text || typeof text !== 'string') return [];
  const trimmed = text.trim();
  if (!trimmed || isQuestionOrHypothetical(trimmed)) return [];

  const actions = [];
  const todayKey = formatDateKey(referenceDate);

  // 1. Period Start / Cycle Day 1 (skip negated or hypothetical mentions)
  const periodStartRegex = /(?:my\s+)?(?:period|cycle|bleeding)\s+(?:started|began|came|arrived|is\s+here)|(?:i\s+)?(?:got|started)\s+my\s+period|\bday\s*1\s+of\s+(?:my\s+)?cycle\b/i;
  const periodMatch = trimmed.match(periodStartRegex);
  if (periodMatch && !isNegatedMatch(trimmed, periodMatch.index)) {
    let targetDate = todayKey;
    if (/\byesterday\b/i.test(trimmed)) {
      targetDate = formatDateKey(addDays(referenceDate, -1));
    }

    let flow = 'medium';
    if (/\bheavy\b/i.test(trimmed)) flow = 'heavy';
    else if (/\blight\b/i.test(trimmed)) flow = 'light';
    else if (/\bspotting\b/i.test(trimmed)) flow = 'spotting';

    actions.push({
      type: 'UPDATE_PERIOD_START',
      date: targetDate,
      flow
    });
  }

  // 2. Menstrual Flow
  let detectedFlow = null;
  const flowPatterns = [
    { val: 'heavy', re: /\b(?:heavy\s+(?:flow|bleeding|period)|flow\s+is\s+heavy)\b/i },
    { val: 'medium', re: /\b(?:medium\s+(?:flow|bleeding)|flow\s+is\s+medium)\b/i },
    { val: 'light', re: /\b(?:light\s+(?:flow|bleeding)|flow\s+is\s+light)\b/i },
    { val: 'spotting', re: /\bspotting\b/i }
  ];
  for (const fp of flowPatterns) {
    const m = trimmed.match(fp.re);
    if (m && !isNegatedMatch(trimmed, m.index)) {
      detectedFlow = fp.val;
      break;
    }
  }

  // 3. Physical Symptoms (respect negation & never downgrade emergency red-flag pain to "Cramps")
  const detectedSymptoms = [];
  const redFlag = isRedFlagPain(trimmed);
  const symptomDictionary = [
    { name: 'Cramps', pattern: /\b(?:cramp|cramps|cramping|menstrual\s+pain|period\s+pain|pelvic\s+pain)\b/i },
    { name: 'Tender Breasts', pattern: /\b(?:tender\s+breasts?|sore\s+breasts?|breast\s+tenderness|breast\s+pain|sore\s+nipples)\b/i },
    { name: 'Headache', pattern: /\b(?:headache|headaches|migraine|migraines|head\s+pounding)\b/i },
    { name: 'Bloating', pattern: /\b(?:bloat|bloated|bloating|water\s+retention|puffy\s+belly)\b/i },
    { name: 'Acne', pattern: /\b(?:acne|breakout|breakouts|pimples?|zits?)\b/i },
    { name: 'Lower Back Pain', pattern: /\b(?:lower\s+back\s+pain|back\s+ache|backache|back\s+pain)\b/i },
    { name: 'Fatigue', pattern: /\b(?:fatigue|fatigued|exhausted|exhaustion|so\s+tired|lethargic|drained|no\s+energy)\b/i },
    { name: 'Nausea', pattern: /\b(?:nausea|nauseous|queasy|sick\s+to\s+(?:my\s+)?stomach)\b/i }
  ];

  for (const s of symptomDictionary) {
    if (s.name === 'Cramps' && redFlag) continue;
    const m = trimmed.match(s.pattern);
    if (m && !isNegatedMatch(trimmed, m.index)) {
      detectedSymptoms.push(s.name);
    }
  }

  // 4. Moods (respect negation)
  const detectedMoods = [];
  const moodDictionary = [
    { name: 'Calm', pattern: /\b(?:calm|peaceful|relaxed|centered|serene)\b/i },
    { name: 'Happy', pattern: /\b(?:happy|joyful|great\s+mood|cheerful|good\s+mood)\b/i },
    { name: 'High Energy', pattern: /\b(?:high\s+energy|energized|energetic|productive|buzzing)\b/i },
    { name: 'Romantic', pattern: /\b(?:romantic|loving|intimate|flirty|affectionate)\b/i },
    { name: 'Sensitive', pattern: /\b(?:sensitive|emotional|teary|crying|vulnerable)\b/i },
    { name: 'Anxious', pattern: /\b(?:anxious|anxiety|stressed|stress|overwhelmed|worrying|nervous)\b/i },
    { name: 'Irritable', pattern: /\b(?:irritable|irritated|cranky|moody|grumpy|annoyed|short-tempered)\b/i },
    { name: 'Low Energy', pattern: /\b(?:low\s+energy|sluggish|run\s+down|depleted|foggy)\b/i }
  ];

  for (const mood of moodDictionary) {
    const m = trimmed.match(mood.pattern);
    if (m && !isNegatedMatch(trimmed, m.index)) {
      detectedMoods.push(mood.name);
    }
  }

  // 5. Water & Sleep
  let waterGlasses = null;
  const waterMatch = trimmed.match(/(?:drank|drink|had|log|logged)\s+(\d{1,2})\s*(?:glasses|cups|bottles)/i);
  if (waterMatch) {
    const parsed = parseInt(waterMatch[1], 10);
    if (parsed >= 0 && parsed <= 25) waterGlasses = parsed;
  }

  let sleepHours = null;
  const sleepMatch = trimmed.match(/(?:slept|got)\s+(\d{1,2}(?:\.\d+)?)\s*(?:hours|hrs|h)\b/i);
  if (sleepMatch) {
    const parsed = parseFloat(sleepMatch[1]);
    if (parsed >= 0 && parsed <= 24) sleepHours = parsed;
  }

  if (detectedFlow || detectedSymptoms.length > 0 || detectedMoods.length > 0 || waterGlasses !== null || sleepHours !== null) {
    actions.push({
      type: 'LOG_DAILY_DATA',
      date: todayKey,
      flow: detectedFlow,
      symptoms: detectedSymptoms,
      moods: detectedMoods,
      waterGlasses,
      sleepHours
    });
  }

  // 6. Cycle Settings (with stopword protection on "call me ...")
  const cycleLengthMatch = trimmed.match(/(?:my\s+)?cycle\s+(?:is|length\s+is|lasts?|usually\s+lasts?)\s*(\d{2})\s*days?/i);
  const periodLengthMatch = trimmed.match(/(?:my\s+)?period\s+(?:duration|lasts?|length\s+is)\s*(\d{1,2})\s*days?/i);
  const nameMatch = trimmed.match(/(?:my\s+name\s+is|you\s+can\s+call\s+me|call\s+me)\s+([A-Za-z][A-Za-z'-]{1,24})\b/i);

  let validName;
  if (nameMatch && !NAME_STOPWORDS.has(nameMatch[1].toLowerCase())) {
    validName = nameMatch[1].trim();
  }

  const parsedCycle = cycleLengthMatch ? parseInt(cycleLengthMatch[1], 10) : undefined;
  const parsedPeriod = periodLengthMatch ? parseInt(periodLengthMatch[1], 10) : undefined;

  if ((parsedCycle && parsedCycle >= 21 && parsedCycle <= 45) || (parsedPeriod && parsedPeriod >= 2 && parsedPeriod <= 10) || validName) {
    actions.push({
      type: 'UPDATE_CYCLE_SETTINGS',
      cycleLength: parsedCycle && parsedCycle >= 21 && parsedCycle <= 45 ? parsedCycle : undefined,
      periodLength: parsedPeriod && parsedPeriod >= 2 && parsedPeriod <= 10 ? parsedPeriod : undefined,
      userName: validName
    });
  }

  // 7. Remedy / habit / sensitivity insights (require health/remedy context, avoid "I like you")
  const learningTriggers = [
    {
      category: 'remedy_preference',
      pattern: /(?:i\s+prefer|helps?\s+(?:me|my|with)\s+(?:my\s+)?(?:cramps|pain|bloating|headache|fatigue|nausea|sleep|stress)?\s*)\s+([^.,!?]+)/i
    },
    {
      category: 'sensitivity_trigger',
      pattern: /(?:sensitive\s+to|makes?\s+(?:my\s+)?(?:cramps|bloating|pain|headaches?)\s+worse|triggers?\s+my\s+(?:cramps|migraines?|headaches?|bloating))\s+([^.,!?]+)/i
    },
    {
      category: 'personal_goal',
      pattern: /(?:my\s+(?:health|cycle)\s+goal\s+is|tracking\s+to)\s+([^.,!?]+)/i
    }
  ];

  for (const t of learningTriggers) {
    const match = trimmed.match(t.pattern);
    if (match && match[1]) {
      const raw = match[1].trim();
      if (raw.length > 4 && raw.length < 90 && !TRIVIAL_PREFERENCE_TARGETS.has(raw.toLowerCase())) {
        const fact = t.category === 'remedy_preference'
          ? `Prefers ${raw} for comfort`
          : t.category === 'sensitivity_trigger'
            ? `Sensitive to: ${raw}`
            : `Cycle goal: ${raw}`;
        actions.push({
          type: 'LEARN_INSIGHT',
          category: t.category,
          fact
        });
      }
    }
  }

  return actions;
}

/**
 * Sanitize & validate structured actions proposed by Gemini
 */
export function sanitizeModelActions(rawActions, referenceDate = new Date()) {
  if (!Array.isArray(rawActions)) return [];
  const todayKey = formatDateKey(referenceDate);
  const clean = [];

  for (const action of rawActions) {
    if (!action || typeof action !== 'object') continue;

    if (action.type === 'UPDATE_PERIOD_START') {
      const date = action.date ? (isValidActionDate(action.date, referenceDate) ? action.date : null) : todayKey;
      if (!date) continue;
      const flow = ALLOWED_FLOWS.has(action.flow) && action.flow !== 'none' ? action.flow : 'medium';
      clean.push({ type: 'UPDATE_PERIOD_START', date, flow });
    } else if (action.type === 'LOG_DAILY_DATA') {
      const date = action.date ? (isValidActionDate(action.date, referenceDate) ? action.date : null) : todayKey;
      if (!date) continue;
      const flow = ALLOWED_FLOWS.has(action.flow) ? action.flow : null;
      const symptoms = Array.isArray(action.symptoms)
        ? [...new Set(action.symptoms.filter(s => ALLOWED_SYMPTOMS.has(s)))]
        : [];
      const moods = Array.isArray(action.moods)
        ? [...new Set(action.moods.filter(m => ALLOWED_MOODS.has(m)))]
        : [];
      const waterGlasses = typeof action.waterGlasses === 'number' && action.waterGlasses >= 0 && action.waterGlasses <= 25
        ? Math.round(action.waterGlasses)
        : null;
      const sleepHours = typeof action.sleepHours === 'number' && action.sleepHours >= 0 && action.sleepHours <= 24
        ? Math.round(action.sleepHours * 10) / 10
        : null;
      const notes = typeof action.notes === 'string' ? action.notes.trim().slice(0, 300) : '';

      if (flow || symptoms.length > 0 || moods.length > 0 || waterGlasses !== null || sleepHours !== null || notes) {
        clean.push({ type: 'LOG_DAILY_DATA', date, flow, symptoms, moods, waterGlasses, sleepHours, notes });
      }
    } else if (action.type === 'UPDATE_CYCLE_SETTINGS') {
      const cycleLength = typeof action.cycleLength === 'number' && action.cycleLength >= 21 && action.cycleLength <= 45
        ? Math.round(action.cycleLength) : undefined;
      const periodLength = typeof action.periodLength === 'number' && action.periodLength >= 2 && action.periodLength <= 10
        ? Math.round(action.periodLength) : undefined;
      const userName = typeof action.userName === 'string' && action.userName.trim().length >= 2 && action.userName.trim().length <= 40
        ? action.userName.trim() : undefined;
      if (cycleLength !== undefined || periodLength !== undefined || userName !== undefined) {
        clean.push({ type: 'UPDATE_CYCLE_SETTINGS', cycleLength, periodLength, userName });
      }
    } else if (action.type === 'LEARN_INSIGHT') {
      const fact = typeof action.fact === 'string' ? action.fact.trim().slice(0, 140) : '';
      const category = ALLOWED_MEMORY_CATEGORIES.has(action.category) ? action.category : 'general';
      if (fact.length >= 5) {
        clean.push({ type: 'LEARN_INSIGHT', category, fact });
      }
    }
  }

  return clean;
}

/**
 * Deduplicate proposed actions between local parser and model output
 */
export function mergeProposedActions(localActions = [], modelActions = []) {
  const merged = [];
  let periodAction = null;
  const dailyByDate = new Map();
  let settingsAction = null;
  const seenFacts = new Set();

  // Prefer model actions when both propose the same record type, falling back to local
  for (const action of [...localActions, ...modelActions]) {
    if (action.type === 'UPDATE_PERIOD_START') {
      periodAction = { ...(periodAction || {}), ...action };
    } else if (action.type === 'LOG_DAILY_DATA') {
      const prev = dailyByDate.get(action.date) || {
        type: 'LOG_DAILY_DATA',
        date: action.date,
        flow: null,
        symptoms: [],
        moods: [],
        waterGlasses: null,
        sleepHours: null,
        notes: ''
      };
      dailyByDate.set(action.date, {
        type: 'LOG_DAILY_DATA',
        date: action.date,
        flow: action.flow || prev.flow,
        symptoms: [...new Set([...prev.symptoms, ...(action.symptoms || [])])],
        moods: [...new Set([...prev.moods, ...(action.moods || [])])],
        waterGlasses: action.waterGlasses !== null && action.waterGlasses !== undefined ? action.waterGlasses : prev.waterGlasses,
        sleepHours: action.sleepHours !== null && action.sleepHours !== undefined ? action.sleepHours : prev.sleepHours,
        notes: action.notes || prev.notes
      });
    } else if (action.type === 'UPDATE_CYCLE_SETTINGS') {
      settingsAction = {
        type: 'UPDATE_CYCLE_SETTINGS',
        cycleLength: action.cycleLength ?? settingsAction?.cycleLength,
        periodLength: action.periodLength ?? settingsAction?.periodLength,
        userName: action.userName ?? settingsAction?.userName
      };
    } else if (action.type === 'LEARN_INSIGHT') {
      const key = action.fact.toLowerCase();
      if (!seenFacts.has(key)) {
        seenFacts.add(key);
        merged.push(action);
      }
    }
  }

  const ordered = [];
  if (periodAction) ordered.push(periodAction);
  for (const daily of dailyByDate.values()) ordered.push(daily);
  if (settingsAction) ordered.push(settingsAction);
  ordered.push(...merged);
  return ordered;
}

/**
 * Pure helper: determine whether the floating AiFy greeting should appear
 * (on first-ever login for this user, then at most twice per day: <17:00 "day" and >=17:00 "evening").
 */
export function evaluateFloatingGreetingSchedule({ state = {}, userKey = 'guest', now = new Date() } = {}) {
  const safeState = state && typeof state === 'object' ? state : {};
  const firstLoginUsers = safeState.firstLoginUsers && typeof safeState.firstLoginUsers === 'object'
    ? safeState.firstLoginUsers
    : {};
  const cleanUserKey = String(userKey || 'guest').trim() || 'guest';
  const dateKey = formatDateKey(now);
  const slot = now.getHours() < 17 ? 'day' : 'evening';
  const slotKey = `${dateKey}:${slot}`;

  const isFirstLogin = !firstLoginUsers[cleanUserKey];
  const shouldShow = isFirstLogin || safeState.lastSlotShown !== slotKey;

  const nextState = {
    firstLoginUsers: {
      ...firstLoginUsers,
      [cleanUserKey]: true
    },
    lastSlotShown: slotKey,
    updatedAt: now.toISOString()
  };

  return {
    shouldShow,
    isFirstLogin,
    slot,
    slotKey,
    nextState
  };
}

/**
 * Pure helper: build a discreet, privacy-first greeting using only the user's first name
 * (never displays cycle phase, period day, or fertility in the popup).
 */
export function buildDiscreetGreetingText({ userName = '', isFirstLogin = false, hour = 10 } = {}) {
  const rawToken = String(userName || '').trim().split(/\s+/)[0] || '';
  const isGeneric = !rawToken || ['user', 'guest', 'demo'].includes(rawToken.toLowerCase());
  const firstName = isGeneric ? '' : rawToken;

  if (isFirstLogin) {
    return firstName
      ? `Welcome, ${firstName}! I'm AiFy, your private wellness companion — ready whenever you'd like to chat.`
      : `Welcome! I'm AiFy, your private wellness companion — ready whenever you'd like to chat.`;
  }

  if (hour >= 17) {
    return firstName
      ? `Good evening, ${firstName}. How are you feeling today? I'm here if you'd like to chat.`
      : `Good evening. How are you feeling today? I'm here if you'd like to chat.`;
  }

  const timeGreeting = hour < 12 ? 'Good morning' : 'Good afternoon';
  return firstName
    ? `${timeGreeting}, ${firstName}. Ready for a quick wellness check-in?`
    : `${timeGreeting}. Ready for a quick wellness check-in?`;
}
