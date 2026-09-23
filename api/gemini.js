/**
 * Intelligent Multi-Model Cascade for Gemini
 */
async function callGeminiWithCascade(preferredModel, apiKey, requestBody) {
  const cascadeQueue = [
    preferredModel,
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-2.5-flash'
  ];
  const uniqueModels = [...new Set(cascadeQueue.filter(Boolean))];

  let lastResult = null;

  for (const model of uniqueModels) {
    try {
      const targetUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const upstreamRes = await fetch(targetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      });

      const data = await upstreamRes.json();

      if (upstreamRes.ok) {
        return {
          status: 200,
          data: {
            ...data,
            _aify_meta: {
              modelUsed: model,
              requestedModel: preferredModel,
              cascaded: model !== preferredModel
            }
          }
        };
      }

      lastResult = { status: upstreamRes.status, data };

      if ([503, 429, 404].includes(upstreamRes.status)) {
        console.warn(`[Aify AI Cascade] Model '${model}' returned HTTP ${upstreamRes.status}. Failing over to next model in cascade...`);
        continue;
      }

      return { status: upstreamRes.status, data };
    } catch (err) {
      console.warn(`[Aify AI Cascade] Network error for model '${model}':`, err.message);
      lastResult = {
        status: 500,
        data: { error: 'PROXY_NETWORK_ERROR', message: err.message }
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

module.exports = async (req, res) => {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  // Keep the deployed model explicit and normalize dashboard values such as "models/...".
  const GEMINI_MODEL = (process.env.GEMINI_MODEL?.trim() || 'gemini-3.8-flash')
    .replace(/^models\//i, '')
    .trim();

  // If GET request, return status
  if (req.method === 'GET') {
    const isConfigured = Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim());
    return res.status(200).json({
      configured: isConfigured,
      model: GEMINI_MODEL,
      fallbackModels: ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-2.5-flash'],
      cascadeEnabled: true,
      mode: isConfigured ? 'server_proxy' : 'unconfigured'
    });
  }

  // POST request: Proxy to Google Gemini API
  if (req.method === 'POST') {
    const apiKey = process.env.GEMINI_API_KEY?.trim();
    if (!apiKey) {
      return res.status(503).json({
        error: 'NO_API_KEY',
        message: 'No GEMINI_API_KEY configured in server environment or Vercel Environment Variables.'
      });
    }

    try {
      let parsedBody = req.body;
      if (typeof parsedBody === 'string') {
        try {
          parsedBody = JSON.parse(parsedBody);
        } catch (e) {
          parsedBody = {};
        }
      } else if (!parsedBody || typeof parsedBody !== 'object') {
        parsedBody = {};
      }

      const result = await callGeminiWithCascade(GEMINI_MODEL, apiKey, parsedBody);
      return res.status(result.status).json(result.data);
    } catch (err) {
      return res.status(500).json({
        error: 'PROXY_ERROR',
        message: err.message || 'Internal proxy error'
      });
    }
  }

  return res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
};
