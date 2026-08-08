import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db.js';
import { authenticate } from '../middleware/auth.js';
import { nowDatetime } from '../utils/datetime.js';

const bodySchema = z.object({
  content: z.string().min(1, '内容不能为空').max(2000, '内容最多2000字'),
});

export async function memoRoutes(app: FastifyInstance) {
  // 获取当前用户的备忘列表
  app.get('/api/memos', { preHandler: authenticate }, async (request, reply) => {
    const user = (request as any).user;
    const db = getDb();
    const rows = db.prepare(
      `SELECT id, content, created_at, updated_at FROM memos WHERE user_id = ? ORDER BY updated_at DESC`
    ).all(user.id);
    return reply.send({ code: 0, data: rows });
  });

  // 新建备忘
  app.post('/api/memos', { preHandler: authenticate }, async (request, reply) => {
    const user = (request as any).user;
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ code: 1, msg: parsed.error.issues[0].message, data: null });
    }
    const db = getDb();
    const now = nowDatetime();
    const result = db.prepare(
      `INSERT INTO memos (user_id, content, created_at, updated_at) VALUES (?,?,?,?)`
    ).run(user.id, parsed.data.content, now, now);
    const row = db.prepare(`SELECT * FROM memos WHERE id = ?`).get(result.lastInsertRowid);
    return reply.send({ code: 0, data: row });
  });

  // 更新备忘
  app.put('/api/memos/:id', { preHandler: authenticate }, async (request, reply) => {
    const user = (request as any).user;
    const id = parseInt((request.params as any).id);
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ code: 1, msg: parsed.error.issues[0].message, data: null });
    }
    const db = getDb();
    const memo = db.prepare(`SELECT id, user_id FROM memos WHERE id = ?`).get(id) as any;
    if (!memo) return reply.status(404).send({ code: 1, msg: '备忘不存在', data: null });
    if (memo.user_id !== user.id) return reply.status(403).send({ code: 1, msg: '无权操作', data: null });
    const now = nowDatetime();
    db.prepare(`UPDATE memos SET content = ?, updated_at = ? WHERE id = ?`)
      .run(parsed.data.content, now, id);
    const row = db.prepare(`SELECT * FROM memos WHERE id = ?`).get(id);
    return reply.send({ code: 0, data: row });
  });

  // 删除备忘
  app.delete('/api/memos/:id', { preHandler: authenticate }, async (request, reply) => {
    const user = (request as any).user;
    const id = parseInt((request.params as any).id);
    const db = getDb();
    const memo = db.prepare(`SELECT id, user_id FROM memos WHERE id = ?`).get(id) as any;
    if (!memo) return reply.status(404).send({ code: 1, msg: '备忘不存在', data: null });
    if (memo.user_id !== user.id) return reply.status(403).send({ code: 1, msg: '无权操作', data: null });
    db.prepare(`DELETE FROM memos WHERE id = ?`).run(id);
    return reply.send({ code: 0, data: null });
  });
}
