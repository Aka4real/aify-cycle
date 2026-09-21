// api/gemini.js - Vercel Serverless Function for Gemini 3.8 Flash Proxy

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

      const targetUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(apiKey)}`;

      const upstreamRes = await fetch(targetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsedBody)
      });

      const data = await upstreamRes.json();
      return res.status(upstreamRes.status).json(data);
    } catch (err) {
      return res.status(500).json({
        error: 'PROXY_ERROR',
        message: err.message || 'Internal proxy error'
      });
    }
  }

  return res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
};
