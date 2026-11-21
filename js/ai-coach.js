/**
 * AifyCycle - AI Coach & Adaptive Wellness Companion
 * Connects to the locked-down server-side /api/gemini gateway,
 * proposes user-confirmed cycle log updates (never mutates health records silently),
 * and provides graceful local fallback when offline.
 */

import { storage } from './storage.js';
import { getCycleStatus, formatDateKey } from './cycle-engine.js';
import { analytics } from './analytics-tracker.js';
import { supabaseService } from './supabase-client.js';
import { escapeHtml } from './dom-utils.js';
import {
  parseProposedActionsFromText,
  sanitizeModelActions,
  mergeProposedActions,
  evaluateFloatingGreetingSchedule,
  buildDiscreetGreetingText
} from './ai-action-parser.js';

const BACKEND_PROXY_URL = '/api/gemini';
const BACKEND_STATUS_URL = '/api/gemini/status';
const GREETING_STORAGE_KEY = 'aifycycle_aify_greeting_v1';

export { evaluateFloatingGreetingSchedule, buildDiscreetGreetingText };

const SUGGESTED_QUESTIONS = [
  { icon: '🩸', text: 'My period started today' },
  { icon: '⚡', text: 'I have cramps and bloating today, flow is heavy' },
  { icon: '🍵', text: 'I prefer chamomile tea and a heating pad for cramps' },
  { icon: '🔄', text: 'My cycle length is 30 days' },
  { icon: '🌙', text: 'What phase am I in right now?' },
  { icon: '🥗', text: 'What should I eat during this phase?' },
  { icon: '🌿', text: 'Best exercises for my current cycle phase?' },
  { icon: '😴', text: 'I slept 6 hours and feel exhausted today' }
];

