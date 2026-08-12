import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db.js';
import { hashPassword, PasswordHashBusyError, verifyPassword } from '../utils/password.js';
import { signToken } from '../utils/jwt.js';
import { authenticate } from '../middleware/auth.js';

type Bucket = { tokens: number; updatedAt: number };
const sourceBuckets = new Map<string, Bucket>();
const globalBucket: Bucket = { tokens: 120, updatedAt: Date.now() };
const SOURCE_BUCKET_CAPACITY = 12;
const SOURCE_REFILL_PER_MS = SOURCE_BUCKET_CAPACITY / 60_000;
const GLOBAL_BUCKET_CAPACITY = 120;
const GLOBAL_REFILL_PER_MS = GLOBAL_BUCKET_CAPACITY / 60_000;
function take(bucket: Bucket, capacity: number, refillPerMs: number, now: number): boolean {
  bucket.tokens = Math.min(capacity, bucket.tokens + (now - bucket.updatedAt) * refillPerMs);
  bucket.updatedAt = now;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1; return true;
}
function loginRateAllowed(source: string): boolean {
  const now = Date.now();
  let sourceBucket = sourceBuckets.get(source);
  if (!sourceBucket) {
    if (sourceBuckets.size >= 2048) {
      const oldest = sourceBuckets.keys().next().value as string | undefined;
      if (oldest) sourceBuckets.delete(oldest);
    }
    sourceBucket = { tokens: SOURCE_BUCKET_CAPACITY, updatedAt: now }; sourceBuckets.set(source, sourceBucket);
  } else { sourceBuckets.delete(source); sourceBuckets.set(source, sourceBucket); }
  // Consume the global bucket first: a rejected source must not reach DB or scrypt.
  return take(globalBucket, GLOBAL_BUCKET_CAPACITY, GLOBAL_REFILL_PER_MS, now) && take(sourceBucket, SOURCE_BUCKET_CAPACITY, SOURCE_REFILL_PER_MS, now);
}

const loginSchema = z.object({
  username: z.string().min(1, '用户名不能为空').max(50, '用户名不能超过50位'),
  password: z.string().min(1, '密码不能为空').max(1024, '密码不能超过1024位'),
});

const changePasswordSchema = z.object({
  old_password: z.string().min(1, '旧密码不能为空').max(1024, '旧密码不能超过1024位'),
  new_password: z.string().min(6, '新密码至少6位').max(1024, '新密码不能超过1024位'),
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/auth/login', async (request, reply) => {
    const result = loginSchema.safeParse(request.body);
    if (!result.success) {
      return reply.code(400).send({ code: 1, msg: result.error.issues[0].message, data: null });
    }
    const { username, password } = result.data;
    if (!loginRateAllowed(request.ip)) return reply.code(429).send({ code: 1, msg: '登录请求过于频繁，请稍后再试', data: null });

    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as any;

    if (!user) {
      return reply.code(401).send({ code: 1, msg: '用户名或密码错误', data: null });
    }

    if (!user.is_active) {
      return reply.code(401).send({ code: 1, msg: '账号已停用', data: null });
    }

    let valid: boolean;
    try { valid = await verifyPassword(password, user.password_hash); }
    catch (error) {
      if (error instanceof PasswordHashBusyError) return reply.code(503).send({ code: 1, msg: '验证繁忙，请稍后重试', data: null });
      throw error;
    }
    if (!valid) {
      return reply.code(401).send({ code: 1, msg: '用户名或密码错误', data: null });
    }

    const token = await signToken({ id: user.id, tokenVersion: user.token_version, username: user.username, name: user.name, role: user.role });
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

    let valid: boolean;
    try { valid = await verifyPassword(old_password, user.password_hash); }
    catch (error) { if (error instanceof PasswordHashBusyError) return reply.code(503).send({ code: 1, msg: '验证繁忙，请稍后重试', data: null }); throw error; }
    if (!valid) {
      return reply.send({ code: 1, msg: '旧密码错误', data: null });
    }

    let newHash: string;
    try { newHash = await hashPassword(new_password); }
    catch (error) { if (error instanceof PasswordHashBusyError) return reply.code(503).send({ code: 1, msg: '验证繁忙，请稍后重试', data: null }); throw error; }
    // Compare the old hash in the same statement so concurrent successful
    // requests cannot each increment the version from a stale password check.
    const updated = db.prepare(`UPDATE users
      SET password_hash = ?, token_version = token_version + 1
      WHERE id = ? AND password_hash = ?`).run(newHash, request.user.id, user.password_hash);
    if (updated.changes !== 1) {
      return reply.send({ code: 1, msg: '旧密码错误', data: null });
    }
    return reply.send({ code: 0, msg: '密码修改成功', data: null });
  });
}
