/**
 * Vercel Serverless Function: Supabase Public Config (/api/supabase/config)
 */

const { applyCors, applySecurityHeaders } = require('../../lib/http-security');

module.exports = async (req, res) => {
  applySecurityHeaders(res);
  const cors = applyCors(req, res, 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(cors.allowed ? 204 : 403).end();
  }

  const supabaseUrl = process.env.SUPABASE_URL?.trim() || '';
  const supabaseAnonKey = (process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || '').trim();
  const isConfigured = Boolean(supabaseUrl && supabaseAnonKey);

  return res.status(200).json({
    configured: isConfigured,
    url: supabaseUrl,
    anonKey: supabaseAnonKey
  });
};
