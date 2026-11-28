/**
 * Vercel Serverless Function: Gemini Model Health & Live Probes (/api/admin/gemini)
 */
const { handleAdminGeminiRequest } = require('../../lib/admin-router');

module.exports = async (req, res) => handleAdminGeminiRequest(req, res);
