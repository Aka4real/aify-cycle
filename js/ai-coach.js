/**
 * AifyCycle - AI Coach & Real-Time Adaptive Health Agent
 * Gemini 3.8 Flash-powered conversational AI menstrual health coach with
 * real-time cycle data updates, continuous learning memory, and instant synchronization.
 */

import { storage } from './storage.js';
import { getCycleStatus, formatDateKey, parseDateKey, addDays } from './cycle-engine.js';

const BACKEND_PROXY_URL = '/api/gemini';
const BACKEND_STATUS_URL = '/api/gemini/status';

const SYSTEM_INSTRUCTION = `You are "Aify", a warm, empathetic, and knowledgeable AI menstrual health coach inside the Aify Cycle app. Your personality is supportive, encouraging, and scientifically informed.

REAL-TIME DATA CAPABILITIES:
You are not just a chatbot — you have direct agency to update the user's cycle tracking records, symptoms, flow, and learn their health habits and preferences in REAL TIME!

When the user tells you information about their cycle (e.g. their period started, they have symptoms, specific flow, sleep, water, or cycle parameters), or shares a habit, remedy preference, or health pattern:
1. Respond warmly, empathetically, and informatively to the user.
2. In addition to your conversational response, ALWAYS append a JSON block at the very end of your response specifying the exact actions to update and insights to learn:

\`\`\`json:agent_actions
{
  "actions": [
    // Use any of these actions as appropriate:
    // 1. When period started or date specified:
    { "type": "UPDATE_PERIOD_START", "date": "YYYY-MM-DD", "flow": "medium" },

    // 2. When logging daily symptoms, flow, mood, water, sleep, notes:
    {
      "type": "LOG_DAILY_DATA",
      "date": "YYYY-MM-DD",
      "flow": "none|spotting|light|medium|heavy",
      "symptoms": ["Cramps", "Headache", "Bloating", "Tender Breasts", "Acne", "Lower Back Pain", "Fatigue", "Nausea"],
      "moods": ["Calm", "Happy", "High Energy", "Romantic", "Sensitive", "Anxious", "Irritable", "Low Energy"],
      "waterGlasses": 8,
      "sleepHours": 8,
      "notes": "User notes or observations"
    },

    // 3. When user specifies cycle settings or name:
    { "type": "UPDATE_CYCLE_SETTINGS", "cycleLength": 30, "periodLength": 5, "userName": "Name" },

    // 4. When user mentions a preference, remedy, habit, sensitivity, or goal that you should learn:
    {
      "type": "LEARN_INSIGHT",
      "category": "remedy_preference|cycle_pattern|lifestyle_habit|personal_goal|sensitivity_trigger",
      "fact": "Clear, concise statement of what you learned about the user"
    }
  ]
}
\`\`\`

If the user is just asking a question without reporting new data or habits, do not include the actions block.

Guidelines:
- Always be supportive, non-judgmental, and body-positive
- Reference what you've previously learned about the user when relevant
- Provide evidence-based information while being warm and accessible
- Use emojis naturally
- Keep responses concise (2-3 paragraphs)
- NEVER diagnose medical conditions — advise consulting a doctor when appropriate`;

const SUGGESTED_QUESTIONS = [
  { icon: '🩸', text: 'My period started today' },
  { icon: '⚡', text: 'I have bad cramps and bloating today, flow is heavy' },
  { icon: '🍵', text: 'I prefer chamomile tea and a heating pad for cramps' },
  { icon: '🔄', text: 'My cycle length is 30 days' },
  { icon: '🌙', text: 'What phase am I in right now?' },
  { icon: '🥗', text: 'What should I eat during this phase?' },
  { icon: '🌿', text: 'Best exercises for my current cycle phase?' },
  { icon: '😴', text: 'I slept 6 hours and feel exhausted today' }
];

export class AICoach {
  constructor() {
    this.chatHistory = [];
    this.isLoading = false;
    this.activeCategoryFilter = 'all';
    this._loadChatHistory();
  }

  /**
   * Initialize the AI Coach UI
   */
  init() {
    this.renderChatUI();
    this.attachListeners();
    this._updateMemoryCountBadge();
    this.updateEngineBadge();
  }

  /**
   * Check connection status of Gemini backend proxy and client key
   */
  async checkGeminiStatus() {
    // 1. Check server backend proxy
    try {
      const res = await fetch(BACKEND_STATUS_URL, { method: 'GET' });
      if (res.ok) {
        const data = await res.json();
        if (data.configured) {
          const modelTitle = data.model === 'gemini-3.8-flash' ? 'Gemini 3.8 Flash' : data.model;
          return { mode: 'server', label: modelTitle, active: true };
        }
      }
    } catch (e) {
      // Backend not running or static mode
    }

    // 2. Check client-side stored key
    const clientKey = storage.getGeminiApiKey();
    if (clientKey) {
      return { mode: 'client', label: 'Gemini 3.8 Flash (Client Key)', active: true };
    }

    // 3. Built-in Local Mode
    return { mode: 'local', label: 'Local Intelligence', active: false };
  }

