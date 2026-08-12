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

// This unit is deliberately separate from API/Worker and is never loaded by
// deploy.sh.  Its environment contains paths only: all credentials stay in
// the 0600 manager JSON named on argv.
const overlayDir = requiredAbsoluteDirectory('XIANSUO_HERMES_TRANSPORT_DIR');
const logDir = requiredAbsoluteDirectory('XIANSUO_HERMES_LOG_DIR');
module.exports = {
  apps: [{
    name: 'xiansuo-hermes-account-manager',
    script: path.join(overlayDir, 'run-account-manager.sh'),
    args: ['--manager-config', requiredAbsolutePath('HERMES_ACCOUNT_MANAGER_CONFIG_FILE')],
    cwd: overlayDir,
    interpreter: 'none', instances: 1, exec_mode: 'fork', autorestart: true, stop_exit_codes: [0],
    kill_timeout: 15000, restart_delay: 5000, max_restarts: 10, min_uptime: '10s', merge_logs: false,
    out_file: path.join(logDir, 'hermes-account-manager.out.log'), error_file: path.join(logDir, 'hermes-account-manager.err.log'), log_date_format: 'YYYY-MM-DD HH:mm:ss',
    env: {
      HERMES_PRIVATE_ROOT: requiredAbsoluteDirectory('XIANSUO_HERMES_PRIVATE_ROOT'),
      HERMES_SOURCE_DIR: requiredAbsoluteDirectory('XIANSUO_HERMES_SOURCE_DIR'),
      HERMES_PYTHON: requiredAbsolutePath('XIANSUO_HERMES_PYTHON'),
    },
  }],
};
