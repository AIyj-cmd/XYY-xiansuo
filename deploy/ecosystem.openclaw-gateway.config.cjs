const path = require('node:path');

const requiredAbsoluteDirectory = (name) => {
  const value = process.env[name];
  if (!value || !path.isAbsolute(value)) throw new Error(`${name} must be an absolute repository-external directory`);
  return value;
};

// Experimental internal-only Gateway.  It has no DB_PATH or DeepSeek values.
const configured = (name, fallback) => process.env[name] === undefined ? fallback : process.env[name];
module.exports = {
  apps: [{
    name: 'xiansuo-ilink-gateway', script: 'dist/server.js',
    cwd: requiredAbsoluteDirectory('XIANSUO_ILINK_GATEWAY_DIR'),
    interpreter: 'node', instances: 1, exec_mode: 'fork', autorestart: true, stop_exit_codes: [0], merge_logs: true,
    env: {
      ILINK_GATEWAY_HOST: '127.0.0.1', ILINK_GATEWAY_PORT: configured('ILINK_GATEWAY_PORT', '38115'),
      ILINK_POC_STATE_DIR: process.env.ILINK_POC_STATE_DIR, OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR,
      OPENCLAW_CONFIG_PATH: process.env.OPENCLAW_CONFIG_PATH, OPENCLAW_RECIPIENT_MAP_FILE: process.env.OPENCLAW_RECIPIENT_MAP_FILE, OPENCLAW_PILOT_USER_ID: process.env.OPENCLAW_PILOT_USER_ID,
      ILINK_GATEWAY_SECRET_FILE: process.env.OPENCLAW_GATEWAY_SECRET_FILE,
      ILINK_POC_LIVE_ENABLED: configured('ILINK_POC_LIVE_ENABLED', 'false'), ILINK_OPENCLAW_BIN: configured('ILINK_OPENCLAW_BIN', 'openclaw'),
      ILINK_OPENCLAW_CHANNEL: configured('ILINK_OPENCLAW_CHANNEL', 'openclaw-weixin'), ILINK_POC_RECIPIENT_EXTERNAL_ID: process.env.ILINK_POC_RECIPIENT_EXTERNAL_ID,
      // Must equal the Worker process's OPENCLAW_GATEWAY_SEND_TIMEOUT_MS;
      // its complete window remains below OPENCLAW_GATEWAY_TIMEOUT_MS.
      ILINK_REQUEST_TIMEOUT_MS: configured('ILINK_REQUEST_TIMEOUT_MS', '30000'), ILINK_SESSION_CHECK_TIMEOUT_MS: configured('ILINK_SESSION_CHECK_TIMEOUT_MS', '5000'),
    },
  }],
};
