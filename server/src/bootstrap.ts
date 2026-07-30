import type { DatabaseSync } from 'node:sqlite';
import { resolveInitialAdminIdentity, resolveInitialAdminPassword } from './config.js';
import { hashPassword } from './utils/password.js';

type StartupLogger = Pick<Console, 'log'>;

/**
 * 只在完全空的 users 表中创建初始管理员。已有用户时绝不读取、生成或输出密码。
 */
export async function initializeAdmin(db: DatabaseSync, logger: StartupLogger = console): Promise<boolean> {
  const userCount = (db.prepare('SELECT COUNT(*) AS cnt FROM users').get() as { cnt: number }).cnt;
  if (userCount !== 0) return false;

  const identity = resolveInitialAdminIdentity();
  const initialAdmin = resolveInitialAdminPassword();
  const hash = await hashPassword(initialAdmin.password);
  db.prepare(
    'INSERT INTO users (username, name, password_hash, role) VALUES (?,?,?,?)',
  ).run(identity.username, identity.name, hash, 'admin');

  logger.log('======================================================');
  logger.log('首次启动：已自动创建管理员账号');
  logger.log(`用户名: ${identity.username}  初始密码: ${initialAdmin.password}`);
  if (initialAdmin.generated) {
    logger.log('未设置 ADMIN_INITIAL_PASSWORD，以上密码为随机生成且只显示一次');
  }
  logger.log('请登录后立即修改密码！');
  logger.log('======================================================');
  return true;
}
