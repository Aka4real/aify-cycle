// api/gemini/status.js - Vercel Serverless Function for Gemini Status Check

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  const GEMINI_MODEL = (process.env.GEMINI_MODEL?.trim() || 'gemini-3.6-flash')
    .replace(/^models\//i, '')
    .trim();
  const isConfigured = Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim());

  return res.status(200).json({
    configured: isConfigured,
    model: GEMINI_MODEL,
    fallbackModels: ['gemini-3.5-flash', 'gemini-2.5-flash'],
    cascadeEnabled: true,
    mode: isConfigured ? 'server_proxy' : 'unconfigured'
  });
};
