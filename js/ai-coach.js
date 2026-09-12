/**
 * AifyCycle - AI Coach
 * Gemini 2.0 Flash-powered conversational AI health coach for period & cycle Q&A.
 */

import { storage } from './storage.js';
import { getCycleStatus, formatDateKey } from './cycle-engine.js';

const GEMINI_API_KEY = 'AQ.Ab8RN6L7fUT0eesZFPulS1SS9LmzJ2vPCX9MjQ2TaHrY3b87UA';
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;

const SYSTEM_INSTRUCTION = `You are "Aify", a warm, empathetic, and knowledgeable AI menstrual health coach inside the Aify Cycle app. Your personality is supportive, encouraging, and scientifically informed.

Your expertise includes:
- Menstrual cycle phases (menstrual, follicular, ovulatory, luteal) and their hormonal changes
- Period tracking, cycle length variations, and prediction accuracy
- Symptom management (cramps, bloating, headaches, mood swings, fatigue, etc.)
- Nutrition and exercise recommendations optimized for each cycle phase (cycle syncing)
- Fertility awareness and ovulation tracking
- When to seek medical attention for menstrual health concerns
- Emotional wellbeing and self-care during different cycle phases
- PMS and PMDD awareness
- Birth control and its effects on cycles
- Perimenopause and menopause basics

Guidelines:
- Always be supportive, non-judgmental, and body-positive
- Provide evidence-based information while being accessible
- Use emojis naturally to make conversations warm and friendly
- When discussing symptoms, remind users that persistent or severe symptoms warrant consulting a healthcare provider
- NEVER diagnose conditions — suggest consulting a doctor when appropriate
- Keep responses concise but informative (2-4 paragraphs typically)
- Personalize advice based on the user's current cycle phase and data when provided
- Format responses with clear structure using bold text and bullet points when helpful
- You may reference the user by name if provided in the context`;

const SUGGESTED_QUESTIONS = [
  { icon: '🌙', text: 'What phase am I in right now?' },
  { icon: '🥗', text: 'What should I eat during this phase?' },
  { icon: '🏋️', text: 'Best workouts for my current cycle phase?' },
  { icon: '😴', text: 'Why do I feel so tired before my period?' },
  { icon: '💊', text: 'How can I manage menstrual cramps naturally?' },
  { icon: '🌡️', text: 'How does ovulation affect my body?' },
  { icon: '📊', text: 'What is a normal cycle length?' },
  { icon: '🧘', text: 'Self-care tips for my current phase?' },
  { icon: '🤔', text: 'When should I see a doctor about my period?' },
  { icon: '💡', text: 'How can I reduce PMS symptoms?' },
  { icon: '🌿', text: 'Natural remedies for period pain?' },
  { icon: '🔄', text: 'Why is my period irregular?' }
];

export class AICoach {
  constructor() {
    this.chatHistory = [];
    this.isLoading = false;
    this._loadChatHistory();
  }

  /**
   * Initialize the AI Coach UI
   */
  init() {
    this.renderChatUI();
    this.attachListeners();
  }

  /**
   * Build context string from user's cycle data
   */
  _buildUserContext() {
    const profile = storage.getProfile();
    const today = new Date();
    const status = getCycleStatus(today, profile);
    const todayLog = storage.getLog(formatDateKey(today));

    let context = `\n\n--- User Context ---\n`;
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

    if (todayLog) {
      if (todayLog.symptoms && todayLog.symptoms.length > 0) {
        context += `Today's Symptoms: ${todayLog.symptoms.join(', ')}\n`;
      }
      if (todayLog.moods && todayLog.moods.length > 0) {
        context += `Today's Mood: ${todayLog.moods.join(', ')}\n`;
      }
      if (todayLog.flow) {
        context += `Today's Flow: ${todayLog.flow}\n`;
      }
    }

    return context;
  }

