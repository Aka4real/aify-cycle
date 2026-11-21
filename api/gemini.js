/**
 * Vercel Serverless Function: Secure Gemini AI Gateway (/api/gemini)
 * Delegates validation, prompt construction, rate limiting, and cascade failover to lib/gemini.js.
 */

const { applyCors, applySecurityHeaders } = require('../lib/http-security');
const { getGeminiStatus, processGeminiProxyRequest } = require('../lib/gemini');

module.exports = async (req, res) => {
  applySecurityHeaders(res);
  const cors = applyCors(req, res, 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(cors.allowed ? 204 : 403).end();
  }

  if (req.method === 'GET') {
    return res.status(200).json(getGeminiStatus());
  }

  if (req.method === 'POST') {
    if (!cors.allowed) {
      return res.status(403).json({ error: 'ORIGIN_NOT_ALLOWED', message: 'Cross-origin request blocked.' });
    }

    try {
      let parsedBody = req.body;
      if (typeof parsedBody === 'string') {
        parsedBody = JSON.parse(parsedBody || '{}');
      } else if (!parsedBody || typeof parsedBody !== 'object') {
        parsedBody = {};
      }

      const result = await processGeminiProxyRequest(req, parsedBody);
      for (const [k, v] of Object.entries(result.headers || {})) {
        res.setHeader(k, v);
      }
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