  /**
   * Update the interactive AI engine badge in the chat header
   */
  async updateEngineBadge() {
    const badgeEl = document.getElementById('ai-engine-badge');
    if (!badgeEl) return;

    const status = await this.checkGeminiStatus();
    if (status.active) {
      badgeEl.className = 'ai-engine-badge badge-active';
      badgeEl.innerHTML = `<span class="engine-dot live"></span><span>✨ ${status.label}</span>`;
      badgeEl.title = `Live ${status.label} connected. Click to configure API settings.`;
    } else {
      badgeEl.className = 'ai-engine-badge badge-local';
      badgeEl.innerHTML = `<span class="engine-dot local"></span><span>🧠 Local Intelligence</span>`;
      badgeEl.title = 'Running on local cycle intelligence. Click to connect Gemini 3.8 Flash API.';
    }
  }

  /**
   * Dispatch generation request to either backend proxy or client direct endpoint
   */
  async _callGeminiApi(requestBody) {
    // Try backend proxy first
    try {
      const serverRes = await fetch(BACKEND_PROXY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      });

      if (serverRes.ok) {
        return await serverRes.json();
      }

      const errData = await serverRes.json().catch(() => ({}));
      // If server returned NO_API_KEY, fallback to client key
      if (errData.error !== 'NO_API_KEY') {
        throw new Error(errData.message || `Server Proxy Error: ${serverRes.status}`);
      }
    } catch (serverErr) {
      if (serverErr.message && !serverErr.message.includes('NO_API_KEY')) {
        console.warn('Backend proxy call failed:', serverErr.message);
      }
    }

    // Check client-side key
    const clientKey = storage.getGeminiApiKey();
    if (clientKey) {
      const targetUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${encodeURIComponent(clientKey)}`;
      const clientRes = await fetch(targetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      });

      if (!clientRes.ok) {
        const errJson = await clientRes.json().catch(() => ({}));
        throw new Error(errJson.error?.message || `Client API Error: ${clientRes.status}`);
      }

      return await clientRes.json();
    }

    // Neither server nor client key is configured
    throw new Error('NO_GEMINI_KEY');
  }

  /**
   * Build context string from user's cycle data and learned memories
   */
  _buildUserContext() {
    const profile = storage.getProfile();
    const today = new Date();
    const status = getCycleStatus(today, profile);
    const todayLog = storage.getLog(formatDateKey(today));
    const memories = storage.getAgentMemories();

    let context = `\n\n--- User Context & Real-Time State ---\n`;
    context += `User Name: ${profile.userName || 'User'}\n`;
    context += `Today's Date: ${formatDateKey(today)}\n`;
    context += `Cycle Day: ${status.cycleDay} of ${status.cycleLength}\n`;
    context += `Current Phase: ${status.phase.name} (${status.phase.shortName})\n`;
    context += `Phase Description: ${status.phase.description}\n`;
    context += `Fertility Status: ${status.fertilityChance}\n`;
    context += `Days Until Next Period: ${status.daysUntilNextPeriod}\n`;
    context += `Next Period Predicted: ${status.nextPeriodStart}\n`;
    context += `Next Ovulation: ${status.nextOvulationDate}\n`;
    context += `Average Cycle Length: ${profile.cycleLength} days\n`;
    context += `Average Period Length: ${profile.periodLength} days\n`;
    context += `Last Period Start Date: ${profile.lastPeriodStart}\n`;

    if (todayLog) {
      if (todayLog.symptoms && todayLog.symptoms.length > 0) {
        context += `Today's Logged Symptoms: ${todayLog.symptoms.join(', ')}\n`;
      }
      if (todayLog.moods && todayLog.moods.length > 0) {
        context += `Today's Logged Mood: ${todayLog.moods.join(', ')}\n`;
      }
      if (todayLog.flow) {
        context += `Today's Logged Flow: ${todayLog.flow}\n`;
      }
      if (todayLog.waterGlasses) {
        context += `Today's Water: ${todayLog.waterGlasses} glasses\n`;
      }
      if (todayLog.sleepHours) {
        context += `Today's Sleep: ${todayLog.sleepHours} hours\n`;
      }
    }

    if (memories && memories.length > 0) {
      context += `\n--- What You Have Learned About This User (Active Memory Bank) ---\n`;
      memories.slice(0, 10).forEach(m => {
        context += `- [${m.category}] ${m.fact}\n`;
      });
    }

    return context;
  }

