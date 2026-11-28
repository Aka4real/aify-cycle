/**
 * Vercel Serverless Function: Hybrid Admin Auth (/api/admin/auth)
 */
const { handleAdminAuthRequest } = require('../../lib/admin-router');

module.exports = async (req, res) => handleAdminAuthRequest(req, res);
