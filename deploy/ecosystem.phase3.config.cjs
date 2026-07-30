module.exports = {
  apps: [{
    name: 'xiansuo-notification-worker',
    script: 'dist/notification-worker.js',
    cwd: process.env.XIANSUO_SERVER_DIR || '/opt/xiansuo/server',
    interpreter: 'node',
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    stop_exit_codes: [0],
    env: {
      NODE_ENV: process.env.NODE_ENV || 'production',
      DB_PATH: process.env.DB_PATH,
      LEAD_POOL_CLAIM_ENABLED: process.env.LEAD_POOL_CLAIM_ENABLED || 'false',
      NOTIFICATION_WORKER_ENABLED: process.env.NOTIFICATION_WORKER_ENABLED || 'false',
      NOTIFICATION_CAPTURE_ENABLED: process.env.NOTIFICATION_CAPTURE_ENABLED || 'false',
      NOTIFICATION_MOCK_ENABLED: process.env.NOTIFICATION_MOCK_ENABLED || 'false',
      NOTIFICATION_SCHEDULER_ENABLED: process.env.NOTIFICATION_SCHEDULER_ENABLED || 'false',
    },
  }],
};
