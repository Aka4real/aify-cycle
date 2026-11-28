/**
 * Vercel Serverless Function: Admin Executive Overview (/api/admin/overview)
 */
const { handleAdminOverviewRequest } = require('../../lib/admin-router');

module.exports = async (req, res) => handleAdminOverviewRequest(req, res);
