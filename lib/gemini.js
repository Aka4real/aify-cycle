/**
 * AifyCycle - Shared Server-Side Gemini Gateway
 * Centralizes prompt construction, payload validation, rate limiting,
 * fast 5s primary timeout + 5-minute cooldown circuit breaker, and multi-model failover.
 */

const { getClientIp, checkRateLimit, verifySupabaseUser } = require('./http-security');
const { recordGeminiCall } = require('./telemetry-store');

const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';
const FALLBACK_GEMINI_MODELS = [
  'gemini-3.1-flash-lite',
  'gemini-3-flash-preview',
  'gemini-3.5-flash-lite',
  'gemini-flash-lite-latest'
];

const MODEL_COOLDOWN_MS = 5 * 60 * 1000; // 5-minute circuit breaker cooldown for 503/429/timeout models
const PRIMARY_TIMEOUT_MS = 3500;         // 3.5s fast-fail on primary model
const FALLBACK_TIMEOUT_MS = 7000;        // 7s timeout on healthy fallback models
const TOTAL_DEADLINE_MS = 22000;         // Hard ceiling so serverless function never times out

// Map<modelName, cooldownExpiresAtTimestamp>
const modelCooldowns = new Map();
// Map<modelName, PerModelHealthStats>
const modelStats = new Map();

function ensureModelStats(model) {
  let entry = modelStats.get(model);
  if (!entry) {
    entry = {
      model,
      attempts: 0,
      successes: 0,
      failures: 0,
      cascadeWins: 0,
      latencies: [],
      lastStatus: null,
      lastError: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastProbeAt: null,
      lastProbeOk: null,
      lastProbeLatencyMs: null,
      lastProbeStatus: null,
      totalTokens: 0
    };
    modelStats.set(model, entry);
  }
  return entry;
}

function recordModelAttemptMetric(model, { ok, status, latencyMs, error, cascadedWin = false, tokens = 0, isProbe = false }) {
  const entry = ensureModelStats(model);
  entry.attempts++;
  entry.lastStatus = status;
  if (Number.isFinite(latencyMs)) {
    entry.latencies.push(Math.round(latencyMs));
    if (entry.latencies.length > 100) entry.latencies.shift();
  }
  if (Number.isFinite(tokens) && tokens > 0) {
    entry.totalTokens += tokens;
  }
  const nowIso = new Date().toISOString();
  if (isProbe) {
    entry.lastProbeAt = nowIso;
    entry.lastProbeOk = Boolean(ok);
    entry.lastProbeLatencyMs = Number.isFinite(latencyMs) ? Math.round(latencyMs) : null;
    entry.lastProbeStatus = status;
  }
  if (ok) {
    entry.successes++;
    entry.lastSuccessAt = nowIso;
    if (cascadedWin) entry.cascadeWins++;
  } else {
    entry.failures++;
    entry.lastFailureAt = nowIso;
    entry.lastError = error ? String(error).slice(0, 160) : `HTTP ${status}`;
  }
}

