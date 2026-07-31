import { randomBytes } from 'crypto';

export function requireJwtSecret(value = process.env.JWT_SECRET): string {
  if (!value) {
    throw new Error('JWT_SECRET 环境变量未设置，拒绝启动（不允许使用不安全的默认密钥）');
  }
  if (Buffer.byteLength(value, 'utf8') < 32) {
    throw new Error('JWT_SECRET 长度至少需要 32 字节');
  }
  return value;
}

export function resolveInitialAdminPassword(
  value = process.env.ADMIN_INITIAL_PASSWORD,
  generate = () => randomBytes(18).toString('base64url'),
): { password: string; generated: boolean } {
  if (value && value.length < 12) {
    throw new Error('ADMIN_INITIAL_PASSWORD 至少需要 12 位');
  }
  if (!value && process.env.NODE_ENV === 'production') {
    throw new Error('生产环境首次初始化必须设置至少 12 位的 ADMIN_INITIAL_PASSWORD');
  }
  return value
    ? { password: value, generated: false }
    : { password: generate(), generated: true };
}

export function resolveInitialAdminIdentity(): { username: string; name: string } {
  const username = process.env.ADMIN_INITIAL_USERNAME || 'admin';
  const name = process.env.ADMIN_INITIAL_NAME || '管理员';
  if (!username.trim() || !name.trim()) {
    throw new Error('ADMIN_INITIAL_USERNAME 和 ADMIN_INITIAL_NAME 不能为空');
  }
  return { username: username.trim(), name: name.trim() };
}

