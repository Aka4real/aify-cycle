/**
 * AifyCycle - Shared Server-Side Gemini Gateway
 * Centralizes prompt construction, payload validation, rate limiting,
 * fast 5s primary timeout + 5-minute cooldown circuit breaker, and multi-model failover.
 */

const { getClientIp, checkRateLimit, verifySupabaseUser } = require('./http-security');

const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';
const FALLBACK_GEMINI_MODELS = [
  'gemini-3-flash-preview',
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash-lite',
  'gemini-flash-lite-latest'
];

const MODEL_COOLDOWN_MS = 5 * 60 * 1000; // 5-minute circuit breaker cooldown for 503/429/timeout models
const PRIMARY_TIMEOUT_MS = 5000;         // 5s fast-fail on primary model
const FALLBACK_TIMEOUT_MS = 8000;        // 8s timeout on healthy fallback models
const TOTAL_DEADLINE_MS = 22000;         // Hard ceiling so serverless function never times out

// Map<modelName, cooldownExpiresAtTimestamp>
const modelCooldowns = new Map();

function isModelCoolingDown(model, now = Date.now()) {
  const until = modelCooldowns.get(model);
  if (!until) return false;
  if (now >= until) {
    modelCooldowns.delete(model);
    return false;
  }
  return true;
}

function markModelCooldown(model, durationMs = MODEL_COOLDOWN_MS) {
  modelCooldowns.set(model, Date.now() + durationMs);
}

function clearModelCooldowns() {
  modelCooldowns.clear();
}

const CHAT_SYSTEM_INSTRUCTION = `You are "Aify", a warm, empathetic, and evidence-informed AI menstrual wellness companion inside the AifyCycle app. Your personality is caring, empowering, body-positive, and grounded in general health education.

CORE CONVERSATIONAL GUIDELINES:
1. Provide complete, clear, and well-rounded answers. Always finish your thoughts and explanations cleanly.
2. When discussing fertility, ovulation, contraception, and biological rhythms, provide accurate, reassuring guidance with a clear distinction between cycle awareness and clinical contraception.
3. Be warm, supportive, and non-judgmental.

STRUCTURED LOG PROPOSALS (USER-CONFIRMED ONLY):
ONLY when the user explicitly reports NEW personal cycle data (e.g. period started, flow intensity, symptoms, mood, sleep, water) or explicitly states a personal comfort preference/habit — NEVER on hypothetical questions ("what if...") or negations ("no cramps") — append a structured JSON block at the VERY END of your message so the app can ask the user to confirm saving it:

\`\`\`json:agent_actions
{
  "actions": [
    { "type": "UPDATE_PERIOD_START", "date": "YYYY-MM-DD", "flow": "medium" },
    {
      "type": "LOG_DAILY_DATA",
      "date": "YYYY-MM-DD",
      "flow": "none|spotting|light|medium|heavy",
      "symptoms": ["Cramps", "Headache", "Bloating", "Tender Breasts", "Acne", "Lower Back Pain", "Fatigue", "Nausea"],
      "moods": ["Calm", "Happy", "High Energy", "Romantic", "Sensitive", "Anxious", "Irritable", "Low Energy"],
      "waterGlasses": 8,
      "sleepHours": 8,
      "notes": "Brief summary of user observation"
    },
    { "type": "UPDATE_CYCLE_SETTINGS", "cycleLength": 28, "periodLength": 5, "userName": "Name" },
    {
      "type": "LEARN_INSIGHT",
      "category": "remedy_preference|cycle_pattern|lifestyle_habit|personal_goal|sensitivity_trigger",
      "fact": "Clear, concise statement of what the user shared"
    }
  ]
}
\`\`\`

If the user is asking a general question or seeking advice WITHOUT reporting new personal data, DO NOT include any JSON block. Keep responses engaging and complete (2-4 concise paragraphs).

CRITICAL MEDICAL & SAFETY GUARDRAILS:
1. EDUCATIONAL WELLNESS ONLY: You are a wellness education guide, NOT a doctor, clinician, or medical device. NEVER diagnose medical conditions (e.g. PCOS, endometriosis, fibroids, pelvic inflammatory disease, toxic shock syndrome, or pregnancy).
2. CONTRACEPTION WARNING: If the user asks about using cycle tracking or fertility windows to prevent pregnancy, EXPLICITLY state that calendar cycle predictions are NOT contraception and cannot prevent pregnancy or STIs, and recommend consulting a healthcare provider.
3. EMERGENCY RED-FLAG PROTOCOLS: If the user describes:
   - Sudden, severe, sharp, or worsening pelvic or abdominal pain
   - Heavy bleeding soaking through one or more pads/tampons every hour for 2+ consecutive hours
   - High fever with chills, foul-smelling discharge, or flu-like symptoms with tampon use
   - Dizziness, fainting, chest pain, or shortness of breath
   IMMEDIATELY advise seeking urgent emergency medical care (911/112/local emergency services) and do NOT minimize severe symptoms.
4. NO PRESCRIBING: Never prescribe medications or specific dosages. Stick to gentle lifestyle comfort ideas and advise speaking with a clinician or pharmacist for medical treatment.`;

