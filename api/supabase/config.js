/**
 * Vercel Serverless Function: Supabase Public Config
 */
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  const supabaseUrl = process.env.SUPABASE_URL?.trim() || '';
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY?.trim() || '';
  const isConfigured = Boolean(supabaseUrl && supabaseAnonKey);

  return res.status(200).json({
    configured: isConfigured,
    url: supabaseUrl,
    anonKey: supabaseAnonKey
  });
};