function computePercentile(arr, p) {
  if (!arr || arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

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

function resetModelCooldown(model) {
  return modelCooldowns.delete(model);
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

function getAllCascadeModels() {
  const configuredPrimary = getConfiguredModel();
  return [...new Set([configuredPrimary, DEFAULT_GEMINI_MODEL, ...FALLBACK_GEMINI_MODELS].filter(Boolean))];
}

function getDetailedGeminiHealth() {
  const now = Date.now();
  const configuredPrimary = getConfiguredModel();
  const isConfigured = Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim());
  const allModels = getAllCascadeModels();
  const activeModel = allModels.find(m => !isModelCoolingDown(m, now)) || configuredPrimary;

  const models = allModels.map((model, idx) => {
    const cooling = isModelCoolingDown(model, now);
    const cooldownUntilTs = cooling ? modelCooldowns.get(model) : null;
    const cooldownRemainingSec = cooldownUntilTs ? Math.max(0, Math.ceil((cooldownUntilTs - now) / 1000)) : 0;
    const st = ensureModelStats(model);
    const avgLatencyMs = st.latencies.length > 0
      ? Math.round(st.latencies.reduce((a, b) => a + b, 0) / st.latencies.length)
      : null;
    const p95LatencyMs = computePercentile(st.latencies, 95);
    const successRate = st.attempts > 0
      ? Math.round((st.successes / st.attempts) * 1000) / 10
      : null;

    let healthState = 'standby';
    if (!isConfigured) {
      healthState = 'unconfigured';
    } else if (cooling) {
      healthState = 'cooling_down';
    } else if (st.lastProbeOk === false && (!st.lastSuccessAt || Date.parse(st.lastProbeAt) >= Date.parse(st.lastSuccessAt))) {
      healthState = 'degraded';
    } else if (st.successes > 0 || st.lastProbeOk === true) {
      healthState = 'healthy';
    } else {
      healthState = 'ready';
    }

    return {
      model,
      priority: idx + 1,
      role: model === configuredPrimary ? 'primary' : `fallback_${idx}`,
      isActive: model === activeModel,
      healthState,
      coolingDown: cooling,
      cooldownUntil: cooldownUntilTs ? new Date(cooldownUntilTs).toISOString() : null,
      cooldownRemainingSec,
      attempts: st.attempts,
      successes: st.successes,
      failures: st.failures,
      cascadeWins: st.cascadeWins,
      successRate,
      avgLatencyMs,
      p95LatencyMs,
      totalTokens: st.totalTokens,
      lastStatus: st.lastStatus,
      lastError: st.lastError,
      lastSuccessAt: st.lastSuccessAt,
      lastFailureAt: st.lastFailureAt,
      lastProbeAt: st.lastProbeAt,
      lastProbeOk: st.lastProbeOk,
      lastProbeLatencyMs: st.lastProbeLatencyMs,
      lastProbeStatus: st.lastProbeStatus
    };
  });

  const healthyCount = models.filter(m => !m.coolingDown && m.healthState !== 'unconfigured' && m.healthState !== 'degraded').length;
  const coolingCount = models.filter(m => m.coolingDown).length;

  return {
    configured: isConfigured,
    mode: isConfigured ? 'server_proxy' : 'unconfigured',
    configuredPrimary,
    activeModel,
    cascadeEnabled: true,
    timeouts: {
      primaryMs: PRIMARY_TIMEOUT_MS,
      fallbackMs: FALLBACK_TIMEOUT_MS,
      totalDeadlineMs: TOTAL_DEADLINE_MS,
      cooldownMs: MODEL_COOLDOWN_MS
    },
    summary: {
      totalModels: models.length,
      healthyCount,
      coolingCount,
      overallStatus: !isConfigured
        ? 'unconfigured'
        : healthyCount === 0
          ? 'outage'
          : coolingCount > 0 || models.some(m => m.healthState === 'degraded')
            ? 'degraded'
            : 'operational'
    },
    models
  };
}

async function probeGeminiModel(modelName) {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  const targetModel = (modelName || getConfiguredModel()).replace(/^models\//i, '').trim();
  if (!apiKey) {
    return {
      model: targetModel,
      ok: false,
      status: 503,
      latencyMs: 0,
      error: 'NO_API_KEY',
      message: 'GEMINI_API_KEY is not configured in server environment.'
    };
  }

  const startedAt = Date.now();
  try {
    const targetUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(targetModel)}:generateContent`;
    const res = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'Reply with OK' }] }],
        generationConfig: { maxOutputTokens: 8, temperature: 0 }
      }),
      signal: AbortSignal.timeout(7000)
    });
    const latencyMs = Date.now() - startedAt;
    const data = await res.json().catch(() => ({}));
    const usage = data?.usageMetadata || {};
    const totalTokens = Number(usage.totalTokenCount) || 0;

    if (res.ok) {
      modelCooldowns.delete(targetModel);
      recordModelAttemptMetric(targetModel, {
        ok: true,
        status: res.status,
        latencyMs,
        tokens: totalTokens,
        isProbe: true
      });
      recordGeminiCall({
        task: 'probe',
        requestedModel: targetModel,
        modelUsed: targetModel,
        cascaded: false,
        attempts: 1,
        statusCode: res.status,
        success: true,
        latencyMs,
        promptTokens: Number(usage.promptTokenCount) || null,
        completionTokens: Number(usage.candidatesTokenCount) || null,
        totalTokens: totalTokens || null
      });
      return {
        model: targetModel,
        ok: true,
        status: res.status,
        latencyMs,
        totalTokens,
        probedAt: new Date().toISOString()
      };
    }

    const errMsg = data?.error?.message || data?.error?.status || `HTTP_${res.status}`;
    if ([503, 429, 404, 500, 502, 504].includes(res.status)) {
      markModelCooldown(targetModel);
    }
    recordModelAttemptMetric(targetModel, {
      ok: false,
      status: res.status,
      latencyMs,
      error: errMsg,
      isProbe: true
    });
    recordGeminiCall({
      task: 'probe',
      requestedModel: targetModel,
      modelUsed: targetModel,
      cascaded: false,
      attempts: 1,
      statusCode: res.status,
      success: false,
      latencyMs,
      errorCode: errMsg
    });
    return {
      model: targetModel,
      ok: false,
      status: res.status,
      latencyMs,
      error: errMsg,
      probedAt: new Date().toISOString()
    };
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    markModelCooldown(targetModel);
    recordModelAttemptMetric(targetModel, {
      ok: false,
      status: 504,
      latencyMs,
      error: err.message || 'PROBE_TIMEOUT',
      isProbe: true
    });
    recordGeminiCall({
      task: 'probe',
      requestedModel: targetModel,
      modelUsed: targetModel,
      cascaded: false,
      attempts: 1,
      statusCode: 504,
      success: false,
      latencyMs,
      errorCode: err.message || 'PROBE_TIMEOUT'
    });
    return {
      model: targetModel,
      ok: false,
      status: 504,
      latencyMs,
      error: err.message || 'PROBE_TIMEOUT',
      probedAt: new Date().toISOString()
    };
  }
}

async function probeAllGeminiModels() {
  const models = getAllCascadeModels();
  const results = await Promise.all(models.map(m => probeGeminiModel(m)));
  return {
    probedAt: new Date().toISOString(),
    results,
    health: getDetailedGeminiHealth()
  };
}

async function callGeminiWithCascade(preferredModel, apiKey, requestBody, meta = {}) {
  const primary = preferredModel || DEFAULT_GEMINI_MODEL;
  const allModels = [...new Set([primary, DEFAULT_GEMINI_MODEL, ...FALLBACK_GEMINI_MODELS].filter(Boolean))];

  // Put non-cooling-down models first; only retry cooling-down models if all others fail
  const healthyQueue = allModels.filter(m => !isModelCoolingDown(m));
  const coolingQueue = allModels.filter(m => isModelCoolingDown(m));
  const orderedModels = [...healthyQueue, ...coolingQueue];

  const startedAt = Date.now();
  let lastResult = null;
  let attemptsCount = 0;

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

    attemptsCount++;
    const attemptStart = Date.now();

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

      const attemptLatencyMs = Date.now() - attemptStart;
      const data = await upstreamRes.json().catch(() => ({}));

      if (upstreamRes.ok) {
        modelCooldowns.delete(model);
        const usage = data?.usageMetadata || {};
        const promptTokens = Number(usage.promptTokenCount) || null;
        const completionTokens = Number(usage.candidatesTokenCount) || null;
        const totalTokens = Number(usage.totalTokenCount) || null;
        const cascaded = model !== primary;

        recordModelAttemptMetric(model, {
          ok: true,
          status: 200,
          latencyMs: attemptLatencyMs,
          cascadedWin: cascaded,
          tokens: totalTokens || 0
        });
        recordGeminiCall({
          task: meta.task || 'chat',
          requestedModel: primary,
          modelUsed: model,
          cascaded,
          attempts: attemptsCount,
          statusCode: 200,
          success: true,
          latencyMs: Date.now() - startedAt,
          promptTokens,
          completionTokens,
          totalTokens,
          userId: meta.userId || null
        });

        return {
          status: 200,
          data: {
            ...data,
            _aify_meta: {
              modelUsed: model,
              requestedModel: primary,
              cascaded
            }
          }
        };
      }

      const errCode = data?.error?.status || data?.error?.message || `HTTP_${upstreamRes.status}`;
      recordModelAttemptMetric(model, {
        ok: false,
        status: upstreamRes.status,
        latencyMs: attemptLatencyMs,
        error: errCode
      });

      lastResult = { status: upstreamRes.status, data };

      if ([503, 429, 404, 500, 502, 504].includes(upstreamRes.status)) {
        markModelCooldown(model);
        console.warn(`[Aify AI Cascade] Model '${model}' returned HTTP ${upstreamRes.status} (cooling down 5m). Failing over...`);
        continue;
      }

      recordGeminiCall({
        task: meta.task || 'chat',
        requestedModel: primary,
        modelUsed: model,
        cascaded: model !== primary,
        attempts: attemptsCount,
        statusCode: upstreamRes.status,
        success: false,
        latencyMs: Date.now() - startedAt,
        errorCode: errCode,
        userId: meta.userId || null
      });
      return { status: upstreamRes.status, data };
    } catch (err) {
      const attemptLatencyMs = Date.now() - attemptStart;
      markModelCooldown(model);
      recordModelAttemptMetric(model, {
        ok: false,
        status: 503,
        latencyMs: attemptLatencyMs,
        error: err.message || 'UPSTREAM_TIMEOUT'
      });
      console.warn(`[Aify AI Cascade] Timeout/network error for '${model}' after ${perAttemptTimeout}ms (cooling down 5m):`, err.message);
      lastResult = {
        status: 503,
        data: { error: 'UPSTREAM_TIMEOUT', message: err.message }
      };
    }
  }

  const finalResult = lastResult || {
    status: 503,
    data: {
      error: 'ALL_MODELS_UNAVAILABLE',
      message: 'All Gemini models in cascade are currently experiencing high demand. Please try again shortly.'
    }
  };

  recordGeminiCall({
    task: meta.task || 'chat',
    requestedModel: primary,
    modelUsed: null,
    cascaded: attemptsCount > 1,
    attempts: attemptsCount || 1,
    statusCode: finalResult.status,
    success: false,
    latencyMs: Date.now() - startedAt,
    errorCode: finalResult.data?.error?.status || finalResult.data?.error || 'ALL_MODELS_UNAVAILABLE',
    userId: meta.userId || null
  });

  return finalResult;
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

  const result = await callGeminiWithCascade(getConfiguredModel(), apiKey, validated.payload, {
    task: parsedBody?.task || 'chat',
    userId: user?.id || null
  });
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
  resetModelCooldown,
  clearModelCooldowns,
  getConfiguredModel,
  getAllCascadeModels,
  getGeminiStatus,
  getDetailedGeminiHealth,
  probeGeminiModel,
  probeAllGeminiModels,
  buildValidatedGeminiRequest,
  callGeminiWithCascade,
  processGeminiProxyRequest
};
