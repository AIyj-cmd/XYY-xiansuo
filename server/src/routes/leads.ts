import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db.js';
import { authenticate } from '../middleware/auth.js';
import { nowDatetime } from '../utils/datetime.js';
import { resolveNotificationConfig, resolvePoolIdleDays } from '../config.js';
import { randomUUID } from 'node:crypto';
import { assertActiveOwner, OwnerTransferError, transferLeadOwner } from '../services/lead-owner.js';
import { recomputeFollowUpDerived } from '../services/follow-up-derived.js';
import { getLeadDetail, listLeads } from '../services/lead-query-service.js';

import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

function addLog(db: DatabaseSync, leadId: number, userId: number, action: string, field?: string, oldVal?: string, newVal?: string) {
  db.prepare(`INSERT INTO audit_logs (lead_id, user_id, action, field, old_val, new_val) VALUES (?,?,?,?,?,?)`)
    .run(leadId, userId, action, field ?? null, oldVal ?? null, newVal ?? null);
}

const STATUS_VALUES = ['新线索', '跟进中', '已报价', '已成交', '已流失', '暂搁置', '停止跟进'] as const;
const INTENT_VALUES = ['高', '中', '低', '未知'] as const;
const FOLLOW_TYPE_VALUES = ['电话', '微信', '拜访', '其他'] as const;
const POOL_IDLE_DAYS = resolvePoolIdleDays();

// 手机号选填：小红书私信这类线索初期往往只有微信号，没有手机号。
// 空字符串会被当成"未填写"归一化为 undefined，避免多条空手机号撞唯一索引。
const optionalPhone = z.string()
  .optional()
  .transform(v => (v && v.trim() !== '' ? v.trim() : undefined))
  .refine(v => !v || /^1\d{10}$/.test(v), { message: '手机号格式错误（11位，1开头）' });

const leadCreateSchema = z.object({
  contact_name: z.string().min(1, '联系人不能为空'),
  phone: optionalPhone,
  wechat: z.string().optional(),
  company_name: z.string().optional(),
  industry: z.string().optional(),
  source: z.string().min(1, '线索来源不能为空'),
  source_note: z.string().optional(),
  demand_note: z.string().optional(),
  intent_level: z.enum(INTENT_VALUES).default('未知'),
  status: z.enum(STATUS_VALUES).default('新线索'),
  owner_id: z.number().int().optional(),
  lead_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式错误'),
  next_follow_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
});

const leadUpdateSchema = leadCreateSchema.partial();

const checkPhoneQuerySchema = z.object({
  phone: z.string().optional(),
  exclude_id: z.coerce.number({ error: 'exclude_id 必须是数字' }).int('exclude_id 必须是整数').positive('exclude_id 必须为正数').optional(),
});

const leadsListQuerySchema = z.object({
  page: z.coerce.number({ error: '页码必须是数字' }).int('页码必须是整数').min(1, '页码最小为1').default(1),
  pageSize: z.coerce.number({ error: '每页条数必须是数字' }).int('每页条数必须是整数').min(1, '每页至少1条').max(100, '每页最多100条').default(20),
  keyword: z.string().optional(),
  status: z.string().optional(),
  source: z.string().optional(),
  owner_id: z.coerce.number({ error: '负责人ID必须是数字' }).int('负责人ID必须是整数').optional(),
  industry: z.string().optional(),
  intent: z.string().optional(),
  tag_id: z.coerce.number({ error: '标签ID必须是数字' }).int('标签ID必须是整数').optional(),
  sort: z.enum(['last_follow', 'lead_date', 'next_follow', 'created_new'], { error: '排序方式不合法' }).optional(),
  order: z.enum(['asc', 'desc'], { error: '排序方向不合法' }).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式错误').optional(),
  // 用字符串 '1' 而不是 z.coerce.boolean()：query string 里 "false" 也是非空字符串，
  // coerce.boolean 会把它当 truthy，反而是错的
  favorite_only: z.string().optional(),
});

const poolQuerySchema = z.object({
  days: z.coerce.number({ error: 'days 必须是数字' })
    .int('days 必须是整数')
    .min(POOL_IDLE_DAYS, `公海阈值不能少于 ${POOL_IDLE_DAYS} 天`)
    .max(365, 'days 最大为365')
    .default(POOL_IDLE_DAYS),
});

