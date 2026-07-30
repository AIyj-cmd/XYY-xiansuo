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
