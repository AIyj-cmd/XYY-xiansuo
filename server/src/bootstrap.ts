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

  logger.log(`首次启动：已创建管理员账号 ${identity.username}；请使用受控环境变量中的初始密码登录后立即修改。`);
  return true;
}