const followUpSchema = z.object({
  type: z.enum(FOLLOW_TYPE_VALUES).default('电话'),
  content: z.string().min(1, '跟进内容不能为空'),
  result: z.string().optional(),
  next_follow_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  status: z.enum(STATUS_VALUES),
  images: z.array(z.string()).max(9, '最多上传9张图片').optional(),
  amount: z.number().positive().optional(),
});

export async function leadRoutes(app: FastifyInstance): Promise<void> {

  // 手机号查重
  app.get('/api/leads/check-phone', { preHandler: authenticate }, async (request, reply) => {
    const parsed = checkPhoneQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ code: 1, msg: parsed.error.issues[0].message, data: null });
    }
    const { phone, exclude_id } = parsed.data;
    if (!phone) return reply.send({ code: 0, msg: 'ok', data: null });

    const db = getDb();
    let sql = 'SELECT l.id, l.company_name, l.contact_name, l.phone, u.name AS owner_name FROM leads l LEFT JOIN users u ON l.owner_id = u.id WHERE l.phone = ?';
    const params: SQLInputValue[] = [phone];
    if (exclude_id) { sql += ' AND l.id != ?'; params.push(exclude_id); }

    const lead = db.prepare(sql).get(...params) as any;
    return reply.send({ code: 0, msg: 'ok', data: lead || null });
  });

  // 线索列表（分页/筛选/搜索/排序）
  app.get('/api/leads', { preHandler: authenticate }, async (request, reply) => {
    const parsed = leadsListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ code: 1, msg: parsed.error.issues[0].message, data: null });
    }
    return reply.send({ code: 0, msg: 'ok', data: listLeads(getDb(), parsed.data, request.user.id) });
  });

  // 新增线索
  app.post('/api/leads', { preHandler: authenticate }, async (request, reply) => {
    const result = leadCreateSchema.safeParse(request.body);
    if (!result.success) {
      return reply.code(400).send({ code: 1, msg: result.error.issues[0].message, data: null });
    }
    const data = result.data;
    if (!data.phone && !data.wechat) {
      return reply.code(400).send({ code: 1, msg: '手机号和微信号至少填写一项', data: null });
    }
    const db = getDb();

    if (data.phone) {
      const existing = db.prepare('SELECT id, company_name, contact_name FROM leads WHERE phone = ?').get(data.phone) as any;
      if (existing) {
        return reply.send({ code: 1, msg: `该手机号已存在：${existing.company_name || existing.contact_name}`, data: { existing_id: existing.id } });
      }
    }

    const ownerId = data.owner_id ?? request.user.id;
    if (request.user.role !== 'admin' && ownerId !== request.user.id) {
      return reply.code(403).send({ code: 1, msg: '普通用户只能创建自己负责的线索', data: null });
    }
    try {
      assertActiveOwner(db, ownerId);
    } catch (error) {
      if (error instanceof OwnerTransferError) {
        return reply.code(400).send({ code: 1, msg: error.message, data: null });
      }
      throw error;
    }
    let insertId: number;
    try {
      const res = db.prepare(`
        INSERT INTO leads (company_name, contact_name, phone, wechat, industry, source, source_note, demand_note, intent_level, status, owner_id, lead_date, next_follow_at, next_follow_at_source, created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        data.company_name || null, data.contact_name, data.phone || null,
        data.wechat || null, data.industry || null, data.source,
        data.source_note || null, data.demand_note || null,
        data.intent_level, data.status, ownerId, data.lead_date,
        data.next_follow_at || null, data.next_follow_at ? 'manual' : null, request.user.id
      );
      insertId = Number(res.lastInsertRowid);
    } catch (err) {
      // 并发提交同一手机号：前面的查重来不及拦截，靠唯一索引兜底，转成友好提示而不是 500
      if (err instanceof Error && /UNIQUE constraint failed.*leads\.phone/.test(err.message)) {
        return reply.send({ code: 1, msg: '该手机号已存在，请刷新后重试', data: null });
      }
      throw err;
    }

    addLog(db, insertId, request.user.id, 'create');
    return reply.send({ code: 0, msg: '线索创建成功', data: { id: insertId } });
  });

  // 线索详情
  app.get('/api/leads/:id', { preHandler: authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const lead = getLeadDetail(getDb(), Number(id), request.user.id) as any;

    if (!lead) return reply.code(404).send({ code: 1, msg: '线索不存在', data: null });
    return reply.send({ code: 0, msg: 'ok', data: lead });
  });

  // 收藏 / 取消收藏（谁都能收藏任意能看到的线索，不受负责人限制）
  app.post('/api/leads/:id/favorite', { preHandler: authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const db = getDb();
    const lead = db.prepare('SELECT id FROM leads WHERE id = ? AND is_deleted = 0').get(Number(id));
    if (!lead) return reply.code(404).send({ code: 1, msg: '线索不存在', data: null });
    db.prepare('INSERT OR IGNORE INTO favorites (user_id, lead_id) VALUES (?, ?)').run(request.user.id, Number(id));
    return reply.send({ code: 0, msg: '已收藏', data: null });
  });

  app.delete('/api/leads/:id/favorite', { preHandler: authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const db = getDb();
    db.prepare('DELETE FROM favorites WHERE user_id = ? AND lead_id = ?').run(request.user.id, Number(id));
    return reply.send({ code: 0, msg: '已取消收藏', data: null });
  });

  // 编辑线索基础信息
  app.patch('/api/leads/:id', { preHandler: authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = leadUpdateSchema.safeParse(request.body);
    if (!result.success) {
      return reply.code(400).send({ code: 1, msg: result.error.issues[0].message, data: null });
    }
    const data = result.data;
    const db = getDb();

    const lead = db.prepare('SELECT id, owner_id FROM leads WHERE id = ? AND is_deleted = 0').get(Number(id)) as any;
    if (!lead) return reply.code(404).send({ code: 1, msg: '线索不存在', data: null });

    if (request.user.role !== 'admin' && lead.owner_id !== request.user.id) {
      return reply.code(403).send({ code: 1, msg: '无权限修改他人线索', data: null });
    }

    // 手机号查重
    if (data.phone) {
      const dup = db.prepare('SELECT id FROM leads WHERE phone = ? AND id != ?').get(data.phone, Number(id));
      if (dup) return reply.send({ code: 1, msg: '该手机号已被其他线索使用', data: null });
    }

    const fields: string[] = [];
    const values: SQLInputValue[] = [];
    const fieldMap: Record<string, string> = {
      company_name: 'company_name', contact_name: 'contact_name', phone: 'phone',
      wechat: 'wechat', industry: 'industry', source: 'source', source_note: 'source_note',
      demand_note: 'demand_note', intent_level: 'intent_level', status: 'status',
      lead_date: 'lead_date', next_follow_at: 'next_follow_at',
    };

    for (const [k, col] of Object.entries(fieldMap)) {
      if (k in data) {
        fields.push(`${col} = ?`);
        values.push((data as any)[k] ?? null);
      }
    }
    if ('next_follow_at' in data) {
      fields.push('next_follow_at_source = ?');
      values.push(data.next_follow_at ? 'manual' : null);
    }

    const transferringOwner = 'owner_id' in data;
    if (fields.length === 0 && !transferringOwner) return reply.send({ code: 1, msg: '没有要更新的字段', data: null });

    if (transferringOwner && data.owner_id === undefined) {
      return reply.code(400).send({ code: 1, msg: '负责人不能为空', data: null });
    }

    // 读取更新前的值用于日志
    const before = db.prepare('SELECT * FROM leads WHERE id = ?').get(Number(id)) as any;

    const now = nowDatetime();
    try {
      db.exec('BEGIN IMMEDIATE;');
      if (fields.length > 0) {
        const updateValues = [...values, now, Number(id)];
        db.prepare(`UPDATE leads SET ${fields.join(', ')}, updated_at = ? WHERE id = ?`).run(...updateValues);
      }
      if (transferringOwner) {
        transferLeadOwner(db, {
          leadId: Number(id),
          newOwnerId: data.owner_id!,
          actorUserId: request.user.id,
          source: 'single_edit',
          operationId: randomUUID(),
          updatedAt: now,
        });
      }

      // 负责人变更只由统一服务记录，避免同一次请求重复写 transfer 审计。
      for (const k of Object.keys(fieldMap)) {
        if (k in data && String((data as any)[k] ?? '') !== String(before[k] ?? '')) {
          addLog(db, Number(id), request.user.id, 'update', k, String(before[k] ?? ''), String((data as any)[k] ?? ''));
        }
      }
      db.exec('COMMIT;');
    } catch (err) {
      try { db.exec('ROLLBACK;'); } catch { /* no open transaction */ }
      // 并发编辑撞上同一手机号：前面的查重来不及拦截，靠唯一索引兜底
      if (err instanceof Error && /UNIQUE constraint failed.*leads\.phone/.test(err.message)) {
        return reply.send({ code: 1, msg: '该手机号已被其他线索使用，请刷新后重试', data: null });
      }
      if (err instanceof OwnerTransferError) {
        return reply.code(err.kind === 'lead_not_found' ? 404 : err.kind === 'concurrent_change' ? 409 : 400)
          .send({ code: 1, msg: err.message, data: null });
      }
      throw err;
    }

    return reply.send({ code: 0, msg: '更新成功', data: null });
  });

  // 软删除（admin）
  // 软删除：admin 可删任意线索；普通用户只能删自己负责的线索
  app.delete('/api/leads/:id', { preHandler: authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const db = getDb();

    const lead = db.prepare('SELECT id, owner_id FROM leads WHERE id = ? AND is_deleted = 0').get(Number(id)) as any;
    if (!lead) return reply.code(404).send({ code: 1, msg: '线索不存在', data: null });

    if (request.user.role !== 'admin' && lead.owner_id !== request.user.id) {
      return reply.code(403).send({ code: 1, msg: '无权限删除他人线索', data: null });
    }

    db.prepare('UPDATE leads SET is_deleted = 1, updated_at = ? WHERE id = ?').run(nowDatetime(), Number(id));
    addLog(db, Number(id), request.user.id, 'delete');
    return reply.send({ code: 0, msg: '已删除', data: null });
  });

  // 恢复（admin）
  // 恢复：admin 可恢复任意线索；普通用户只能恢复自己负责的线索
  app.post('/api/leads/:id/restore', { preHandler: authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const db = getDb();

    const lead = db.prepare('SELECT id, owner_id FROM leads WHERE id = ? AND is_deleted = 1').get(Number(id)) as any;
    if (!lead) return reply.code(404).send({ code: 1, msg: '回收站中没有这条线索', data: null });

    if (request.user.role !== 'admin' && lead.owner_id !== request.user.id) {
      return reply.code(403).send({ code: 1, msg: '无权限恢复他人线索', data: null });
    }

    db.prepare('UPDATE leads SET is_deleted = 0, updated_at = ? WHERE id = ?').run(nowDatetime(), Number(id));
    addLog(db, Number(id), request.user.id, 'restore');
    return reply.send({ code: 0, msg: '已恢复', data: null });
  });

  // 跟进时间线
  app.get('/api/leads/:id/follow-ups', { preHandler: authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const db = getDb();
    const follows = db.prepare(`
      SELECT f.*, u.name AS user_name
      FROM follow_ups f
      LEFT JOIN users u ON f.user_id = u.id
      WHERE f.lead_id = ?
      ORDER BY f.created_at DESC, f.id DESC
    `).all(Number(id));
    return reply.send({ code: 0, msg: 'ok', data: follows });
  });

  // 写跟进（触发状态自动化）
  app.post('/api/leads/:id/follow-ups', { preHandler: authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = followUpSchema.safeParse(request.body);
    if (!result.success) {
      return reply.code(400).send({ code: 1, msg: result.error.issues[0].message, data: null });
    }
    const data = result.data;
    const db = getDb();

    const lead = db.prepare('SELECT id, owner_id, status, next_follow_at FROM leads WHERE id = ? AND is_deleted = 0').get(Number(id)) as any;
    if (!lead) return reply.code(404).send({ code: 1, msg: '线索不存在', data: null });
    if (request.user.role !== 'admin' && lead.owner_id !== request.user.id) {
      return reply.code(403).send({ code: 1, msg: '无权限对他人线索写跟进', data: null });
    }

    const now = nowDatetime();

    const imagesJson = data.images?.length ? JSON.stringify(data.images) : null;
    let followUpId: number;
    try {
      db.exec('BEGIN IMMEDIATE;');
      const res = db.prepare(`
        INSERT INTO follow_ups (lead_id, user_id, type, content, result, next_follow_at, images, amount)
        VALUES (?,?,?,?,?,?,?,?)
      `).run(Number(id), request.user.id, data.type, data.content, data.result || null, data.next_follow_at || null, imagesJson, data.amount ?? null);
      followUpId = Number(res.lastInsertRowid);
      recomputeFollowUpDerived(db, Number(id), now);
      db.prepare('UPDATE leads SET status = ?, updated_at = ? WHERE id = ?').run(data.status, now, Number(id));
      if (data.status !== lead.status) {
        addLog(db, Number(id), request.user.id, 'update', 'status', lead.status, data.status);
      }
      db.exec('COMMIT;');
    } catch (error) {
      try { db.exec('ROLLBACK;'); } catch { /* no open transaction */ }
      throw error;
    }

    return reply.send({ code: 0, msg: '跟进记录已保存', data: { id: followUpId! } });
  });

  // 编辑跟进记录
  app.patch('/api/follow-ups/:fid', { preHandler: authenticate }, async (request, reply) => {
    const { fid } = request.params as { fid: string };
    const schema = z.object({
      type: z.enum(FOLLOW_TYPE_VALUES).optional(),
      content: z.string().min(1, '跟进内容不能为空').optional(),
      result: z.string().optional(),
      next_follow_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
      amount: z.number().positive().optional().nullable(),
    });
    const result = schema.safeParse(request.body);
    if (!result.success) return reply.code(400).send({ code: 1, msg: result.error.issues[0].message, data: null });
    const db = getDb();
    const fu = db.prepare('SELECT id, user_id, lead_id FROM follow_ups WHERE id = ?').get(Number(fid)) as any;
    if (!fu) return reply.code(404).send({ code: 1, msg: '跟进记录不存在', data: null });
    if (request.user.role !== 'admin' && fu.user_id !== request.user.id) {
      return reply.code(403).send({ code: 1, msg: '无权限修改他人跟进记录', data: null });
    }
    const data = result.data;
    const fields: string[] = [];
    const values: SQLInputValue[] = [];
    if (data.type !== undefined) { fields.push('type = ?'); values.push(data.type); }
    if (data.content !== undefined) { fields.push('content = ?'); values.push(data.content); }
    if (data.result !== undefined) { fields.push('result = ?'); values.push(data.result || null); }
    if ('next_follow_at' in data) { fields.push('next_follow_at = ?'); values.push(data.next_follow_at || null); }
    if ('amount' in data) { fields.push('amount = ?'); values.push(data.amount ?? null); }
    if (fields.length === 0) return reply.send({ code: 1, msg: '没有要更新的字段', data: null });
    values.push(Number(fid));
    try {
      db.exec('BEGIN IMMEDIATE;');
      db.prepare(`UPDATE follow_ups SET ${fields.join(', ')} WHERE id = ?`).run(...values);
      recomputeFollowUpDerived(db, fu.lead_id);
      // 改后的内容已经原地显示在跟进记录里了，操作日志只记"编辑过"这个动作，不重复存内容
      addLog(db, fu.lead_id, request.user.id, 'update', 'follow_up', '', '');
      db.exec('COMMIT;');
    } catch (error) {
      try { db.exec('ROLLBACK;'); } catch { /* no open transaction */ }
      throw error;
    }
    return reply.send({ code: 0, msg: '跟进记录已更新', data: null });
  });

  // 删除跟进记录
  app.delete('/api/follow-ups/:fid', { preHandler: authenticate }, async (request, reply) => {
    const { fid } = request.params as { fid: string };
    const db = getDb();
    const fu = db.prepare('SELECT id, user_id, lead_id FROM follow_ups WHERE id = ?').get(Number(fid)) as any;
    if (!fu) return reply.code(404).send({ code: 1, msg: '跟进记录不存在', data: null });
    if (request.user.role !== 'admin' && fu.user_id !== request.user.id) {
      return reply.code(403).send({ code: 1, msg: '无权限删除他人跟进记录', data: null });
    }
    try {
      db.exec('BEGIN IMMEDIATE;');
      db.prepare('DELETE FROM follow_ups WHERE id = ?').run(Number(fid));
      // 方案 B：删除最后一条跟进时清空两项派生时间，不恢复旧人工日期。
      recomputeFollowUpDerived(db, fu.lead_id);
      addLog(db, fu.lead_id, request.user.id, 'delete', 'follow_up', '', '');
      db.exec('COMMIT;');
    } catch (error) {
      try { db.exec('ROLLBACK;'); } catch { /* no open transaction */ }
      throw error;
    }
    return reply.send({ code: 0, msg: '跟进记录已删除', data: null });
  });

  // 批量操作
  app.post('/api/leads/batch', { preHandler: authenticate }, async (request, reply) => {
    const schema = z.object({
      ids: z.array(z.number().int()).min(1).max(100),
      action: z.enum(['status', 'transfer']),
      status: z.enum(STATUS_VALUES).optional(),
      owner_id: z.number().int().optional(),
    });
    const result = schema.safeParse(request.body);
    if (!result.success) return reply.code(400).send({ code: 1, msg: result.error.issues[0].message, data: null });
    const { ids, action, status, owner_id } = result.data;
    const db = getDb();
    const uniqueIds = [...new Set(ids)];
    const placeholders = uniqueIds.map(() => '?').join(',');
    const now = nowDatetime();
    if (action === 'status' && !status) {
      return reply.code(400).send({ code: 1, msg: '缺少状态值', data: null });
    }
    if (action === 'transfer' && owner_id === undefined) {
      return reply.code(400).send({ code: 1, msg: '缺少负责人', data: null });
    }
    try {
      db.exec('BEGIN IMMEDIATE;');
      const leads = db.prepare(`
        SELECT id, owner_id FROM leads
        WHERE id IN (${placeholders}) AND is_deleted = 0
      `).all(...uniqueIds) as Array<{ id: number; owner_id: number | null }>;
      if (leads.length !== uniqueIds.length) {
        throw new OwnerTransferError('lead_not_found', '批量操作中包含不存在或已删除的线索');
      }
      if (request.user.role !== 'admin' && leads.some((lead) => lead.owner_id !== request.user.id)) {
        db.exec('ROLLBACK;');
        return reply.code(403).send({ code: 1, msg: '批量操作中包含他人线索，无权限', data: null });
      }

      if (action === 'status') {
        db.prepare(`UPDATE leads SET status=?, updated_at=? WHERE id IN (${placeholders}) AND is_deleted=0`)
          .run(status!, now, ...uniqueIds);
      } else {
        assertActiveOwner(db, owner_id!);
        const operationId = randomUUID();
        for (const lead of leads) {
          transferLeadOwner(db, {
            leadId: lead.id,
            newOwnerId: owner_id!,
            actorUserId: request.user.id,
            source: 'batch_transfer',
            operationId,
            updatedAt: now,
          });
        }
      }
      db.exec('COMMIT;');
    } catch (error) {
      try { db.exec('ROLLBACK;'); } catch { /* no open transaction */ }
      if (error instanceof OwnerTransferError) {
        return reply.code(error.kind === 'lead_not_found' ? 404 : error.kind === 'concurrent_change' ? 409 : 400)
          .send({ code: 1, msg: error.message, data: null });
      }
      throw error;
    }
    return reply.send({ code: 0, msg: `已批量更新 ${uniqueIds.length} 条`, data: null });
  });

  // 回收站（admin）
  // 回收站：admin 看全公司的，普通用户只看自己删的
  app.get('/api/trash', { preHandler: authenticate }, async (request, reply) => {
    const db = getDb();
    const isAdmin = request.user.role === 'admin';
    const list = isAdmin
      ? db.prepare(`
          SELECT l.*, u.name AS owner_name
          FROM leads l LEFT JOIN users u ON l.owner_id = u.id
          WHERE l.is_deleted = 1
          ORDER BY l.updated_at DESC
        `).all()
      : db.prepare(`
          SELECT l.*, u.name AS owner_name
          FROM leads l LEFT JOIN users u ON l.owner_id = u.id
          WHERE l.is_deleted = 1 AND l.owner_id = ?
          ORDER BY l.updated_at DESC
        `).all(request.user.id);
    return reply.send({ code: 0, msg: 'ok', data: list });
  });

  // 线索公海：超过 N 天没有跟进记录的线索（排除已成交/已流失）
  app.get('/api/pool', { preHandler: authenticate }, async (request, reply) => {
    if (!resolveNotificationConfig().leadPoolClaimEnabled) {
      return reply.code(403).send({ code: 1, msg: '公海待认领功能已关闭，线索池“全部线索”仍可正常使用', data: { error_code: 'LEAD_POOL_CLAIM_DISABLED' } });
    }
    const parsed = poolQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ code: 1, msg: parsed.error.issues[0].message, data: null });
    }
    const threshold = parsed.data.days;
    const db = getDb();
    const list = db.prepare(`
      SELECT l.*, u.name AS owner_name,
        CAST((julianday('now','localtime') - julianday(COALESCE(l.last_follow_at, l.created_at))) AS INTEGER) AS idle_days
      FROM leads l
      LEFT JOIN users u ON l.owner_id = u.id
      WHERE l.is_deleted = 0
        AND l.status NOT IN ('已成交','已流失','停止跟进')
        AND CAST((julianday('now','localtime') - julianday(COALESCE(l.last_follow_at, l.created_at))) AS INTEGER) >= ?
      ORDER BY idle_days DESC
      LIMIT 100
    `).all(threshold);
    return reply.send({
      code: 0,
      msg: 'ok',
      data: {
        minimum_days: POOL_IDLE_DAYS,
        threshold_days: threshold,
        total: list.length,
        list,
      },
    });
  });

  // 认领公海线索（转移给自己）
  app.post('/api/pool/:id/claim', { preHandler: authenticate }, async (request, reply) => {
    if (!resolveNotificationConfig().leadPoolClaimEnabled) {
      return reply.code(403).send({ code: 1, msg: '公海待认领功能已关闭，暂不支持认领线索', data: { error_code: 'LEAD_POOL_CLAIM_DISABLED' } });
    }
    const { id } = request.params as { id: string };
    const db = getDb();
    try {
      db.exec('BEGIN IMMEDIATE;');
      const lead = db.prepare(`
        SELECT id, owner_id
        FROM leads
        WHERE id = ? AND is_deleted = 0
          AND status NOT IN ('已成交','已流失','停止跟进')
          AND CAST((julianday('now','localtime') - julianday(COALESCE(last_follow_at, created_at))) AS INTEGER) >= ?
      `).get(Number(id), POOL_IDLE_DAYS) as { id: number; owner_id: number | null } | undefined;
      if (!lead) {
        db.exec('ROLLBACK;');
        return reply.code(409).send({
          code: 1,
          msg: `该线索当前不满足进入公海的条件（至少 ${POOL_IDLE_DAYS} 天未跟进）`,
          data: null,
        });
      }
      if (lead.owner_id === request.user.id) {
        db.exec('ROLLBACK;');
        return reply.code(400).send({ code: 1, msg: '该线索已经由你负责', data: null });
      }
      transferLeadOwner(db, {
        leadId: lead.id,
        newOwnerId: request.user.id,
        actorUserId: request.user.id,
        source: 'pool_claim',
        operationId: randomUUID(),
        updatedAt: nowDatetime(),
      });
      db.exec('COMMIT;');
    } catch (error) {
      try { db.exec('ROLLBACK;'); } catch { /* no open transaction */ }
      if (error instanceof OwnerTransferError) {
        return reply.code(error.kind === 'concurrent_change' ? 409 : 400).send({ code: 1, msg: error.message, data: null });
      }
      throw error;
    }
    return reply.send({ code: 0, msg: '已认领', data: null });
  });

  // 同公司其他线索
  app.get('/api/leads/:id/related', { preHandler: authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const db = getDb();
    const lead = db.prepare('SELECT company_name, phone FROM leads WHERE id=?').get(Number(id)) as any;
    if (!lead || !lead.company_name) return reply.send({ code: 0, msg: 'ok', data: [] });
    const list = db.prepare(`
      SELECT l.id, l.company_name, l.contact_name, l.phone, l.status, l.intent_level,
        u.name AS owner_name, l.last_follow_at
      FROM leads l LEFT JOIN users u ON l.owner_id=u.id
      WHERE l.company_name = ? AND l.id != ? AND l.is_deleted=0
      ORDER BY l.updated_at DESC
      LIMIT 20
    `).all(lead.company_name, Number(id));
    return reply.send({ code: 0, msg: 'ok', data: list });
  });

  // 操作日志
  app.get('/api/leads/:id/audit-logs', { preHandler: authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const db = getDb();
    const logs = db.prepare(`
      SELECT a.*,
        u.name AS user_name,
        CASE WHEN a.action='transfer' THEN COALESCE(ou.name, a.old_val) ELSE a.old_val END AS old_val,
        CASE WHEN a.action='transfer' THEN COALESCE(nu.name, a.new_val) ELSE a.new_val END AS new_val
      FROM audit_logs a
      LEFT JOIN users u  ON a.user_id = u.id
      LEFT JOIN users ou ON a.action='transfer' AND ou.id = CAST(a.old_val AS INTEGER)
      LEFT JOIN users nu ON a.action='transfer' AND nu.id = CAST(a.new_val AS INTEGER)
      WHERE a.lead_id = ?
      ORDER BY a.created_at DESC
      LIMIT 50
    `).all(Number(id));
    return reply.send({ code: 0, msg: 'ok', data: logs });
  });
}