export function resolvePoolIdleDays(value = process.env.POOL_IDLE_DAYS): number {
  const parsed = Number.parseInt(value || '7', 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 365 ? parsed : 7;
}

/** 只接受精确的 true/false，避免环境变量拼写错误悄悄改变业务行为。 */
export function resolveStrictBoolean(name: string, value = process.env[name], defaultValue = false): boolean {
  if (value === undefined || value === '') return defaultValue;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} 只能为 true 或 false，拒绝启动`);
}

export type NotificationConfig = {
  leadPoolClaimEnabled: boolean;
  captureEnabled: boolean;
  workerEnabled: boolean;
  mockEnabled: boolean;
  schedulerEnabled: boolean;
};

export function resolveNotificationConfig(env: NodeJS.ProcessEnv = process.env): NotificationConfig {
  return {
    leadPoolClaimEnabled: resolveStrictBoolean('LEAD_POOL_CLAIM_ENABLED', env.LEAD_POOL_CLAIM_ENABLED),
    captureEnabled: resolveStrictBoolean('NOTIFICATION_CAPTURE_ENABLED', env.NOTIFICATION_CAPTURE_ENABLED),
    workerEnabled: resolveStrictBoolean('NOTIFICATION_WORKER_ENABLED', env.NOTIFICATION_WORKER_ENABLED),
    mockEnabled: resolveStrictBoolean('NOTIFICATION_MOCK_ENABLED', env.NOTIFICATION_MOCK_ENABLED),
    schedulerEnabled: resolveStrictBoolean('NOTIFICATION_SCHEDULER_ENABLED', env.NOTIFICATION_SCHEDULER_ENABLED),
  };
}

export type AiConfig = {
  deepseekEnabled: boolean; apiKey?: string; baseUrl?: string; model?: string;
  requestTimeoutMs: number; maxContextChars: number; maxFollowUpRecords: number; maxConcurrency: number;
  dailyGlobalLimit: number; dailyUserLimit: number; auditRetentionDays: number; resultRetentionDays: number;
  fallbackEnabled: boolean; timezone: 'Asia/Shanghai'; scheduledFollowEnabled: boolean;
  scheduledFollowTime: string; dailyReportEnabled: boolean; dailyReportTime: string;
  weeklyReportEnabled: boolean; scanRecipientLimit: number; scanDeadlineMs: number; pilotUserIds: number[];
};

function strictInteger(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]; if (raw === undefined) return fallback;
  if (!/^[0-9]+$/.test(raw)) throw new Error(`${name} 必须为整数，拒绝启动`);
  const value = Number(raw); if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} 超出允许范围，拒绝启动`);
  return value;
}
function strictTime(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = env[name] === undefined ? fallback : env[name]; if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error(`${name} 必须为 HH:mm，拒绝启动`); return value;
}
function strictUrl(value: string, name: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error(`${name} 必须为合法 HTTPS URL，拒绝启动`); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) throw new Error(`${name} 必须为合法 HTTPS URL，拒绝启动`);
  return parsed.toString().replace(/\/$/, '');
}
function strictAiBoolean(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const value = env[name];
  if (value === undefined) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} 只能为 true 或 false，拒绝启动`);
}
function strictPilotUsers(value: string | undefined): number[] {
  if (value === undefined || value.trim() === '') return [];
  const pieces = value.split(','); const ids = new Set<number>();
  for (const piece of pieces) { if (!/^[1-9]\d*$/.test(piece.trim())) throw new Error('AI_PILOT_USER_IDS 只能为逗号分隔正整数，拒绝启动'); ids.add(Number(piece.trim())); }
  return [...ids].sort((a, b) => a - b);
}

/** AI 配置仅由独立 Scheduler 解析；API 与通知 Worker 不会读取 DeepSeek 密钥。 */
export function resolveAiConfig(env: NodeJS.ProcessEnv = process.env): AiConfig {
  const deepseekEnabled = strictAiBoolean(env, 'DEEPSEEK_ENABLED', false);
  const config: AiConfig = {
    deepseekEnabled,
    requestTimeoutMs: strictInteger(env, 'AI_REQUEST_TIMEOUT_MS', 20_000, 1000, 120_000),
    maxContextChars: strictInteger(env, 'AI_MAX_CONTEXT_CHARS', 12_000, 1, 12_000),
    maxFollowUpRecords: strictInteger(env, 'AI_MAX_FOLLOW_UP_RECORDS', 3, 1, 3),
    maxConcurrency: strictInteger(env, 'AI_MAX_CONCURRENCY', 2, 1, 2),
    dailyGlobalLimit: strictInteger(env, 'AI_DAILY_GLOBAL_LIMIT', 200, 1, 10_000),
    dailyUserLimit: strictInteger(env, 'AI_DAILY_USER_LIMIT', 4, 1, 100),
    auditRetentionDays: strictInteger(env, 'AI_AUDIT_RETENTION_DAYS', 90, 1, 3650),
    resultRetentionDays: strictInteger(env, 'AI_RESULT_RETENTION_DAYS', 7, 1, 90),
    fallbackEnabled: strictAiBoolean(env, 'AI_FALLBACK_ENABLED', true),
    timezone: (() => { const tz = env.AI_TIMEZONE === undefined ? 'Asia/Shanghai' : env.AI_TIMEZONE; if (tz !== 'Asia/Shanghai') throw new Error('AI_TIMEZONE 当前只支持 Asia/Shanghai，拒绝启动'); return tz as 'Asia/Shanghai'; })(),
    scheduledFollowEnabled: strictAiBoolean(env, 'AI_SCHEDULED_FOLLOW_ENABLED', false),
    scheduledFollowTime: strictTime(env, 'AI_SCHEDULED_FOLLOW_TIME', '08:30'),
    dailyReportEnabled: strictAiBoolean(env, 'AI_DAILY_REPORT_ENABLED', false),
    dailyReportTime: strictTime(env, 'AI_DAILY_REPORT_TIME', '18:00'),
    weeklyReportEnabled: strictAiBoolean(env, 'AI_WEEKLY_REPORT_ENABLED', false),
    scanRecipientLimit: strictInteger(env, 'AI_SCAN_RECIPIENT_LIMIT', 100, 1, 100),
    scanDeadlineMs: strictInteger(env, 'AI_SCAN_DEADLINE_MS', 300_000, 1000, 3_600_000),
    pilotUserIds: strictPilotUsers(env.AI_PILOT_USER_IDS),
  };
  if (config.weeklyReportEnabled) throw new Error('AI_WEEKLY_REPORT_ENABLED 在 V1 不支持，拒绝启动');
  const configuredBaseUrl = env.DEEPSEEK_BASE_URL?.trim();
  if (!deepseekEnabled && configuredBaseUrl) config.baseUrl = strictUrl(configuredBaseUrl, 'DEEPSEEK_BASE_URL');
  if (deepseekEnabled) {
    const key = env.DEEPSEEK_API_KEY?.trim(), model = env.DEEPSEEK_MODEL?.trim();
    if (!key || !model || !configuredBaseUrl) throw new Error('DEEPSEEK_ENABLED=true 时必须设置 DEEPSEEK_API_KEY、DEEPSEEK_MODEL 和 DEEPSEEK_BASE_URL');
    config.apiKey = key; config.model = model; config.baseUrl = strictUrl(configuredBaseUrl, 'DEEPSEEK_BASE_URL');
  }
  return config;
}