function clampStr(val, maxLen) {
  if (typeof val !== 'string') return '';
  return val.trim().slice(0, maxLen);
}

function clampInt(val, min, max, fallback) {
  const n = parseInt(val, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function getConfiguredModel() {
  return (process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL)
    .replace(/^models\//i, '')
    .trim();
}

function getGeminiStatus() {
  const isConfigured = Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim());
  const configuredPrimary = getConfiguredModel();
  const allCandidates = [...new Set([configuredPrimary, DEFAULT_GEMINI_MODEL, ...FALLBACK_GEMINI_MODELS])];
  const activeModel = allCandidates.find(m => !isModelCoolingDown(m)) || configuredPrimary;

  return {
    configured: isConfigured,
    model: activeModel,
    configuredModel: configuredPrimary,
    fallbackModels: FALLBACK_GEMINI_MODELS,
    cascadeEnabled: true,
    mode: isConfigured ? 'server_proxy' : 'unconfigured'
  };
}

function buildCycleSyncPayload(ctx = {}) {
  const phaseName = clampStr(ctx.phaseName, 60) || 'Current Phase';
  const phaseTagline = clampStr(ctx.phaseTagline, 160);
  const cycleDay = clampInt(ctx.cycleDay, 1, 90, 1);
  const cycleLength = clampInt(ctx.cycleLength, 21, 45, 28);
  const periodLength = clampInt(ctx.periodLength, 2, 10, 5);
  const recentSymptoms = clampStr(ctx.recentSymptoms, 300) || 'None reported';
  const nextPeriodStart = clampStr(ctx.nextPeriodStart, 32) || 'Estimated';
  const userName = clampStr(ctx.userName, 60) || 'User';
  const isLate = Boolean(ctx.isLate);

  const prompt = `You are a supportive, evidence-informed menstrual wellness educator powering AifyCycle (general wellness education only — NOT a medical doctor or diagnostic tool).
Generate practical, gentle lifestyle suggestions for Day ${cycleDay} (${phaseName}).

Context:
- Name: ${userName}
- Phase: ${phaseName}${phaseTagline ? ` (${phaseTagline})` : ''}
- Cycle Day: Day ${cycleDay} of estimated ${cycleLength}-day cycle${isLate ? ' (period is later than estimated)' : ''}
- Typical Period Length: ${periodLength} days
- Recent Logged Symptoms & Moods: ${recentSymptoms}
- Estimated Next Period: ${nextPeriodStart}

Guidelines:
- Keep claims realistic and evidence-informed; avoid exaggerated percentages or unverified hormone-detox claims.
- Suggest approachable, balanced foods, movement ideas matched to comfort/energy, and gentle daily focus tips.
- partnerTip should be a warm, supportive wellness or partner-empathy note (never invent names).
- scientificWhy should be a concise 1-2 sentence educational summary of typical cycle physiology for this stage.

Respond ONLY with valid JSON matching this schema:
{
  "title": "${phaseName} (Day ${cycleDay})",
  "tagline": "Short supportive one-liner",
  "hormoneSnapshot": "Concise 1-sentence educational hormone overview",
  "energyCapacity": "Qualitative energy cue (e.g. Restorative & Gentle, Rising & Steady, Vibrant & Social, Grounded & Focused)",
  "foods": [
    "Food idea 1 with nutritional benefit",
    "Food idea 2 with nutritional benefit",
    "Food idea 3 with nutritional benefit",
    "Hydration or herbal tea idea"
  ],
  "workouts": [
    "Primary movement suggestion",
    "Pacing & comfort guidance",
    "Recovery / mobility idea"
  ],
  "mindset": [
    "Focus / daily rhythm suggestion",
    "Social or communication cue",
    "Evening wind-down tip"
  ],
  "partnerTip": "Supportive holistic care or partner empathy note",
  "scientificWhy": "Concise 1-2 sentence educational rationale (non-diagnostic)."
}`;

  return {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.65,
      maxOutputTokens: 1536,
      responseMimeType: 'application/json'
    }
  };
}

function buildChatPayload(input = {}) {
  const rawHistory = Array.isArray(input.history) ? input.history.slice(-8) : [];
  const contents = [];

  for (const item of rawHistory) {
    if (!item || typeof item !== 'object') continue;
    const role = item.role === 'model' || item.role === 'assistant' ? 'model' : 'user';
    const text = clampStr(item.text || item.content, 2000);
    if (!text) continue;
    contents.push({ role, parts: [{ text }] });
  }

  if (contents.length === 0 || contents[contents.length - 1].role !== 'user') {
    return null;
  }

  const userContext = clampStr(input.userContext, 2500);
  if (userContext) {
    contents[contents.length - 1].parts[0].text += `\n\n${userContext}`;
  }

  return {
    contents,
    systemInstruction: {
      parts: [{ text: CHAT_SYSTEM_INSTRUCTION }]
    },
    generationConfig: {
      temperature: 0.7,
      topP: 0.95,
      topK: 40,
      maxOutputTokens: 2048
    }
  };
}

function buildValidatedGeminiRequest(clientBody) {
  if (!clientBody || typeof clientBody !== 'object') {
    return { error: 'Request body must be a JSON object.' };
  }

  if (clientBody.task === 'chat') {
    const payload = buildChatPayload(clientBody);
    if (!payload) {
      return { error: 'Chat request must include at least one user message in history.' };
    }
    return { payload };
  }

  if (clientBody.task === 'cycle_sync') {
    const payload = buildCycleSyncPayload(clientBody.context || {});
    return { payload };
  }

  return { error: 'Unsupported task. Expected task "chat" or "cycle_sync".' };
}

async function callGeminiWithCascade(preferredModel, apiKey, requestBody) {
  const primary = preferredModel || DEFAULT_GEMINI_MODEL;
  const allModels = [...new Set([primary, DEFAULT_GEMINI_MODEL, ...FALLBACK_GEMINI_MODELS].filter(Boolean))];

  // Put non-cooling-down models first; only retry cooling-down models if all others fail
  const healthyQueue = allModels.filter(m => !isModelCoolingDown(m));
  const coolingQueue = allModels.filter(m => isModelCoolingDown(m));
  const orderedModels = [...healthyQueue, ...coolingQueue];

  const startedAt = Date.now();
  let lastResult = null;

  for (let i = 0; i < orderedModels.length; i++) {
    const model = orderedModels[i];
    const elapsed = Date.now() - startedAt;
    const remainingBudget = TOTAL_DEADLINE_MS - elapsed;
    if (remainingBudget < 1500) {
      break;
    }

    const isPrimaryCandidate = model === primary;
    const perAttemptTimeout = Math.min(
      remainingBudget,
      isPrimaryCandidate ? PRIMARY_TIMEOUT_MS : FALLBACK_TIMEOUT_MS
    );

    try {
      const targetUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      const upstreamRes = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(perAttemptTimeout)
      });

      const data = await upstreamRes.json().catch(() => ({}));

      if (upstreamRes.ok) {
        modelCooldowns.delete(model);
        return {
          status: 200,
          data: {
            ...data,
            _aify_meta: {
              modelUsed: model,
              requestedModel: primary,
              cascaded: model !== primary
            }
          }
        };
      }

      lastResult = { status: upstreamRes.status, data };

      if ([503, 429, 404, 500, 502, 504].includes(upstreamRes.status)) {
        markModelCooldown(model);
        console.warn(`[Aify AI Cascade] Model '${model}' returned HTTP ${upstreamRes.status} (cooling down 5m). Failing over...`);
        continue;
      }

      return { status: upstreamRes.status, data };
    } catch (err) {
      markModelCooldown(model);
      console.warn(`[Aify AI Cascade] Timeout/network error for '${model}' after ${perAttemptTimeout}ms (cooling down 5m):`, err.message);
      lastResult = {
        status: 503,
        data: { error: 'UPSTREAM_TIMEOUT', message: err.message }
      };
    }
  }

  return lastResult || {
    status: 503,
    data: {
      error: 'ALL_MODELS_UNAVAILABLE',
      message: 'All Gemini models in cascade are currently experiencing high demand. Please try again shortly.'
    }
  };
}

