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
        WEBSITE_LEAD_INGEST_TOKEN: process.env.WEBSITE_LEAD_INGEST_TOKEN,
        WEBSITE_LEAD_OWNER_ID: process.env.WEBSITE_LEAD_OWNER_ID,
        ADMIN_INITIAL_USERNAME: process.env.ADMIN_INITIAL_USERNAME || 'admin',
        ADMIN_INITIAL_NAME: process.env.ADMIN_INITIAL_NAME || '管理员',
        ADMIN_INITIAL_PASSWORD: process.env.ADMIN_INITIAL_PASSWORD,
        UPLOAD_MAX_CONCURRENT: process.env.UPLOAD_MAX_CONCURRENT || '4',
        UPLOAD_MAX_USER_BYTES: process.env.UPLOAD_MAX_USER_BYTES || '104857600',
        UPLOAD_MAX_GLOBAL_BYTES: process.env.UPLOAD_MAX_GLOBAL_BYTES || '1073741824',
        UPLOAD_MAX_USER_FILES: process.env.UPLOAD_MAX_USER_FILES || '100',
        UPLOAD_MAX_GLOBAL_FILES: process.env.UPLOAD_MAX_GLOBAL_FILES || '10000',
        UPLOAD_MIN_FREE_BYTES: process.env.UPLOAD_MIN_FREE_BYTES || '536870912',
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
        HERMES_CHANNEL_ENABLED: process.env.HERMES_CHANNEL_ENABLED || 'false',
        HERMES_BINDING_ENABLED: process.env.HERMES_BINDING_ENABLED || 'false',
        HERMES_GATEWAY_URL: process.env.HERMES_GATEWAY_URL || 'http://127.0.0.1:38116',
        HERMES_GATEWAY_SECRET_FILE: process.env.HERMES_GATEWAY_SECRET_FILE,
        HERMES_INTERNAL_SECRET_FILE: process.env.HERMES_INTERNAL_SECRET_FILE,
        HERMES_ACCOUNT_MANAGER_URL: process.env.HERMES_ACCOUNT_MANAGER_URL || 'http://127.0.0.1:38117',
        HERMES_ACCOUNT_MANAGER_SECRET_FILE: process.env.HERMES_ACCOUNT_MANAGER_SECRET_FILE,
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