function formatModelDisplayName(modelId) {
  if (!modelId || typeof modelId !== 'string') return 'Gemini AI';
  return modelId
    .replace(/^models\//i, '')
    .split('-')
    .map(part => (part ? part[0].toUpperCase() + part.slice(1) : ''))
    .join(' ');
}

export class AICoach {
  constructor() {
    this.chatHistory = [];
    this.isLoading = false;
    this.activeCategoryFilter = 'all';
    this._listenersAttached = false;
    this._undoSnapshots = new Map();
    this._isDrawerOpen = false;
    this._greetingTimer = null;
    this._onExpandToTab = null;
    this._getCurrentTab = null;
    this._getUserId = null;
    this._loadChatHistory();
  }

  init(options = {}) {
    if (options.onExpandToTab) this._onExpandToTab = options.onExpandToTab;
    if (options.getCurrentTab) this._getCurrentTab = options.getCurrentTab;
    if (options.getUserId) this._getUserId = options.getUserId;

    this.renderChatUI();
    this.attachListeners();
    this._updateMemoryCountBadge();
    this.updateEngineBadge();
    this._scheduleFloatingGreeting();
  }

  async checkGeminiStatus() {
    try {
      const res = await fetch(BACKEND_STATUS_URL, { method: 'GET' });
      if (res.ok) {
        const data = await res.json();
        if (data.configured) {
          return {
            mode: 'server',
            model: data.model || 'gemini',
            label: formatModelDisplayName(data.model),
            active: true
          };
        }
      }
    } catch (e) {
      // Backend unreachable or static offline mode
    }

    return { mode: 'local', model: 'local', label: 'Local Intelligence', active: false };
  }

  async updateEngineBadge() {
    const badgeEl = document.getElementById('ai-engine-badge');
    const drawerDotEl = document.getElementById('aify-drawer-engine-dot');

    const status = await this.checkGeminiStatus();
    if (badgeEl) {
      if (status.active) {
        badgeEl.className = 'ai-engine-badge badge-active';
        badgeEl.innerHTML = `<span class="engine-dot live"></span><span>✨ ${escapeHtml(status.label)}</span>`;
        badgeEl.title = `Live ${status.label} connected via secure server gateway.`;
      } else {
        badgeEl.className = 'ai-engine-badge badge-local';
        badgeEl.innerHTML = `<span class="engine-dot local"></span><span>🧠 Local Intelligence</span>`;
        badgeEl.title = 'Running in offline local wellness mode.';
      }
    }
    if (drawerDotEl) {
      drawerDotEl.className = status.active ? 'engine-dot live' : 'engine-dot local';
    }
  }

  /**
   * Dispatch structured task request to the locked-down /api/gemini gateway.
   * System instructions, model routing, and token limits are enforced server-side.
   */
  async _callGeminiGateway(payload) {
    const headers = { 'Content-Type': 'application/json' };

    // Attach Supabase JWT when signed in for authenticated rate-limit tier
    try {
      const client = supabaseService.getClient();
      if (client) {
        const { data: { session } } = await client.auth.getSession();
        if (session?.access_token) {
          headers.Authorization = `Bearer ${session.access_token}`;
        }
      }
    } catch (e) {}

    const serverRes = await fetch(BACKEND_PROXY_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });

    const data = await serverRes.json().catch(() => ({}));

    if (serverRes.ok) {
      if (data._aify_meta?.cascaded) {
        console.info(`[Aify AI] Auto-cascaded to ${data._aify_meta.modelUsed}`);
      }
      return data;
    }

    if (data.error === 'NO_API_KEY') {
      throw new Error('NO_GEMINI_KEY');
    }

    throw new Error(data.message || data.error?.message || `Server Proxy Error: ${serverRes.status}`);
  }

  /**
   * Generate dynamic personalized Cycle Syncing insights via server-side prompt builder
   */
  async generateCycleSyncingInsights(status, profile, logs = {}, forceRefresh = false) {
    const phaseKey = status.phase.key;
    const cycleDay = status.cycleDay || 1;
    const cacheKey = `aify_gemini_sync_${phaseKey}_day_${cycleDay}`;

    if (!forceRefresh) {
      try {
        const cached = localStorage.getItem(cacheKey);
        if (cached) {
          const parsed = JSON.parse(cached);
          if (parsed && Array.isArray(parsed.foods) && parsed.foods.length > 0) {
            return parsed;
          }
        }
      } catch (e) {
        console.warn('Cache read error:', e);
      }
    }

    const recentSymptoms = [];
    const today = new Date();
    for (let i = 0; i < 5; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const key = formatDateKey(d);
      const dayLog = logs[key];
      if (dayLog) {
        if (dayLog.symptoms?.length) recentSymptoms.push(...dayLog.symptoms);
        if (dayLog.moods?.length) recentSymptoms.push(...dayLog.moods);
      }
    }

    try {
      const data = await this._callGeminiGateway({
        task: 'cycle_sync',
        context: {
          userName: profile.userName || 'User',
          phaseName: status.phase.name,
          phaseTagline: status.phase.tagline,
          cycleDay,
          cycleLength: status.cycleLength,
          periodLength: profile.periodLength || 5,
          recentSymptoms: [...new Set(recentSymptoms)].join(', '),
          nextPeriodStart: status.nextPeriodStart,
          isLate: Boolean(status.isLate)
        }
      });

      const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      let parsedJson = null;
      try {
        parsedJson = JSON.parse(rawText.trim());
      } catch (jsonErr) {
        const jsonMatch = rawText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          parsedJson = JSON.parse(jsonMatch[0]);
        }
      }

      if (parsedJson && Array.isArray(parsedJson.foods) && parsedJson.foods.length > 0) {
        try {
          localStorage.setItem(cacheKey, JSON.stringify(parsedJson));
        } catch (e) {}

        analytics.trackEvent('cycle', 'gemini_syncing_generated', status.phase.key, { cycleDay });
        analytics.logAuditAction('AI_SYNC_GENERATED', `AI wrote personalized insights for Day ${cycleDay}`);
        return parsedJson;
      }
    } catch (err) {
      console.warn('AI Cycle Syncing generation bypassed or failed, using baseline guide:', err.message);
    }

    return null;
  }

  _buildUserContext() {
    const profile = storage.getProfile();
    const logs = storage.getAllLogs();
    const today = new Date();
    const status = getCycleStatus(today, profile, logs);
    const todayLog = logs[formatDateKey(today)] || null;
    const memories = storage.getAgentMemories();

    let context = `--- User Context ---\n`;
    context += `Name: ${profile.userName || 'User'}\n`;
    context += `Today: ${formatDateKey(today)}\n`;
    context += `Cycle Day: ${status.cycleDay ?? 'Unknown'} of ${status.cycleLength}\n`;
    context += `Current Phase: ${status.phase.name}${status.isLate ? ` (${status.daysLate} days late)` : ''}\n`;
    context += `Estimated Fertility: ${status.fertilityChance} (calendar estimate only)\n`;
    context += `Days Until Est. Next Period: ${status.daysUntilNextPeriod ?? 'Unknown'}\n`;
    context += `Est. Next Period: ${status.nextPeriodStart}\n`;
    context += `Average Cycle Length: ${status.cycleLength} days\n`;
    context += `Average Period Length: ${status.periodLength} days\n`;
    context += `Last Period Start: ${profile.lastPeriodStart || 'Not set'}\n`;

    if (todayLog) {
      if (todayLog.symptoms?.length) context += `Today's Symptoms: ${todayLog.symptoms.join(', ')}\n`;
      if (todayLog.moods?.length) context += `Today's Moods: ${todayLog.moods.join(', ')}\n`;
      if (todayLog.flow) context += `Today's Flow: ${todayLog.flow}\n`;
      if (todayLog.waterGlasses) context += `Water Logged: ${todayLog.waterGlasses} glasses\n`;
      if (todayLog.sleepHours) context += `Sleep Logged: ${todayLog.sleepHours} hours\n`;
    }

    if (memories.length > 0) {
      context += `\n--- Saved Personal Notes ---\n`;
      memories.slice(0, 10).forEach(m => {
        context += `- [${m.category}] ${m.fact}\n`;
      });
    }

    return context;
  }

  /**
   * Build human-readable summary chips for proposed actions (without writing yet)
   */
  _describeActions(actions) {
    if (!Array.isArray(actions) || actions.length === 0) return [];
    const items = [];

    for (const action of actions) {
      if (action.type === 'UPDATE_PERIOD_START') {
        items.push({
          icon: '🩸',
          title: 'Set Period Start',
          detail: `Cycle Day 1 on ${action.date} (flow: ${action.flow || 'medium'})`
        });
      } else if (action.type === 'LOG_DAILY_DATA') {
        const parts = [];
        if (action.flow) parts.push(`Flow: ${action.flow}`);
        if (action.symptoms?.length) parts.push(action.symptoms.join(', '));
        if (action.moods?.length) parts.push(action.moods.join(', '));
        if (action.waterGlasses !== null && action.waterGlasses !== undefined) parts.push(`${action.waterGlasses} glasses water`);
        if (action.sleepHours !== null && action.sleepHours !== undefined) parts.push(`${action.sleepHours}h sleep`);
        if (action.notes) parts.push(`Note: "${action.notes.slice(0, 50)}"`);
        if (parts.length > 0) {
          items.push({
            icon: '📝',
            title: `Daily Log (${action.date})`,
            detail: parts.join(' • ')
          });
        }
      } else if (action.type === 'UPDATE_CYCLE_SETTINGS') {
        const parts = [];
        if (action.cycleLength) parts.push(`Cycle: ${action.cycleLength}d`);
        if (action.periodLength) parts.push(`Period: ${action.periodLength}d`);
        if (action.userName) parts.push(`Name: ${action.userName}`);
        if (parts.length > 0) {
          items.push({
            icon: '⚙️',
            title: 'Update Profile Settings',
            detail: parts.join(' • ')
          });
        }
      } else if (action.type === 'LEARN_INSIGHT') {
        items.push({
          icon: '🧠',
          title: 'Save Personal Note',
          detail: `"${action.fact}"`
        });
      }
    }

    return items;
  }

  /**
   * Execute user-confirmed actions on storage and capture an undo snapshot
   */
  _executeActions(actions, userMessage = '') {
    if (!actions || actions.length === 0) return null;

    const snapshot = {
      profile: JSON.parse(JSON.stringify(storage.getProfile())),
      logs: JSON.parse(JSON.stringify(storage.getAllLogs())),
      memories: JSON.parse(JSON.stringify(storage.getAgentMemories()))
    };

    const actionSummaries = [];
    const todayKey = formatDateKey(new Date());
    let cycleUpdated = false;
    let memoriesLearned = [];

    actions.forEach(action => {
      if (action.type === 'UPDATE_PERIOD_START') {
        const targetDate = action.date || todayKey;
        const profile = storage.getProfile();
        profile.lastPeriodStart = targetDate;
        storage.saveProfile(profile);

        // Record flow ONLY — never fabricate symptoms like 'Cramps'
        const existingLog = storage.getLog(targetDate) || {};
        storage.saveLog(targetDate, {
          ...existingLog,
          flow: action.flow || 'medium'
        });

        cycleUpdated = true;
        actionSummaries.push({
          icon: '🩸',
          title: 'Period Recorded',
          detail: `Cycle Day 1 started (${targetDate})`
        });
      } else if (action.type === 'LOG_DAILY_DATA') {
        const targetDate = action.date || todayKey;
        const existingLog = storage.getLog(targetDate) || {};

        const mergedSymptoms = [...new Set([...(existingLog.symptoms || []), ...(action.symptoms || [])])];
        const mergedMoods = [...new Set([...(existingLog.moods || []), ...(action.moods || [])])];

        const updatedData = {
          ...existingLog,
          flow: action.flow || existingLog.flow || null,
          symptoms: mergedSymptoms,
          moods: mergedMoods,
          waterGlasses: action.waterGlasses !== undefined && action.waterGlasses !== null ? action.waterGlasses : existingLog.waterGlasses,
          sleepHours: action.sleepHours !== undefined && action.sleepHours !== null ? action.sleepHours : existingLog.sleepHours,
          notes: action.notes
            ? (existingLog.notes && !existingLog.notes.includes(action.notes)
              ? `${existingLog.notes} • ${action.notes}`
              : (existingLog.notes || action.notes))
            : existingLog.notes
        };

        storage.saveLog(targetDate, updatedData);
        cycleUpdated = true;
        actionSummaries.push({
          icon: '📝',
          title: 'Logged',
          detail: `${targetDate}`
        });
      } else if (action.type === 'UPDATE_CYCLE_SETTINGS') {
        const profile = storage.getProfile();
        let changed = false;
        const details = [];

        if (action.cycleLength >= 21 && action.cycleLength <= 45) {
          profile.cycleLength = action.cycleLength;
          details.push(`Cycle: ${action.cycleLength}d`);
          changed = true;
        }
        if (action.periodLength >= 2 && action.periodLength <= 10) {
          profile.periodLength = action.periodLength;
          details.push(`Period: ${action.periodLength}d`);
          changed = true;
        }
        if (action.userName && action.userName.trim()) {
          profile.userName = action.userName.trim();
          details.push(`Name: ${profile.userName}`);
          changed = true;
        }

        if (changed) {
          storage.saveProfile(profile);
          cycleUpdated = true;
          actionSummaries.push({
            icon: '⚙️',
            title: 'Settings Updated',
            detail: details.join(' • ')
          });
        }
      } else if (action.type === 'LEARN_INSIGHT') {
        if (action.fact && action.fact.trim()) {
          const memory = storage.addAgentMemory({
            category: action.category || 'general',
            fact: action.fact.trim(),
            source: userMessage ? `Chat: "${userMessage.substring(0, 40)}"` : 'Chat dialogue'
          });
          if (memory) {
            memoriesLearned.push(memory);
            actionSummaries.push({
              icon: '🧠',
              title: 'Saved Note',
              detail: `"${memory.fact}"`
            });
          }
        }
      }
    });

    if (cycleUpdated || memoriesLearned.length > 0) {
      window.dispatchEvent(new CustomEvent('aify:data-updated', {
        detail: { actions, summaries: actionSummaries, source: 'ai-coach' }
      }));
      this._updateMemoryCountBadge();
    }

    return { summaries: actionSummaries, snapshot };
  }

  _applyMessageProposal(msgIdx) {
    const msg = this.chatHistory[msgIdx];
    if (!msg?.actionCard || msg.actionCard.status !== 'pending') return;

    const result = this._executeActions(msg.actionCard.actions, msg.actionCard.sourceMessage || '');
    if (result?.snapshot) {
      this._undoSnapshots.set(msgIdx, result.snapshot);
    }
    msg.actionCard.status = 'applied';
    this._saveChatHistory();
    this._renderMessages();
  }

  _dismissMessageProposal(msgIdx) {
    const msg = this.chatHistory[msgIdx];
    if (!msg?.actionCard || msg.actionCard.status !== 'pending') return;

    msg.actionCard.status = 'dismissed';
    this._saveChatHistory();
    this._renderMessages();
  }

  _undoMessageProposal(msgIdx) {
    const msg = this.chatHistory[msgIdx];
    const snapshot = this._undoSnapshots.get(msgIdx);
    if (!msg?.actionCard || !snapshot) return;

    storage.saveProfile(snapshot.profile);
    storage.saveAllLogs(snapshot.logs);
    storage.saveAgentMemories(snapshot.memories);
    this._undoSnapshots.delete(msgIdx);

    msg.actionCard.status = 'pending';
    this._saveChatHistory();
    this._updateMemoryCountBadge();
    window.dispatchEvent(new CustomEvent('aify:data-updated', {
      detail: { actions: [], summaries: [{ icon: '↩️', title: 'Reverted', detail: 'AI log update undone' }], source: 'ai-coach' }
    }));
    this._renderMessages();
  }

  async sendMessage(userMessage) {
    if (this.isLoading || !userMessage.trim()) return;

    this.isLoading = true;
    const cleanUserMessage = userMessage.trim();

    this.chatHistory.push({
      role: 'user',
      content: cleanUserMessage,
      timestamp: new Date().toISOString()
    });

    this._renderMessages();
    this._showTypingIndicator();
    this._scrollToBottom();

    // Parse PROPOSED actions locally without mutating storage yet
    const localActions = parseProposedActionsFromText(cleanUserMessage, new Date());
    const startTime = Date.now();

    try {
      const userContext = this._buildUserContext();
      const recentHistory = this.chatHistory.slice(-8).map(msg => ({
        role: msg.role === 'user' ? 'user' : 'model',
        text: msg.content
      }));

      const data = await this._callGeminiGateway({
        task: 'chat',
        history: recentHistory,
        userContext
      });

      const rawAiText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const { cleanedText, modelActions } = this._extractModelActions(rawAiText);
      const validModelActions = sanitizeModelActions(modelActions, new Date());
      const proposedActions = mergeProposedActions(localActions, validModelActions);
      const items = this._describeActions(proposedActions);

      const actionCard = items.length > 0
        ? {
            title: 'Proposed Cycle Update',
            status: 'pending',
            sourceMessage: cleanUserMessage,
            actions: proposedActions,
            items
          }
        : null;

      this.chatHistory.push({
        role: 'assistant',
        content: cleanedText || this._generateEmpatheticLocalResponse(cleanUserMessage, actionCard),
        actionCard,
        timestamp: new Date().toISOString()
      });

      this._saveChatHistory();

      const latencyMs = Date.now() - startTime;
      analytics.trackEvent('ai_coach', 'query_sent', 'chat_message', { mode: 'server', latencyMs });
      analytics.logAuditAction('AI_QUERY_LIVE', `AI Coach responded in ${latencyMs}ms`);
    } catch (error) {
      if (error.message === 'NO_GEMINI_KEY') {
        console.info('Aify: Running in local wellness mode.');
      } else {
        console.warn('AI gateway unavailable; local wellness mode responded:', error.message);
      }

      const items = this._describeActions(localActions);
      const actionCard = items.length > 0
        ? {
            title: 'Proposed Cycle Update',
            status: 'pending',
            sourceMessage: cleanUserMessage,
            actions: localActions,
            items
          }
        : null;

      const fallbackText = this._generateEmpatheticLocalResponse(cleanUserMessage, actionCard);

      this.chatHistory.push({
        role: 'assistant',
        content: fallbackText,
        actionCard,
        timestamp: new Date().toISOString()
      });

      this._saveChatHistory();

      analytics.trackEvent('ai_coach', 'query_sent', 'chat_message', { mode: 'local' });
      analytics.logAuditAction('AI_QUERY_LOCAL', 'Local wellness mode responded');
    } finally {
      this.isLoading = false;
      this._hideTypingIndicator();
      this._renderMessages();
      this._scrollToBottom();
    }
  }

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

  _generateEmpatheticLocalResponse(userMessage, actionCard) {
    const profile = storage.getProfile();
    const logs = storage.getAllLogs();
    const today = new Date();
    const status = getCycleStatus(today, profile, logs);
    const name = profile.userName || 'there';

    if (actionCard && actionCard.items && actionCard.items.length > 0) {
      return `Got it, ${name}! ✨ I drafted the cycle update below based on your message — tap **Save to Log** if everything looks right, or **Dismiss** to skip it.`;
    }

    if (status.isLate) {
      return `Hi ${name}! Your period is currently **${status.daysLate} ${status.daysLate === 1 ? 'day' : 'days'} past** your estimated cycle length. Small shifts can happen due to stress, sleep, or travel — let me know when it starts so I can draft a log entry, or consider checking with a clinician if you have concerns.`;
    }

    return `Hello ${name}! ✨ You are currently on **Day ${status.cycleDay} (${status.phase.name})**. ${status.phase.description}\n\nTell me if your period started, share symptoms like cramps or fatigue, or ask any wellness question — I'll always ask before saving changes to your logs.`;
  }

  renderChatUI() {
    this._renderMessages();
    this._renderSuggestedQuestions();
    this._updateMemoryCountBadge();
    this.updateEngineBadge();
  }

  _renderMessages() {
    const containers = [
      document.getElementById('ai-chat-messages'),
      document.getElementById('aify-drawer-messages')
    ].filter(Boolean);
    if (containers.length === 0) return;

    if (this.chatHistory.length === 0) {
      const emptyHtml = `
        <div class="ai-chat-empty">
          <div class="ai-chat-empty-icon">🌸</div>
          <h3>Hi! I'm AiFy, your wellness guide</h3>
          <p>Ask cycle questions or tell me about symptoms — I'll draft log updates for you to confirm before saving.</p>
          <div class="ai-chat-quick-hints">
            <span>✨ "My period started today"</span>
            <span>⚡ "I have cramps and bloating today"</span>
            <span>🍵 "I prefer chamomile tea for cramps"</span>
          </div>
        </div>
      `;
      containers.forEach(c => { c.innerHTML = emptyHtml; });
      return;
    }

    const html = this.chatHistory.map((msg, idx) => {
      const isUser = msg.role === 'user';
      const formattedContent = isUser ? escapeHtml(msg.content) : this._formatMarkdown(msg.content);
      const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      let actionCardHtml = '';
      if (!isUser && msg.actionCard && msg.actionCard.items && msg.actionCard.items.length > 0) {
        const cardStatus = msg.actionCard.status || 'applied';
        const hasUndo = this._undoSnapshots.has(idx);

        let statusBadge = '<span class="action-live-indicator"><span class="live-dot"></span> Saved</span>';
        let controlsHtml = '';

        if (cardStatus === 'pending') {
          statusBadge = '<span class="action-live-indicator">Confirm to Save</span>';
          controlsHtml = `
            <div style="display:flex; gap:0.5rem; margin-top:0.6rem;">
              <button type="button" class="btn-primary btn-apply-actions" data-msg-idx="${idx}" style="padding:0.35rem 0.75rem; font-size:0.78rem;">✓ Save to Log</button>
              <button type="button" class="btn-secondary btn-dismiss-actions" data-msg-idx="${idx}" style="padding:0.35rem 0.75rem; font-size:0.78rem;">Dismiss</button>
            </div>
          `;
        } else if (cardStatus === 'dismissed') {
          statusBadge = '<span class="action-live-indicator" style="opacity:0.7;">Dismissed</span>';
        } else if (hasUndo) {
          controlsHtml = `
            <div style="margin-top:0.45rem;">
              <button type="button" class="btn-ghost btn-undo-actions" data-msg-idx="${idx}" style="font-size:0.74rem; padding:0.2rem 0.4rem; text-decoration:underline;">↩ Undo this update</button>
            </div>
          `;
        }

        actionCardHtml = `
          <div class="agent-action-card" style="${cardStatus === 'dismissed' ? 'opacity:0.6;' : ''}">
            <div class="action-card-header">
              <span class="action-card-sparkle">✨</span>
              <span class="action-card-title">${cardStatus === 'pending' ? 'Proposed Cycle Update' : 'Cycle Update'}</span>
              ${statusBadge}
            </div>
            <div class="action-card-chips">
              ${msg.actionCard.items.map(item => `
                <div class="action-chip-item">
                  <span class="action-chip-icon">${escapeHtml(item.icon || '✨')}</span>
                  <div class="action-chip-text">
                    <strong>${escapeHtml(item.title)}</strong>
                    <span>${escapeHtml(item.detail)}</span>
                  </div>
                </div>
              `).join('')}
            </div>
            ${controlsHtml}
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
              <span class="chat-time">${escapeHtml(time)}</span>
            </div>
          </div>
        </div>
      `;
    }).join('');

    containers.forEach(c => { c.innerHTML = html; });
  }

  _renderSuggestedQuestions() {
    const containers = [
      document.getElementById('ai-suggested-questions'),
      document.getElementById('aify-drawer-suggestions')
    ].filter(Boolean);
    if (containers.length === 0) return;

    const shuffled = [...SUGGESTED_QUESTIONS].sort(() => Math.random() - 0.5).slice(0, 4);
    const html = shuffled.map(q => `
      <button type="button" class="suggested-question-btn" data-question="${escapeHtml(q.text)}">
        <span>${q.icon}</span>
        <span>${escapeHtml(q.text)}</span>
      </button>
    `).join('');

    containers.forEach(c => { c.innerHTML = html; });
  }

  _updateMemoryCountBadge() {
    const memories = storage.getAgentMemories();
    const countEl = document.getElementById('agent-memory-count');
    if (countEl) {
      countEl.textContent = memories.length;
    }
  }

  attachListeners() {
    if (this._listenersAttached) return;
    this._listenersAttached = true;

    const form = document.getElementById('ai-chat-form');
    const input = document.getElementById('ai-chat-input');
    const clearBtn = document.getElementById('ai-chat-clear');
    const memoryBtn = document.getElementById('btn-agent-memory');
    const messagesContainer = document.getElementById('ai-chat-messages');
    const drawerMessagesContainer = document.getElementById('aify-drawer-messages');

    // Delegated handlers for Confirm / Dismiss / Undo buttons on AI action cards (main tab & drawer)
    const handleActionCardClick = (e) => {
      const applyBtn = e.target.closest('.btn-apply-actions');
      if (applyBtn) {
        const idx = parseInt(applyBtn.getAttribute('data-msg-idx'), 10);
        if (!Number.isNaN(idx)) this._applyMessageProposal(idx);
        return;
      }
      const dismissBtn = e.target.closest('.btn-dismiss-actions');
      if (dismissBtn) {
        const idx = parseInt(dismissBtn.getAttribute('data-msg-idx'), 10);
        if (!Number.isNaN(idx)) this._dismissMessageProposal(idx);
        return;
      }
      const undoBtn = e.target.closest('.btn-undo-actions');
      if (undoBtn) {
        const idx = parseInt(undoBtn.getAttribute('data-msg-idx'), 10);
        if (!Number.isNaN(idx)) this._undoMessageProposal(idx);
      }
    };

    if (messagesContainer) messagesContainer.addEventListener('click', handleActionCardClick);
    if (drawerMessagesContainer) drawerMessagesContainer.addEventListener('click', handleActionCardClick);

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

    this._attachFloatingAssistantListeners();

    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        if (confirm('Clear all chat history with your AI coach? (Saved personal notes will remain safe)')) {
          this.chatHistory = [];
          this._undoSnapshots.clear();
          this._saveChatHistory();
          this._renderMessages();
          this._renderSuggestedQuestions();
        }
      });
    }

    if (memoryBtn) {
      memoryBtn.addEventListener('click', () => {
        this.openMemoryModal();
      });
    }

    const engineBadge = document.getElementById('ai-engine-badge');
    if (engineBadge) {
      engineBadge.addEventListener('click', () => {
        const modal = document.getElementById('modal-ai-architecture');
        if (modal) modal.classList.add('active');
      });
    }

    const closeMemoryBtn = document.getElementById('btn-close-memory-modal');
    if (closeMemoryBtn) {
      closeMemoryBtn.addEventListener('click', () => {
        this.closeMemoryModal();
      });
    }

    const memoryFilters = document.querySelectorAll('.memory-filter-chip');
    memoryFilters.forEach(chip => {
      chip.addEventListener('click', () => {
        memoryFilters.forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        this.activeCategoryFilter = chip.getAttribute('data-category') || 'all';
        this._renderMemoryList();
      });
    });

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

  openMemoryModal() {
    const modal = document.getElementById('agent-memory-modal');
    if (modal) {
      this._renderMemoryList();
      modal.classList.add('active');
    }
  }

  closeMemoryModal() {
    const modal = document.getElementById('agent-memory-modal');
    if (modal) modal.classList.remove('active');
  }

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
          <p>No saved insights in this category yet. Chat with Aify or add one below!</p>
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
      <div class="memory-item" data-id="${escapeHtml(m.id)}">
        <div class="memory-item-left">
          <span class="memory-item-cat-icon">${categoryIcons[m.category] || '💡'}</span>
          <div class="memory-item-content">
            <div class="memory-item-badge">${escapeHtml(categoryLabels[m.category] || m.category)}</div>
            <p class="memory-item-fact">${escapeHtml(m.fact)}</p>
            <span class="memory-item-date">Saved ${escapeHtml(new Date(m.createdAt).toLocaleDateString())} • ${escapeHtml(m.source || 'Conversation')}</span>
          </div>
        </div>
        <button class="btn-delete-memory" data-id="${escapeHtml(m.id)}" title="Remove this note" aria-label="Delete note">&times;</button>
      </div>
    `).join('');

    container.querySelectorAll('.btn-delete-memory').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-id');
        if (id) {
          storage.deleteAgentMemory(id);
          this._renderMemoryList();
          this._updateMemoryCountBadge();
        }
      });
    });
  }

  _showTypingIndicator() {
    this._hideTypingIndicator();
    const pairs = [
      { container: document.getElementById('ai-chat-messages'), id: 'ai-typing-indicator' },
      { container: document.getElementById('aify-drawer-messages'), id: 'aify-drawer-typing-indicator' }
    ];

    pairs.forEach(({ container, id }) => {
      if (!container) return;
      const indicator = document.createElement('div');
      indicator.id = id;
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
    });
  }

  _hideTypingIndicator() {
    ['ai-typing-indicator', 'aify-drawer-typing-indicator'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.remove();
    });
  }

  _scrollToBottom() {
    ['ai-chat-messages', 'aify-drawer-messages'].forEach(id => {
      const container = document.getElementById(id);
      if (container) {
        setTimeout(() => {
          container.scrollTop = container.scrollHeight;
        }, 100);
      }
    });
  }

  // =========================================================================
  // FLOATING AIFY ASSISTANT (ORB + DISCREET GREETING + MINI-CHAT DRAWER)
  // =========================================================================

  _attachFloatingAssistantListeners() {
    const orb = document.getElementById('aify-floating-orb');
    const acceptBtn = document.getElementById('btn-aify-greeting-accept');
    const dismissBtn = document.getElementById('btn-aify-greeting-dismiss');
    const closeGreetingBtn = document.getElementById('btn-aify-greeting-close');
    const drawerCloseBtn = document.getElementById('btn-aify-drawer-close');
    const drawerExpandBtn = document.getElementById('btn-aify-drawer-expand');
    const drawerForm = document.getElementById('aify-drawer-form');
    const drawerInput = document.getElementById('aify-drawer-input');
    const drawerSuggestions = document.getElementById('aify-drawer-suggestions');

    if (orb) {
      orb.addEventListener('click', () => {
        if (this._isDrawerOpen) {
          this.closeFloatingDrawer();
        } else {
          this.openFloatingDrawer();
        }
      });
    }

    if (acceptBtn) {
      acceptBtn.addEventListener('click', () => {
        this._markGreetingSeen();
        this.hideFloatingGreeting();
        this.openFloatingDrawer();
      });
    }

    if (dismissBtn) {
      dismissBtn.addEventListener('click', () => {
        this._markGreetingSeen();
        this.hideFloatingGreeting();
      });
    }

    if (closeGreetingBtn) {
      closeGreetingBtn.addEventListener('click', () => {
        this._markGreetingSeen();
        this.hideFloatingGreeting();
      });
    }

    if (drawerCloseBtn) {
      drawerCloseBtn.addEventListener('click', () => {
        this.closeFloatingDrawer();
      });
    }

    if (drawerExpandBtn) {
      drawerExpandBtn.addEventListener('click', () => {
        this.closeFloatingDrawer();
        if (typeof this._onExpandToTab === 'function') {
          this._onExpandToTab();
        }
      });
    }

    if (drawerForm) {
      drawerForm.addEventListener('submit', (e) => {
        e.preventDefault();
        if (drawerInput && drawerInput.value.trim()) {
          const val = drawerInput.value;
          drawerInput.value = '';
          this.sendMessage(val);
          this._renderSuggestedQuestions();
        }
      });
    }

    if (drawerSuggestions) {
      drawerSuggestions.addEventListener('click', (e) => {
        const btn = e.target.closest('.suggested-question-btn');
        if (btn) {
          const question = btn.getAttribute('data-question');
          if (drawerInput) drawerInput.value = '';
          this.sendMessage(question);
          this._renderSuggestedQuestions();
        }
      });
    }
  }

  _getGreetingState() {
    try {
      const raw = localStorage.getItem(GREETING_STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  }

  _saveGreetingState(state) {
    try {
      localStorage.setItem(GREETING_STORAGE_KEY, JSON.stringify(state));
    } catch (e) {}
  }

  _markGreetingSeen() {
    if (this._pendingGreetingState) {
      this._saveGreetingState(this._pendingGreetingState);
      this._pendingGreetingState = null;
    } else {
      const userKey = typeof this._getUserId === 'function' ? this._getUserId() : 'guest';
      const evalRes = evaluateFloatingGreetingSchedule({
        state: this._getGreetingState(),
        userKey,
        now: new Date()
      });
      this._saveGreetingState(evalRes.nextState);
    }
  }

  _scheduleFloatingGreeting() {
    if (this._greetingTimer) {
      clearTimeout(this._greetingTimer);
    }
    this._greetingTimer = setTimeout(() => {
      this.maybeShowFloatingGreeting();
    }, 1500);
  }

  maybeShowFloatingGreeting() {
    const currentTab = typeof this._getCurrentTab === 'function' ? this._getCurrentTab() : 'dial';
    if (currentTab === 'ai-coach' || this._isDrawerOpen) return;

    const greetingEl = document.getElementById('aify-floating-greeting');
    const textEl = document.getElementById('aify-greeting-text');
    if (!greetingEl || !textEl) return;

    const userKey = typeof this._getUserId === 'function' ? this._getUserId() : 'guest';
    const now = new Date();
    const evalRes = evaluateFloatingGreetingSchedule({
      state: this._getGreetingState(),
      userKey,
      now
    });

    if (!evalRes.shouldShow) return;

    const profile = storage.getProfile();
    const sessionUser = storage.getAuthSession()?.user;
    const userName = profile.userName || sessionUser?.name || '';

    textEl.textContent = buildDiscreetGreetingText({
      userName,
      isFirstLogin: evalRes.isFirstLogin,
      hour: now.getHours()
    });

    // Record slot immediately so page reloads within the same slot don't re-pop the bubble
    this._pendingGreetingState = evalRes.nextState;
    this._saveGreetingState(evalRes.nextState);
    greetingEl.style.display = 'block';
  }

  hideFloatingGreeting() {
    const greetingEl = document.getElementById('aify-floating-greeting');
    if (greetingEl) greetingEl.style.display = 'none';
  }

  openFloatingDrawer() {
    const drawer = document.getElementById('aify-floating-drawer');
    const orb = document.getElementById('aify-floating-orb');
    const input = document.getElementById('aify-drawer-input');

    this.hideFloatingGreeting();
    this._isDrawerOpen = true;
    if (drawer) drawer.style.display = 'flex';
    if (orb) orb.style.display = 'none';
    this._renderMessages();
    this._scrollToBottom();
    if (input) setTimeout(() => input.focus(), 80);
  }

  closeFloatingDrawer() {
    const drawer = document.getElementById('aify-floating-drawer');
    const orb = document.getElementById('aify-floating-orb');

    this._isDrawerOpen = false;
    if (drawer) drawer.style.display = 'none';
    const currentTab = typeof this._getCurrentTab === 'function' ? this._getCurrentTab() : 'dial';
    if (orb && currentTab !== 'ai-coach') {
      orb.style.display = 'inline-flex';
    }
  }

  onTabChanged(tabId) {
    const dock = document.getElementById('aify-floating-dock');
    const orb = document.getElementById('aify-floating-orb');
    if (!dock) return;

    if (tabId === 'ai-coach') {
      this.closeFloatingDrawer();
      this.hideFloatingGreeting();
      dock.style.display = 'none';
    } else {
      dock.style.display = 'flex';
      if (orb && !this._isDrawerOpen) {
        orb.style.display = 'inline-flex';
      }
    }
  }

  _formatMarkdown(text) {
    if (!text) return '';
    let html = escapeHtml(text);

    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
    html = html.replace(/^[\-\*]\s+(.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>)/gs, '<ul>$1</ul>');
    html = html.replace(/<\/ul>\s*<ul>/g, '');
    html = html.replace(/^\d+\.\s+(.+)$/gm, '<li>$1</li>');
    html = html.replace(/\n\n/g, '</p><p>');
    html = html.replace(/\n/g, '<br>');
    html = '<p>' + html + '</p>';
    html = html.replace(/<p>\s*<\/p>/g, '');

    return html;
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