  /**
   * Local Real-Time Semantic Parser:
   * Extracts cycle updates, symptoms, flow, and learning insights instantaneously
   * ensuring 100% offline & real-time zero-latency execution.
   */
  _parseLocalActionsAndLearning(text) {
    const actions = [];
    const lower = text.toLowerCase();
    const today = new Date();
    const todayKey = formatDateKey(today);

    // 1. Check for Period Start / Cycle Day 1
    const periodStartRegex = /(?:period|cycle|bleeding)\s+(?:started|began|came|arrived|is here)|(?:got|started)\s+my\s+period|day\s*1\s+of\s+(?:my\s+)?cycle/i;
    if (periodStartRegex.test(text)) {
      let targetDate = todayKey;
      if (/\byesterday\b/i.test(text)) {
        targetDate = formatDateKey(addDays(today, -1));
      }

      // Check flow mentioned
      let flow = 'medium';
      if (/\bheavy\b/i.test(text)) flow = 'heavy';
      else if (/\blight\b/i.test(text)) flow = 'light';
      else if (/\bspotting\b/i.test(text)) flow = 'spotting';

      actions.push({
        type: 'UPDATE_PERIOD_START',
        date: targetDate,
        flow
      });
    }

    // 2. Check for Menstrual Flow
    let detectedFlow = null;
    if (/\bheavy\s+(?:flow|bleeding)\b|\bflow\s+is\s+heavy\b|\bheavy\s+period\b/i.test(text)) detectedFlow = 'heavy';
    else if (/\bmedium\s+(?:flow|bleeding)\b|\bflow\s+is\s+medium\b/i.test(text)) detectedFlow = 'medium';
    else if (/\blight\s+(?:flow|bleeding)\b|\bflow\s+is\s+light\b/i.test(text)) detectedFlow = 'light';
    else if (/\bspotting\b/i.test(text)) detectedFlow = 'spotting';

    // 3. Check for Physical Symptoms
    const detectedSymptoms = [];
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

    symptomDictionary.forEach(s => {
      if (s.pattern.test(text) && !detectedSymptoms.includes(s.name)) {
        detectedSymptoms.push(s.name);
      }
    });

    // 4. Check for Moods
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

    moodDictionary.forEach(m => {
      if (m.pattern.test(text) && !detectedMoods.includes(m.name)) {
        detectedMoods.push(m.name);
      }
    });

    // 5. Water & Sleep
    let waterGlasses = null;
    const waterMatch = text.match(/(?:drank|drink|had|log|logged)\s+(\d+)\s*(?:glasses|cups|bottles)/i);
    if (waterMatch) {
      waterGlasses = parseInt(waterMatch[1], 10);
    }

    let sleepHours = null;
    const sleepMatch = text.match(/(?:slept|got)\s+(\d+(?:\.\d+)?)\s*(?:hours|hrs|h)/i);
    if (sleepMatch) {
      sleepHours = parseFloat(sleepMatch[1]);
    }

    // Consolidate daily data log if anything detected
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

    // 6. Check for Cycle Settings (Cycle Length, Period Length, Name)
    const cycleLengthMatch = text.match(/(?:my\s+)?cycle\s+(?:is|length\s+is|lasts?|usually\s+lasts?)\s*(\d{2})\s*days?/i);
    const periodLengthMatch = text.match(/(?:my\s+)?period\s+(?:duration|lasts?|length\s+is)\s*(\d{1,2})\s*days?/i);
    const nameMatch = text.match(/(?:call\s+me|my\s+name\s+is)\s+([A-Za-z]+)/i);

    if (cycleLengthMatch || periodLengthMatch || nameMatch) {
      actions.push({
        type: 'UPDATE_CYCLE_SETTINGS',
        cycleLength: cycleLengthMatch ? parseInt(cycleLengthMatch[1], 10) : undefined,
        periodLength: periodLengthMatch ? parseInt(periodLengthMatch[1], 10) : undefined,
        userName: nameMatch ? nameMatch[1].trim() : undefined
      });
    }

    // 7. Continuous Learning & Insight Extraction
    // Detect preferences: "I prefer chamomile tea", "heating pad helps my cramps", "I avoid coffee", "I usually do yoga"
    const learningTriggers = [
      {
        category: 'remedy_preference',
        pattern: /(?:(?:i\s+prefer|i\s+like|helps?\s+(?:me|my|with))\s+([^.,!]+))/i
      },
      {
        category: 'lifestyle_habit',
        pattern: /(?:i\s+(?:always|usually|tend\s+to|regularly|like\s+to)\s+([^.,!]+))/i
      },
      {
        category: 'sensitivity_trigger',
        pattern: /(?:(?:sensitive\s+to|avoid|makes?\s+(?:my\s+)?(?:cramps|bloating|pain)\s+worse|triggers?)\s+([^.,!]+))/i
      },
      {
        category: 'personal_goal',
        pattern: /(?:(?:my\s+goal\s+is|i'm\s+trying\s+to\s+(?:conceive|track|balance)|tracking\s+for)\s+([^.,!]+))/i
      }
    ];

    learningTriggers.forEach(t => {
      const match = text.match(t.pattern);
      if (match && match[1] && match[1].trim().length > 4 && match[1].trim().length < 80) {
        let fact = match[1].trim();
        if (t.category === 'remedy_preference') {
          fact = `Prefers ${fact} for soothing cycle symptoms`;
        } else if (t.category === 'sensitivity_trigger') {
          fact = `Sensitive to or avoids ${fact}`;
        } else if (t.category === 'personal_goal') {
          fact = `Cycle goal: ${fact}`;
        } else {
          fact = `Habit: ${fact}`;
        }

        actions.push({
          type: 'LEARN_INSIGHT',
          category: t.category,
          fact
        });
      }
    });

    return actions;
  }

  /**
   * Execute structured actions in real time on the application state
   */
  _executeActions(actions, userMessage = '') {
    if (!actions || actions.length === 0) return null;

    const actionSummaries = [];
    const today = new Date();
    const todayKey = formatDateKey(today);

    let cycleUpdated = false;
    let memoriesLearned = [];

    actions.forEach(action => {
      if (action.type === 'UPDATE_PERIOD_START') {
        const targetDate = action.date || todayKey;
        const profile = storage.getProfile();
        profile.lastPeriodStart = targetDate;
        storage.saveProfile(profile);

        // Update target date's log with period flow
        const existingLog = storage.getLog(targetDate) || {};
        storage.saveLog(targetDate, {
          ...existingLog,
          flow: action.flow || 'medium',
          symptoms: existingLog.symptoms && existingLog.symptoms.length > 0 ? existingLog.symptoms : ['Cramps']
        });

        cycleUpdated = true;
        actionSummaries.push({
          icon: '🩸',
          title: 'Period Recorded',
          detail: `Cycle Day 1 started (${targetDate})`
        });
      }

      else if (action.type === 'LOG_DAILY_DATA') {
        const targetDate = action.date || todayKey;
        const existingLog = storage.getLog(targetDate) || {};

        // Merge symptoms
        let mergedSymptoms = existingLog.symptoms ? [...existingLog.symptoms] : [];
        if (action.symptoms && action.symptoms.length > 0) {
          action.symptoms.forEach(s => {
            if (!mergedSymptoms.includes(s)) mergedSymptoms.push(s);
          });
        }

        // Merge moods
        let mergedMoods = existingLog.moods ? [...existingLog.moods] : [];
        if (action.moods && action.moods.length > 0) {
          action.moods.forEach(m => {
            if (!mergedMoods.includes(m)) mergedMoods.push(m);
          });
        }

        const updatedData = {
          ...existingLog,
          flow: action.flow || existingLog.flow || null,
          symptoms: mergedSymptoms,
          moods: mergedMoods,
          waterGlasses: action.waterGlasses !== undefined && action.waterGlasses !== null ? action.waterGlasses : existingLog.waterGlasses,
          sleepHours: action.sleepHours !== undefined && action.sleepHours !== null ? action.sleepHours : existingLog.sleepHours,
          notes: action.notes ? (existingLog.notes ? `${existingLog.notes} • ${action.notes}` : action.notes) : existingLog.notes
        };

        storage.saveLog(targetDate, updatedData);

        const itemsLogged = [];
        if (action.flow) itemsLogged.push(`Flow: ${action.flow}`);
        if (action.symptoms && action.symptoms.length > 0) itemsLogged.push(action.symptoms.join(', '));
        if (action.moods && action.moods.length > 0) itemsLogged.push(action.moods.join(', '));
        if (action.waterGlasses) itemsLogged.push(`${action.waterGlasses} glasses water`);
        if (action.sleepHours) itemsLogged.push(`${action.sleepHours}h sleep`);

        if (itemsLogged.length > 0) {
          cycleUpdated = true;
          actionSummaries.push({
            icon: '📝',
            title: 'Logged for Today',
            detail: itemsLogged.join(' • ')
          });
        }
      }

      else if (action.type === 'UPDATE_CYCLE_SETTINGS') {
        const profile = storage.getProfile();
        let changed = false;
        const settingsDetails = [];

        if (action.cycleLength && action.cycleLength >= 20 && action.cycleLength <= 50) {
          profile.cycleLength = action.cycleLength;
          settingsDetails.push(`Cycle: ${action.cycleLength}d`);
          changed = true;
        }
        if (action.periodLength && action.periodLength >= 2 && action.periodLength <= 10) {
          profile.periodLength = action.periodLength;
          settingsDetails.push(`Period: ${action.periodLength}d`);
          changed = true;
        }
        if (action.userName && action.userName.trim()) {
          profile.userName = action.userName.trim();
          settingsDetails.push(`Name: ${profile.userName}`);
          changed = true;
        }

        if (changed) {
          storage.saveProfile(profile);
          cycleUpdated = true;
          actionSummaries.push({
            icon: '⚙️',
            title: 'Cycle Settings Updated',
            detail: settingsDetails.join(' • ')
          });
        }
      }

      else if (action.type === 'LEARN_INSIGHT') {
        if (action.fact && action.fact.trim()) {
          const memory = storage.addAgentMemory({
            category: action.category || 'general',
            fact: action.fact.trim(),
            source: userMessage ? `User: "${userMessage.substring(0, 40)}..."` : 'Chat dialogue'
          });

          if (memory) {
            memoriesLearned.push(memory);
            actionSummaries.push({
              icon: '🧠',
              title: 'Learned New Insight',
              detail: `"${memory.fact}"`
            });
          }
        }
      }
    });

    if (cycleUpdated || memoriesLearned.length > 0) {
      // Dispatch real-time synchronization event to app.js
      window.dispatchEvent(new CustomEvent('aify:data-updated', {
        detail: {
          actions,
          summaries: actionSummaries,
          source: 'ai-coach'
        }
      }));

      this._updateMemoryCountBadge();
    }

    return actionSummaries.length > 0 ? {
      title: 'Real-Time Cycle Synchronization',
      items: actionSummaries
    } : null;
  }

  /**
   * Send a message to Gemini and get a response with real-time agency
   */
  async sendMessage(userMessage) {
    if (this.isLoading || !userMessage.trim()) return;

    this.isLoading = true;
    const cleanUserMessage = userMessage.trim();

    // 1. Add user message to history
    this.chatHistory.push({
      role: 'user',
      content: cleanUserMessage,
      timestamp: new Date().toISOString()
    });

    this._renderMessages();
    this._showTypingIndicator();
    this._scrollToBottom();

    // 2. Run Instant Local Real-Time Semantic Parser
    const localActions = this._parseLocalActionsAndLearning(cleanUserMessage);
    let actionCard = this._executeActions(localActions, cleanUserMessage);

    try {
      const userContext = this._buildUserContext();

      // Build conversation contents for Gemini
      const contents = [];
      const recentHistory = this.chatHistory.slice(-8);
      for (const msg of recentHistory) {
        contents.push({
          role: msg.role === 'user' ? 'user' : 'model',
          parts: [{ text: msg.content }]
        });
      }

      // Append user cycle context & memories to the last message
      if (contents.length > 0 && contents[contents.length - 1].role === 'user') {
        contents[contents.length - 1].parts[0].text += userContext;
      }

      const requestBody = {
        contents,
        systemInstruction: {
          parts: [{ text: SYSTEM_INSTRUCTION }]
        },
        generationConfig: {
          temperature: 0.7,
          topP: 0.95,
          topK: 40,
          maxOutputTokens: 1024
        }
      };

      const data = await this._callGeminiApi(requestBody);
      const rawAiText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

      // 3. Parse Gemini output for structured action block
      const { cleanedText, modelActions } = this._extractModelActions(rawAiText);

      // Execute any additional actions from the model that local parser didn't catch
      if (modelActions && modelActions.length > 0) {
        const additionalCard = this._executeActions(modelActions, cleanUserMessage);
        if (additionalCard) {
          if (!actionCard) {
            actionCard = additionalCard;
          } else {
            actionCard.items.push(...additionalCard.items);
          }
        }
      }

      // Add AI response with Action Card attached
      this.chatHistory.push({
        role: 'assistant',
        content: cleanedText || this._generateEmpatheticLocalResponse(cleanUserMessage, actionCard),
        actionCard,
        timestamp: new Date().toISOString()
      });

      this._saveChatHistory();
    } catch (error) {
      if (error.message === 'NO_GEMINI_KEY') {
        console.info('Aify: Running in local intelligent cycle mode.');
      } else {
        console.warn('Gemini API call bypassed or failed; local intelligence responded:', error);
      }

      // Local Fallback: Generates a warm, scientifically informed response immediately
      const fallbackText = this._generateEmpatheticLocalResponse(cleanUserMessage, actionCard);

      this.chatHistory.push({
        role: 'assistant',
        content: fallbackText,
        actionCard,
        timestamp: new Date().toISOString()
      });

      this._saveChatHistory();
    } finally {
      this.isLoading = false;
      this._hideTypingIndicator();
      this._renderMessages();
      this._scrollToBottom();
    }
  }

  /**
   * Extract JSON action block from Gemini response
   */
  _extractModelActions(text) {
    let cleanedText = text;
    let modelActions = [];

    const actionBlockRegex = /```(?:json)?(?::agent_actions)?\s*(\{[\s\S]*?"actions"[\s\S]*?\})\s*```/i;
    const match = text.match(actionBlockRegex);

    if (match && match[1]) {
      try {
        const parsed = JSON.parse(match[1]);
        if (parsed.actions && Array.isArray(parsed.actions)) {
          modelActions = parsed.actions;
        }
        cleanedText = text.replace(match[0], '').trim();
      } catch (e) {
        console.warn('Failed to parse model action JSON:', e);
      }
    }

    return { cleanedText, modelActions };
  }

  /**
   * Generates a warm, scientifically informed local fallback response
   */
  _generateEmpatheticLocalResponse(userMessage, actionCard) {
    const profile = storage.getProfile();
    const today = new Date();
    const status = getCycleStatus(today, profile);
    const name = profile.userName || 'there';

    if (actionCard && actionCard.items && actionCard.items.length > 0) {
      const actionTypes = actionCard.items.map(i => i.title);
      let reply = `I've updated your cycle tracking in real time, ${name}! ✨\n\n`;

      if (actionTypes.includes('Period Recorded')) {
        reply += `I've marked today as **Day 1 of your new menstrual cycle**. Your cycle predictions, fertile window, and phases have all been recalibrated. Remember to rest, stay warm, and hydrate gently today. 🌸`;
      } else if (actionTypes.includes('Logged for Today')) {
        reply += `I've securely logged your symptoms and wellbeing details to today's bio-rhythm record. For your current **${status.phase.name}**, remember to listen to your body's natural cues and pace yourself with care. 🌿`;
      } else if (actionTypes.includes('Learned New Insight')) {
        reply += `I've remembered this personal preference and added it to my knowledge of your cycle habits! I'll tailor my future recommendations to support your unique routine. 🧠💖`;
      } else {
        reply += `Your cycle parameters have been updated across the dashboard. Your next predicted period is now scheduled for **${status.nextPeriodStart}**. 🔄`;
      }

      return reply;
    }

    // General fallback advice
    return `Hello ${name}! ✨ You are currently on **Day ${status.cycleDay} (${status.phase.name})**. ${status.phase.description}\n\nFeel free to tell me if your period started, log symptoms (like cramps or fatigue), or share what helps you feel your best so I can learn your preferences!`;
  }

  /**
   * Render the chat interface
   */
  renderChatUI() {
    this._renderMessages();
    this._renderSuggestedQuestions();
    this._updateMemoryCountBadge();
    this.updateEngineBadge();
  }

  /**
   * Render all chat messages with Apple Health-inspired Action Cards
   */
  _renderMessages() {
    const container = document.getElementById('ai-chat-messages');
    if (!container) return;

    if (this.chatHistory.length === 0) {
      container.innerHTML = `
        <div class="ai-chat-empty">
          <div class="ai-chat-empty-icon">🌸</div>
          <h3>Hi! I'm Aify, your wellness guide</h3>
          <p>I learn your cycle patterns, record periods, track symptoms, and personalize your wellness journey in real time.</p>
          <div class="ai-chat-quick-hints">
            <span>✨ "My period started today"</span>
            <span>⚡ "Log heavy cramps & bloating"</span>
            <span>🍵 "I prefer chamomile tea for pain"</span>
          </div>
        </div>
      `;
      return;
    }

    container.innerHTML = this.chatHistory.map((msg, idx) => {
      const isUser = msg.role === 'user';
      const formattedContent = isUser ? this._escapeHtml(msg.content) : this._formatMarkdown(msg.content);
      const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      // Build Action Card HTML if present
      let actionCardHtml = '';
      if (!isUser && msg.actionCard && msg.actionCard.items && msg.actionCard.items.length > 0) {
        actionCardHtml = `
          <div class="agent-action-card">
            <div class="action-card-header">
              <span class="action-card-sparkle">✨</span>
              <span class="action-card-title">Real-Time Cycle Update</span>
              <span class="action-live-indicator"><span class="live-dot"></span> Synchronized</span>
            </div>
            <div class="action-card-chips">
              ${msg.actionCard.items.map(item => `
                <div class="action-chip-item">
                  <span class="action-chip-icon">${item.icon}</span>
                  <div class="action-chip-text">
                    <strong>${this._escapeHtml(item.title)}</strong>
                    <span>${this._escapeHtml(item.detail)}</span>
                  </div>
                </div>
              `).join('')}
            </div>
          </div>
        `;
      }

      return `
        <div class="chat-message ${isUser ? 'chat-message-user' : 'chat-message-ai'}" data-idx="${idx}">
          <div class="chat-bubble ${isUser ? 'bubble-user' : 'bubble-ai'}">
            ${!isUser ? '<div class="chat-ai-avatar">🌸</div>' : ''}
            <div class="chat-bubble-content">
              <div class="chat-text">${formattedContent}</div>
              ${actionCardHtml}
              <span class="chat-time">${time}</span>
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  /**
   * Render suggested questions
   */
  _renderSuggestedQuestions() {
    const container = document.getElementById('ai-suggested-questions');
    if (!container) return;

    // Show 4 suggestions
    const shuffled = [...SUGGESTED_QUESTIONS].sort(() => Math.random() - 0.5).slice(0, 4);

    container.innerHTML = shuffled.map(q => `
      <button class="suggested-question-btn" data-question="${this._escapeHtml(q.text)}">
        <span>${q.icon}</span>
        <span>${q.text}</span>
      </button>
    `).join('');
  }

  /**
   * Update memory count badge on the header button
   */
  _updateMemoryCountBadge() {
    const memories = storage.getAgentMemories();
    const countEl = document.getElementById('agent-memory-count');
    if (countEl) {
      countEl.textContent = memories.length;
    }
  }

  /**
   * Attach event listeners
   */
  attachListeners() {
    const form = document.getElementById('ai-chat-form');
    const input = document.getElementById('ai-chat-input');
    const sendBtn = document.getElementById('ai-chat-send');
    const clearBtn = document.getElementById('ai-chat-clear');
    const memoryBtn = document.getElementById('btn-agent-memory');

    if (form) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        if (input && input.value.trim()) {
          const val = input.value;
          input.value = '';
          this.sendMessage(val);
          this._renderSuggestedQuestions();
        }
      });
    }

    if (sendBtn && input) {
      sendBtn.addEventListener('click', () => {
        if (input.value.trim()) {
          const val = input.value;
          input.value = '';
          this.sendMessage(val);
          this._renderSuggestedQuestions();
        }
      });
    }

    // Suggested questions (delegate)
    const suggestedContainer = document.getElementById('ai-suggested-questions');
    if (suggestedContainer) {
      suggestedContainer.addEventListener('click', (e) => {
        const btn = e.target.closest('.suggested-question-btn');
        if (btn) {
          const question = btn.getAttribute('data-question');
          if (input) input.value = '';
          this.sendMessage(question);
          this._renderSuggestedQuestions();
        }
      });
    }

    // Clear chat
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        if (confirm('Clear all chat history with your AI coach? (Learned health memories will remain safe)')) {
          this.chatHistory = [];
          this._saveChatHistory();
          this._renderMessages();
          this._renderSuggestedQuestions();
        }
      });
    }

    // Agent Memory Bank button
    if (memoryBtn) {
      memoryBtn.addEventListener('click', () => {
        this.openMemoryModal();
      });
    }

    // AI Engine status badge click -> open Settings to configure key
    const engineBadge = document.getElementById('ai-engine-badge');
    if (engineBadge) {
      engineBadge.addEventListener('click', () => {
        const btnSettings = document.getElementById('btn-open-settings');
        if (btnSettings) {
          btnSettings.click();
          setTimeout(() => {
            const aiSec = document.getElementById('setting-ai-section');
            if (aiSec) aiSec.scrollIntoView({ behavior: 'smooth' });
          }, 200);
        }
      });
    }

    // Memory Modal Close
    const closeMemoryBtn = document.getElementById('btn-close-memory-modal');
    if (closeMemoryBtn) {
      closeMemoryBtn.addEventListener('click', () => {
        this.closeMemoryModal();
      });
    }

    // Memory Filter Chips
    const memoryFilters = document.querySelectorAll('.memory-filter-chip');
    memoryFilters.forEach(chip => {
      chip.addEventListener('click', () => {
        memoryFilters.forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        this.activeCategoryFilter = chip.getAttribute('data-category') || 'all';
        this._renderMemoryList();
      });
    });

    // Add Manual Memory Form
    const addMemoryForm = document.getElementById('form-add-memory');
    if (addMemoryForm) {
      addMemoryForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const factInput = document.getElementById('input-memory-fact');
        const catSelect = document.getElementById('select-memory-cat');
        if (factInput && factInput.value.trim()) {
          storage.addAgentMemory({
            category: catSelect ? catSelect.value : 'remedy_preference',
            fact: factInput.value.trim(),
            source: 'Manually added by user'
          });
          factInput.value = '';
          this._renderMemoryList();
          this._updateMemoryCountBadge();
        }
      });
    }
  }

  /**
   * Open the Learned Memory Modal
   */
  openMemoryModal() {
    const modal = document.getElementById('agent-memory-modal');
    if (modal) {
      this._renderMemoryList();
      modal.classList.add('active');
    }
  }

  /**
   * Close the Learned Memory Modal
   */
  closeMemoryModal() {
    const modal = document.getElementById('agent-memory-modal');
    if (modal) {
      modal.classList.remove('active');
    }
  }

  /**
   * Render the list of memories inside the modal
   */
  _renderMemoryList() {
    const container = document.getElementById('agent-memory-list');
    if (!container) return;

    let memories = storage.getAgentMemories();
    if (this.activeCategoryFilter !== 'all') {
      memories = memories.filter(m => m.category === this.activeCategoryFilter);
    }

    if (memories.length === 0) {
      container.innerHTML = `
        <div class="memory-empty-state">
          <span style="font-size: 2rem;">🧠</span>
          <p>No learned insights in this category yet. Chat with Aify or add one below!</p>
        </div>
      `;
      return;
    }

    const categoryIcons = {
      remedy_preference: '🍵',
      cycle_pattern: '🌸',
      lifestyle_habit: '🏃‍♀️',
      personal_goal: '🎯',
      sensitivity_trigger: '⚠️',
      general: '💡'
    };

    const categoryLabels = {
      remedy_preference: 'Remedy & Soothing',
      cycle_pattern: 'Cycle Rhythm',
      lifestyle_habit: 'Lifestyle & Habit',
      personal_goal: 'Health Goal',
      sensitivity_trigger: 'Sensitivity',
      general: 'General Insight'
    };

    container.innerHTML = memories.map(m => `
      <div class="memory-item" data-id="${m.id}">
        <div class="memory-item-left">
          <span class="memory-item-cat-icon">${categoryIcons[m.category] || '💡'}</span>
          <div class="memory-item-content">
            <div class="memory-item-badge">${categoryLabels[m.category] || m.category}</div>
            <p class="memory-item-fact">${this._escapeHtml(m.fact)}</p>
            <span class="memory-item-date">Learned ${new Date(m.createdAt).toLocaleDateString()} • ${this._escapeHtml(m.source || 'Conversation')}</span>
          </div>
        </div>
        <button class="btn-delete-memory" data-id="${m.id}" title="Remove this memory" aria-label="Delete memory">&times;</button>
      </div>
    `).join('');

    // Attach delete listeners
    container.querySelectorAll('.btn-delete-memory').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const id = btn.getAttribute('data-id');
        if (id) {
          storage.deleteAgentMemory(id);
          this._renderMemoryList();
          this._updateMemoryCountBadge();
        }
      });
    });
  }

  // --- Utility Methods ---

  _showTypingIndicator() {
    const container = document.getElementById('ai-chat-messages');
    if (!container) return;

    const indicator = document.createElement('div');
    indicator.id = 'ai-typing-indicator';
    indicator.className = 'chat-message chat-message-ai';
    indicator.innerHTML = `
      <div class="chat-bubble bubble-ai">
        <div class="chat-ai-avatar">🌸</div>
        <div class="chat-bubble-content">
          <div class="typing-dots">
            <span></span><span></span><span></span>
          </div>
        </div>
      </div>
    `;
    container.appendChild(indicator);
  }

  _hideTypingIndicator() {
    const indicator = document.getElementById('ai-typing-indicator');
    if (indicator) indicator.remove();
  }

  _scrollToBottom() {
    const container = document.getElementById('ai-chat-messages');
    if (container) {
      setTimeout(() => {
        container.scrollTop = container.scrollHeight;
      }, 100);
    }
  }

  _formatMarkdown(text) {
    if (!text) return '';
    let html = this._escapeHtml(text);

    // Bold: **text**
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

    // Italic: *text*
    html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');

    // Bullet lists: - item or * item
    html = html.replace(/^[\-\*]\s+(.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>)/gs, '<ul>$1</ul>');
    html = html.replace(/<\/ul>\s*<ul>/g, '');

    // Numbered lists: 1. item
    html = html.replace(/^\d+\.\s+(.+)$/gm, '<li>$1</li>');

    // Line breaks
    html = html.replace(/\n\n/g, '</p><p>');
    html = html.replace(/\n/g, '<br>');

    // Wrap in paragraph
    html = '<p>' + html + '</p>';
    html = html.replace(/<p>\s*<\/p>/g, '');

    return html;
  }

  _escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  _loadChatHistory() {
    this.chatHistory = storage.getChatHistory();
  }

  _saveChatHistory() {
    storage.saveChatHistory(this.chatHistory);
  }

  clearHistory() {
    this.chatHistory = [];
    this._saveChatHistory();
  }
}
