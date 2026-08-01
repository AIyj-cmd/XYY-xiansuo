// AI Scheduler remains a separate singleton process. API and notification worker
// configs intentionally do not contain DEEPSEEK_API_KEY.
const configured = (name, fallback) => process.env[name] === undefined ? fallback : process.env[name];
module.exports = {
  apps: [{
    name: 'xiansuo-ai-scheduler', script: 'dist/ai-scheduler.js',
    cwd: process.env.XIANSUO_SERVER_DIR || '/opt/xiansuo/server', interpreter: 'node',
    instances: 1, exec_mode: 'fork', autorestart: true, stop_exit_codes: [0],
    env: {
      NODE_ENV: configured('NODE_ENV', 'production'), DB_PATH: process.env.DB_PATH,
      NOTIFICATION_CAPTURE_ENABLED: configured('NOTIFICATION_CAPTURE_ENABLED', 'false'),
      NOTIFICATION_MOCK_ENABLED: configured('NOTIFICATION_MOCK_ENABLED', 'false'),
      OPENCLAW_CHANNEL_ENABLED: configured('OPENCLAW_CHANNEL_ENABLED', 'false'), OPENCLAW_PILOT_USER_ID: process.env.OPENCLAW_PILOT_USER_ID,
      OPENCLAW_GATEWAY_URL: configured('OPENCLAW_GATEWAY_URL', 'http://127.0.0.1:38115'), OPENCLAW_GATEWAY_TIMEOUT_MS: configured('OPENCLAW_GATEWAY_TIMEOUT_MS', '10000'), OPENCLAW_MAX_ATTEMPTS: configured('OPENCLAW_MAX_ATTEMPTS', '2'),
      DEEPSEEK_ENABLED: configured('DEEPSEEK_ENABLED', 'false'), DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
      DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL, DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL,
      AI_REQUEST_TIMEOUT_MS: configured('AI_REQUEST_TIMEOUT_MS', '20000'), AI_MAX_OUTPUT_TOKENS: configured('AI_MAX_OUTPUT_TOKENS', '2048'), AI_MAX_CONTEXT_CHARS: configured('AI_MAX_CONTEXT_CHARS', '12000'), AI_MAX_FOLLOW_UP_RECORDS: configured('AI_MAX_FOLLOW_UP_RECORDS', '3'), AI_MAX_CONCURRENCY: configured('AI_MAX_CONCURRENCY', '2'), AI_DAILY_GLOBAL_LIMIT: configured('AI_DAILY_GLOBAL_LIMIT', '200'), AI_DAILY_USER_LIMIT: configured('AI_DAILY_USER_LIMIT', '4'), AI_AUDIT_RETENTION_DAYS: configured('AI_AUDIT_RETENTION_DAYS', '90'), AI_RESULT_RETENTION_DAYS: configured('AI_RESULT_RETENTION_DAYS', '7'), AI_FALLBACK_ENABLED: configured('AI_FALLBACK_ENABLED', 'true'), AI_TIMEZONE: configured('AI_TIMEZONE', 'Asia/Shanghai'), AI_SCHEDULED_FOLLOW_ENABLED: configured('AI_SCHEDULED_FOLLOW_ENABLED', 'false'), AI_SCHEDULED_FOLLOW_TIME: configured('AI_SCHEDULED_FOLLOW_TIME', '08:30'), AI_DAILY_REPORT_ENABLED: configured('AI_DAILY_REPORT_ENABLED', 'false'), AI_DAILY_REPORT_TIME: configured('AI_DAILY_REPORT_TIME', '18:00'), AI_WEEKLY_REPORT_ENABLED: configured('AI_WEEKLY_REPORT_ENABLED', 'false'), AI_SCAN_RECIPIENT_LIMIT: configured('AI_SCAN_RECIPIENT_LIMIT', '100'), AI_SCAN_DEADLINE_MS: configured('AI_SCAN_DEADLINE_MS', '300000'), AI_PILOT_USER_IDS: configured('AI_PILOT_USER_IDS', ''),
    },
  }],
};
