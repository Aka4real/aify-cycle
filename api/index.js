// api/index.js - Root API Handler for Vercel
const pathHandler = require('./[...path].js');

module.exports = async (req, res) => {
  return pathHandler(req, res);
};
