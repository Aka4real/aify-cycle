/**
 * Vercel Serverless Function: Client Presence Heartbeat & Privacy-Safe Telemetry (/api/telemetry/heartbeat)
 */
const { handleTelemetryHeartbeatRequest } = require('../../lib/admin-router');

module.exports = async (req, res) => handleTelemetryHeartbeatRequest(req, res);
