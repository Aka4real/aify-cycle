/**
 * Vercel Serverless Function: Deep Product Telemetry, Errors, Runtime & Exports (/api/admin/telemetry)
 */
const { handleAdminTelemetryRequest } = require('../../lib/admin-router');

module.exports = async (req, res) => handleAdminTelemetryRequest(req, res);
