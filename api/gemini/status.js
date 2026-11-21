/**
 * Vercel Serverless Function: Gemini Status Check (/api/gemini/status)
 */

const { applyCors, applySecurityHeaders } = require('../../lib/http-security');
const { getGeminiStatus } = require('../../lib/gemini');

module.exports = async (req, res) => {
  applySecurityHeaders(res);
  const cors = applyCors(req, res, 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(cors.allowed ? 204 : 403).end();
  }

  return res.status(200).json(getGeminiStatus());
};
