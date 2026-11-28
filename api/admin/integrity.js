/**
 * Vercel Serverless Function: Database Integrity Suite (/api/admin/integrity)
 */
const { handleAdminIntegrityRequest } = require('../../lib/admin-router');

module.exports = async (req, res) => handleAdminIntegrityRequest(req, res);
