const path = require('node:path');

const requiredAbsoluteDirectory = (name) => {
  const value = process.env[name];
  if (!value || !path.isAbsolute(value)) throw new Error(`${name} must be an absolute repository-external directory`);
  return value;
};

module.exports = {
  apps: [
    {
      name: 'xiansuo-api',
      // Set XIANSUO_SERVER_DIR only in the repository-external PM2 environment.
      cwd: requiredAbsoluteDirectory('XIANSUO_SERVER_DIR'),
      script: 'dist/index.js',
      interpreter: 'node',
      env: {
        NODE_ENV: 'production',
        PORT: '3000',
        HOST: '127.0.0.1',
        DB_PATH: process.env.DB_PATH,
        JWT_SECRET: process.env.JWT_SECRET,
        ADMIN_INITIAL_USERNAME: process.env.ADMIN_INITIAL_USERNAME || 'admin',
        ADMIN_INITIAL_NAME: process.env.ADMIN_INITIAL_NAME || '管理员',
        ADMIN_INITIAL_PASSWORD: process.env.ADMIN_INITIAL_PASSWORD,
        POOL_IDLE_DAYS: process.env.POOL_IDLE_DAYS || '7',
        LEAD_POOL_CLAIM_ENABLED: process.env.LEAD_POOL_CLAIM_ENABLED || 'false',
        NOTIFICATION_CAPTURE_ENABLED: process.env.NOTIFICATION_CAPTURE_ENABLED || 'false',
        NOTIFICATION_WORKER_ENABLED: process.env.NOTIFICATION_WORKER_ENABLED || 'false',
        NOTIFICATION_MOCK_ENABLED: process.env.NOTIFICATION_MOCK_ENABLED || 'false',
        NOTIFICATION_SCHEDULER_ENABLED: process.env.NOTIFICATION_SCHEDULER_ENABLED || 'false',
        OPENCLAW_CHANNEL_ENABLED: process.env.OPENCLAW_CHANNEL_ENABLED || 'false',
        OPENCLAW_PILOT_USER_ID: process.env.OPENCLAW_PILOT_USER_ID,
        OPENCLAW_GATEWAY_URL: process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:38115',
        OPENCLAW_GATEWAY_SEND_TIMEOUT_MS: process.env.OPENCLAW_GATEWAY_SEND_TIMEOUT_MS || '30000',
        OPENCLAW_GATEWAY_TIMEOUT_MS: process.env.OPENCLAW_GATEWAY_TIMEOUT_MS || '40000',
        OPENCLAW_MAX_ATTEMPTS: process.env.OPENCLAW_MAX_ATTEMPTS || '2',
        CORS_ORIGINS: process.env.CORS_ORIGINS,
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      max_memory_restart: '512M',
      restart_delay: 3000,
      autorestart: true,
    },
  ],
};
