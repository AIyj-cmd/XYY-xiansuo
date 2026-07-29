import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';

const TAG_COLORS = ['#718096','#2b6cb0','#2f855a','#dd6b20','#6b46c1','#e53e3e','#d69e2e'];

export async function tagRoutes(app: FastifyInstance): Promise<void> {
  // 获取所有标签
  app.get('/api/tags', { preHandler: authenticate }, async (_request, reply) => {
    const db = getDb();
    const list = db.prepare('SELECT * FROM tags ORDER BY name ASC').all();
    return reply.send({ code: 0, msg: 'ok', data: list });
  });

  // 创建标签
  app.post('/api/tags', { preHandler: authenticate }, async (request, reply) => {
    const schema = z.object({
      name: z.string().min(1).max(20),
      color: z.string().optional(),
    });
    const result = schema.safeParse(request.body);
    if (!result.success) return reply.code(400).send({ code: 1, msg: result.error.issues[0].message, data: null });
    const { name, color } = result.data;
    const db = getDb();
    const exists = db.prepare('SELECT id FROM tags WHERE name=?').get(name);
    if (exists) return reply.send({ code: 1, msg: '标签名已存在', data: null });
    const res = db.prepare('INSERT INTO tags (name, color) VALUES (?,?)').run(name, color || TAG_COLORS[0]);
    return reply.send({ code: 0, msg: '创建成功', data: { id: res.lastInsertRowid } });
  });

  // 删除标签（管理员）
  app.delete('/api/tags/:id', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const db = getDb();
    db.prepare('DELETE FROM lead_tags WHERE tag_id=?').run(Number(id));
    db.prepare('DELETE FROM tags WHERE id=?').run(Number(id));
    return reply.send({ code: 0, msg: '已删除', data: null });
  });

  // 获取线索的标签
  app.get('/api/leads/:id/tags', { preHandler: authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const db = getDb();
    const list = db.prepare(`
      SELECT t.* FROM tags t
      INNER JOIN lead_tags lt ON t.id = lt.tag_id
      WHERE lt.lead_id = ?
      ORDER BY t.name
    `).all(Number(id));
    return reply.send({ code: 0, msg: 'ok', data: list });
  });

  // 为线索设置标签（全量替换）
  app.put('/api/leads/:id/tags', { preHandler: authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const schema = z.object({ tag_ids: z.array(z.number().int()).max(10) });
    const result = schema.safeParse(request.body);
    if (!result.success) return reply.code(400).send({ code: 1, msg: result.error.issues[0].message, data: null });
    const db = getDb();

    const lead = db.prepare('SELECT id, owner_id FROM leads WHERE id = ? AND is_deleted = 0').get(Number(id)) as any;
    if (!lead) return reply.code(404).send({ code: 1, msg: '线索不存在', data: null });
    if (request.user.role !== 'admin' && lead.owner_id !== request.user.id) {
      return reply.code(403).send({ code: 1, msg: '无权限修改他人线索标签', data: null });
    }

    // 记录变更前的标签名
    const oldTags = db.prepare(`SELECT t.name FROM tags t INNER JOIN lead_tags lt ON t.id=lt.tag_id WHERE lt.lead_id=?`).all(Number(id)) as any[];
    const oldNames = oldTags.map((t: any) => t.name).join(',') || '无';

    db.prepare('DELETE FROM lead_tags WHERE lead_id=?').run(Number(id));
    for (const tid of result.data.tag_ids) {
      db.prepare('INSERT OR IGNORE INTO lead_tags (lead_id, tag_id) VALUES (?,?)').run(Number(id), tid);
    }

    // 记录变更后的标签名并写操作日志
    const newTags = db.prepare(`SELECT t.name FROM tags t INNER JOIN lead_tags lt ON t.id=lt.tag_id WHERE lt.lead_id=?`).all(Number(id)) as any[];
    const newNames = newTags.map((t: any) => t.name).join(',') || '无';
    db.prepare(`INSERT INTO audit_logs (lead_id, user_id, action, field, old_val, new_val) VALUES (?,?,?,?,?,?)`)
      .run(Number(id), request.user.id, 'update', 'tags', oldNames, newNames);

    return reply.send({ code: 0, msg: '标签已更新', data: null });
  });
}
