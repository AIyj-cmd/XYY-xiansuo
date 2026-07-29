import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db.js';
import { hashPassword, verifyPassword } from '../utils/password.js';
import { signToken } from '../utils/jwt.js';
import { authenticate } from '../middleware/auth.js';

// 登录失败计数（内存）：{ username -> { count, lockedUntil, lastFailureAt } }
const loginFailures = new Map<string, { count: number; lockedUntil: number; lastFailureAt: number }>();

function checkLock(username: string): boolean {
  const record = loginFailures.get(username);
  if (!record) return false;
  if (record.lockedUntil && Date.now() < record.lockedUntil) return true;
  if (record.lockedUntil && Date.now() >= record.lockedUntil) {
    loginFailures.delete(username);
  }
  return false;
}

function recordFailure(username: string): void {
  const record = loginFailures.get(username) || { count: 0, lockedUntil: 0, lastFailureAt: 0 };
  record.count += 1;
  record.lastFailureAt = Date.now();
  if (record.count >= 5) {
    record.lockedUntil = Date.now() + 10 * 60 * 1000;
    record.count = 0;
  }
  loginFailures.set(username, record);
}

function clearFailure(username: string): void {
  loginFailures.delete(username);
}

// 定期清理过期记录，避免长期运行后 Map 无界增长
const SWEEP_INTERVAL_MS = 30 * 60 * 1000; // 30分钟扫一次
const STALE_AFTER_MS = 60 * 60 * 1000; // 1小时内没有新失败就视为过期
setInterval(() => {
  const now = Date.now();
  for (const [username, record] of loginFailures) {
    const stillLocked = record.lockedUntil > 0 && now < record.lockedUntil;
    if (!stillLocked && now - record.lastFailureAt > STALE_AFTER_MS) {
      loginFailures.delete(username);
    }
  }
}, SWEEP_INTERVAL_MS).unref();

const loginSchema = z.object({
  username: z.string().min(1, '用户名不能为空'),
  password: z.string().min(1, '密码不能为空'),
});

const changePasswordSchema = z.object({
  old_password: z.string().min(1, '旧密码不能为空'),
  new_password: z.string().min(6, '新密码至少6位'),
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/auth/login', async (request, reply) => {
    const result = loginSchema.safeParse(request.body);
    if (!result.success) {
      return reply.code(400).send({ code: 1, msg: result.error.issues[0].message, data: null });
    }
    const { username, password } = result.data;

    if (checkLock(username)) {
      return reply.code(429).send({ code: 1, msg: '账号已锁定，请10分钟后再试', data: null });
    }

    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as any;

    if (!user) {
      recordFailure(username);
      return reply.code(401).send({ code: 1, msg: '用户名或密码错误', data: null });
    }

    if (!user.is_active) {
      return reply.code(401).send({ code: 1, msg: '账号已停用', data: null });
    }

    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) {
      recordFailure(username);
      return reply.code(401).send({ code: 1, msg: '用户名或密码错误', data: null });
    }

    clearFailure(username);
    const token = await signToken({ id: user.id, username: user.username, name: user.name, role: user.role });
    return reply.send({
      code: 0, msg: '登录成功', data: {
        token,
        user: { id: user.id, username: user.username, name: user.name, role: user.role },
      },
    });
  });

  app.post('/api/auth/change-password', { preHandler: authenticate }, async (request, reply) => {
    const result = changePasswordSchema.safeParse(request.body);
    if (!result.success) {
      return reply.code(400).send({ code: 1, msg: result.error.issues[0].message, data: null });
    }
    const { old_password, new_password } = result.data;
    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(request.user.id) as any;

    const valid = await verifyPassword(old_password, user.password_hash);
    if (!valid) {
      return reply.send({ code: 1, msg: '旧密码错误', data: null });
    }

    const newHash = await hashPassword(new_password);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, request.user.id);
    return reply.send({ code: 0, msg: '密码修改成功', data: null });
  });
}