  /**
   * Send a message to Gemini and get a response
   */
  async sendMessage(userMessage) {
    if (this.isLoading || !userMessage.trim()) return;

    this.isLoading = true;

    // Add user message to history
    this.chatHistory.push({
      role: 'user',
      content: userMessage.trim(),
      timestamp: new Date().toISOString()
    });

    this._renderMessages();
    this._showTypingIndicator();
    this._scrollToBottom();

    try {
      const userContext = this._buildUserContext();

      // Build conversation contents for Gemini
      const contents = [];

      // Add conversation history (last 10 messages for context window management)
      const recentHistory = this.chatHistory.slice(-10);
      for (const msg of recentHistory) {
        contents.push({
          role: msg.role === 'user' ? 'user' : 'model',
          parts: [{ text: msg.content }]
        });
      }

      // Append context to the last user message
      if (contents.length > 0 && contents[contents.length - 1].role === 'user') {
        contents[contents.length - 1].parts[0].text += userContext;
      }

      const requestBody = {
        contents,
        systemInstruction: {
          parts: [{ text: SYSTEM_INSTRUCTION }]
        },
        generationConfig: {
          temperature: 0.8,
          topP: 0.95,
          topK: 40,
          maxOutputTokens: 1024
        }
      };

      const response = await fetch(GEMINI_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error?.message || `API Error: ${response.status}`);
      }

      const data = await response.json();
      const aiText = data.candidates?.[0]?.content?.parts?.[0]?.text || 'I couldn\'t generate a response right now. Please try again.';

      // Add AI response to history
      this.chatHistory.push({
        role: 'assistant',
        content: aiText,
        timestamp: new Date().toISOString()
      });

      this._saveChatHistory();
    } catch (error) {
      console.error('Gemini API Error:', error);

      this.chatHistory.push({
        role: 'assistant',
        content: `⚠️ I'm having trouble connecting right now. Please check your internet connection and try again.\n\n*Error: ${error.message}*`,
        timestamp: new Date().toISOString()
      });
    } finally {
      this.isLoading = false;
      this._hideTypingIndicator();
      this._renderMessages();
      this._scrollToBottom();
    }
  }

  /**
   * Render the chat interface
   */
  renderChatUI() {
    this._renderMessages();
    this._renderSuggestedQuestions();
  }

  /**
   * Render all chat messages
   */
  _renderMessages() {
    const container = document.getElementById('ai-chat-messages');
    if (!container) return;

    if (this.chatHistory.length === 0) {
      container.innerHTML = `
        <div class="ai-chat-empty">
          <div class="ai-chat-empty-icon">🤖</div>
          <h3>Hi! I'm Aify, your AI health coach</h3>
          <p>Ask me anything about your period, cycle phases, symptoms, nutrition, or wellness. I'm here to help!</p>
        </div>
      `;
      return;
    }

    container.innerHTML = this.chatHistory.map((msg, idx) => {
      const isUser = msg.role === 'user';
      const formattedContent = isUser ? this._escapeHtml(msg.content) : this._formatMarkdown(msg.content);
      const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      return `
        <div class="chat-message ${isUser ? 'chat-message-user' : 'chat-message-ai'}" data-idx="${idx}">
          <div class="chat-bubble ${isUser ? 'bubble-user' : 'bubble-ai'}">
            ${!isUser ? '<div class="chat-ai-avatar">🤖</div>' : ''}
            <div class="chat-bubble-content">
              <div class="chat-text">${formattedContent}</div>
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

    // Show 4 random suggestions
    const shuffled = [...SUGGESTED_QUESTIONS].sort(() => Math.random() - 0.5).slice(0, 4);

    container.innerHTML = shuffled.map(q => `
      <button class="suggested-question-btn" data-question="${this._escapeHtml(q.text)}">
        <span>${q.icon}</span>
        <span>${q.text}</span>
      </button>
    `).join('');
  }

  /**
   * Attach event listeners
   */
  attachListeners() {
    const form = document.getElementById('ai-chat-form');
    const input = document.getElementById('ai-chat-input');
    const sendBtn = document.getElementById('ai-chat-send');
    const clearBtn = document.getElementById('ai-chat-clear');

    if (form) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        if (input && input.value.trim()) {
          this.sendMessage(input.value);
          input.value = '';
          // Refresh suggested questions
          this._renderSuggestedQuestions();
        }
      });
    }

    if (sendBtn && input) {
      sendBtn.addEventListener('click', () => {
        if (input.value.trim()) {
          this.sendMessage(input.value);
          input.value = '';
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
        if (confirm('Clear all chat history with the AI coach?')) {
          this.chatHistory = [];
          this._saveChatHistory();
          this._renderMessages();
          this._renderSuggestedQuestions();
        }
      });
    }
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
        <div class="chat-ai-avatar">🤖</div>
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
    // Simple markdown formatting
    let html = this._escapeHtml(text);

    // Bold: **text**
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

    // Italic: *text*
    html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');

    // Bullet lists: - item or * item
    html = html.replace(/^[\-\*]\s+(.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>)/gs, '<ul>$1</ul>');
    // Clean up nested ul tags
    html = html.replace(/<\/ul>\s*<ul>/g, '');

    // Numbered lists: 1. item
    html = html.replace(/^\d+\.\s+(.+)$/gm, '<li>$1</li>');

    // Line breaks
    html = html.replace(/\n\n/g, '</p><p>');
    html = html.replace(/\n/g, '<br>');

    // Wrap in paragraph
    html = '<p>' + html + '</p>';

    // Clean up empty paragraphs
    html = html.replace(/<p>\s*<\/p>/g, '');

    return html;
  }

  _escapeHtml(text) {
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

  /**
   * Clear all chat history
   */
  clearHistory() {
    this.chatHistory = [];
    this._saveChatHistory();
  }
}
