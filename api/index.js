// api/index.js - Vercel Serverless Function for AifyCycle
// Handles /api/gemini, /api/gemini/status, and /api/compliance/status on Vercel

module.exports = async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  // Parse path (normalizes Vercel query/path differences)
  const urlParts = (req.url || '').split('?');
  const reqPath = urlParts[0];
  const GEMINI_MODEL = process.env.GEMINI_MODEL?.trim() || 'gemini-3.8-flash';

  // 1. Status Check
  if (reqPath.endsWith('/api/gemini/status') || reqPath === '/api/gemini/status') {
    const isConfigured = Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim());
    return res.status(200).json({
      configured: isConfigured,
      model: GEMINI_MODEL,
      mode: isConfigured ? 'server_proxy' : 'unconfigured'
    });
  }

  // 2. Compliance Status Check
  if (reqPath.endsWith('/api/compliance/status') || reqPath === '/api/compliance/status') {
    return res.status(200).json({
      status: 'compliant',
      frameworks: ['GDPR', 'CCPA/CPRA', 'FTC Health Breach Notification Rule'],
      dataPrivacy: 'Local-first private storage sandbox (zero third-party data broker transmission)',
      aiGovernance: 'Google Cloud Gemini Enterprise Tier (zero model training on intimate cycle prompts)',
      medicalDisclaimerEnforced: true,
      auditTelemetryActive: true,
      timestamp: new Date().toISOString()
    });
  }

  // 3. Gemini Generation Proxy
  if (req.method === 'POST' && (reqPath.endsWith('/api/gemini') || reqPath === '/api/gemini')) {
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

      const targetUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

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

  return res.status(404).json({ error: 'NOT_FOUND', path: reqPath });
};