async function processGeminiProxyRequest(req, parsedBody) {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    return {
      status: 503,
      headers: {},
      data: {
        error: 'NO_API_KEY',
        message: 'No GEMINI_API_KEY configured in server environment.'
      }
    };
  }

  const user = await verifySupabaseUser(req);
  if (process.env.REQUIRE_AUTH_FOR_AI === 'true' && !user) {
    return {
      status: 401,
      headers: {},
      data: {
        error: 'AUTH_REQUIRED',
        message: 'Please sign in to use live AI Coach features.'
      }
    };
  }

  const rateKey = user ? `user:${user.id}` : `ip:${getClientIp(req)}`;
  const rateLimit = user
    ? { limit: 25, windowMs: 10 * 60 * 1000 }
    : { limit: 8, windowMs: 10 * 60 * 1000 };

  const rl = checkRateLimit(rateKey, rateLimit);
  if (!rl.allowed) {
    return {
      status: 429,
      headers: { 'Retry-After': String(rl.retryAfterSec) },
      data: {
        error: 'RATE_LIMITED',
        message: `Too many AI requests. Please wait ${rl.retryAfterSec}s before trying again.`
      }
    };
  }

  const validated = buildValidatedGeminiRequest(parsedBody);
  if (validated.error) {
    return {
      status: 400,
      headers: {},
      data: { error: 'INVALID_REQUEST', message: validated.error }
    };
  }

  const result = await callGeminiWithCascade(getConfiguredModel(), apiKey, validated.payload);
  return {
    status: result.status,
    headers: { 'X-RateLimit-Remaining': String(rl.remaining) },
    data: result.data
  };
}

module.exports = {
  DEFAULT_GEMINI_MODEL,
  FALLBACK_GEMINI_MODELS,
  MODEL_COOLDOWN_MS,
  isModelCoolingDown,
  markModelCooldown,
  clearModelCooldowns,
  getConfiguredModel,
  getGeminiStatus,
  buildValidatedGeminiRequest,
  callGeminiWithCascade,
  processGeminiProxyRequest
};
