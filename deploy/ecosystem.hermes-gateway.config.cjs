const path = require('node:path');

const requiredAbsoluteDirectory = (name) => {
  const value = process.env[name];
  if (!value || !path.isAbsolute(value)) throw new Error(`${name} must be an absolute repository-external directory`);
  return value;
};
const requiredAbsolutePath = (name) => {
  const value = process.env[name];
  if (!value || !path.isAbsolute(value)) throw new Error(`${name} must be an absolute repository-external path`);
  return value;
};

// Separate, disabled-by-default Hermes Gateway.  The wrapper clears inherited
// PM2 shell values before Node starts; it receives paths and fixed switches only.
const gatewayDir = requiredAbsoluteDirectory('XIANSUO_ILINK_GATEWAY_DIR');
const logDir = requiredAbsoluteDirectory('XIANSUO_HERMES_LOG_DIR');
module.exports = {
  apps: [{
    name: 'xiansuo-hermes-gateway', script: path.join(gatewayDir, 'run-hermes-gateway.sh'), cwd: gatewayDir,
    interpreter: 'none', instances: 1, exec_mode: 'fork', autorestart: true, stop_exit_codes: [0],
    kill_timeout: 15000, restart_delay: 5000, max_restarts: 10, min_uptime: '10s', merge_logs: false,
    out_file: path.join(logDir, 'hermes-gateway.out.log'), error_file: path.join(logDir, 'hermes-gateway.err.log'), log_date_format: 'YYYY-MM-DD HH:mm:ss',
    env: {
      XIANSUO_HERMES_GATEWAY_NODE_BIN: requiredAbsolutePath('XIANSUO_HERMES_GATEWAY_NODE_BIN'),
      ILINK_POC_TRANSPORT: 'hermes', ILINK_GATEWAY_HOST: '127.0.0.1', ILINK_GATEWAY_PORT: '38116',
      ILINK_POC_LIVE_ENABLED: 'false', ILINK_HERMES_TRANSPORT_ENABLED: 'false',
      ILINK_REQUEST_TIMEOUT_MS: '30000', ILINK_SESSION_CHECK_TIMEOUT_MS: '5000',
      ILINK_POC_STATE_DIR: requiredAbsoluteDirectory('ILINK_HERMES_LEDGER_DIR'),
      ILINK_GATEWAY_SECRET_FILE: requiredAbsolutePath('HERMES_GATEWAY_SECRET_FILE'),
      ILINK_HERMES_PRIVATE_ROOT: requiredAbsoluteDirectory('XIANSUO_HERMES_PRIVATE_ROOT'),
      ILINK_HERMES_SOURCE_DIR: requiredAbsoluteDirectory('XIANSUO_HERMES_SOURCE_DIR'),
      ILINK_HERMES_PYTHON: requiredAbsolutePath('XIANSUO_HERMES_PYTHON'),
      ILINK_HERMES_CONFIG_FILE: requiredAbsolutePath('HERMES_ACCOUNT_MANAGER_CONFIG_FILE'),
      ILINK_HERMES_STATE_DIR: requiredAbsoluteDirectory('ILINK_HERMES_STATE_DIR'),
    },
  }],
};
