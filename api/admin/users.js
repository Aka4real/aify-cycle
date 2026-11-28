/**
 * Vercel Serverless Function: Admin Users & Live Presence Directory (/api/admin/users)
 */
const { handleAdminUsersRequest } = require('../../lib/admin-router');

module.exports = async (req, res) => handleAdminUsersRequest(req, res);
