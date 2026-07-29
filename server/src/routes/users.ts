import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db.js';
import { hashPassword } from '../utils/password.js';
import { requireAdmin, authenticate } from '../middleware/auth.js';

const createUserSchema = z.object({
  username: z.string().min(2, '用户名至少2位').max(50),
  name: z.string().min(1, '姓名不能为空'),
  password: z.string().min(6, '密码至少6位'),
  role: z.enum(['admin', 'member']).default('member'),
  phone: z.string().optional(),
});

const updateUserSchema = z.object({
  is_active: z.number().int().min(0).max(1).optional(),
  role: z.enum(['admin', 'member']).optional(),
  password: z.string().min(6, '密码至少6位').optional(),
  name: z.string().min(1).optional(),
  phone: z.string().optional(),
});

export async function userRoutes(app: FastifyInstance): Promise<void> {
  // 用户列表（admin）
  app.get('/api/users', { preHandler: requireAdmin }, async (_request, reply) => {
    const db = getDb();
    const users = db.prepare(
      'SELECT id, username, name, phone, role, is_active, created_at FROM users ORDER BY id ASC'
    ).all();
    return reply.send({ code: 0, msg: 'ok', data: users });
  });

  // 新增用户（admin）
  app.post('/api/users', { preHandler: requireAdmin }, async (request, reply) => {
    const result = createUserSchema.safeParse(request.body);
    if (!result.success) {
      return reply.code(400).send({ code: 1, msg: result.error.issues[0].message, data: null });
    }
    const { username, name, password, role, phone } = result.data;
    const db = getDb();

    const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (exists) {
      return reply.send({ code: 1, msg: '用户名已存在', data: null });
    }

    const hash = await hashPassword(password);
    const res = db.prepare(
      'INSERT INTO users (username, name, phone, password_hash, role) VALUES (?,?,?,?,?)'
    ).run(username, name, phone || null, hash, role);

    return reply.send({ code: 0, msg: '用户创建成功', data: { id: res.lastInsertRowid } });
  });

  // 更新用户（admin）：停用/启用/重置密码/改角色
  app.patch('/api/users/:id', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = updateUserSchema.safeParse(request.body);
    if (!result.success) {
      return reply.code(400).send({ code: 1, msg: result.error.issues[0].message, data: null });
    }
    const data = result.data;
    const db = getDb();

    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
    if (!user) return reply.send({ code: 1, msg: '用户不存在', data: null });

    if (data.password !== undefined) {
      data.password = await hashPassword(data.password);
    }

    const fields: string[] = [];
    const values: unknown[] = [];

    if (data.is_active !== undefined) { fields.push('is_active = ?'); values.push(data.is_active); }
    if (data.role !== undefined) { fields.push('role = ?'); values.push(data.role); }
    if (data.password !== undefined) { fields.push('password_hash = ?'); values.push(data.password); }
    if (data.name !== undefined) { fields.push('name = ?'); values.push(data.name); }
    if (data.phone !== undefined) { fields.push('phone = ?'); values.push(data.phone); }

    if (fields.length === 0) return reply.send({ code: 1, msg: '没有要更新的字段', data: null });

    values.push(id);
    db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return reply.send({ code: 0, msg: '更新成功', data: null });
  });

  // 所有成员简要列表（所有登录用户可用，用于公海负责人筛选）
  app.get('/api/users/members', { preHandler: authenticate }, async (_request, reply) => {
    const db = getDb();
    const list = db.prepare('SELECT id, name FROM users WHERE is_active = 1 ORDER BY name ASC').all();
    return reply.send({ code: 0, msg: 'ok', data: list });
  });

  // 当前登录用户信息
  app.get('/api/users/me', { preHandler: authenticate }, async (request, reply) => {
    const db = getDb();
    const user = db.prepare(
      'SELECT id, username, name, phone, role, is_active FROM users WHERE id = ?'
    ).get(request.user.id);
    return reply.send({ code: 0, msg: 'ok', data: user });
  });
}
