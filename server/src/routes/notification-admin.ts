import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db.js';
import { requireAdmin } from '../middleware/auth.js';
import { ownerRuleAvailableAt, parseAiRule, parseOwnerRule, parseSingleNotificationChannel } from '../services/notification.js';
import { resolveNotificationConfig } from '../config.js';
import { nowDatetime } from '../utils/datetime.js';
import { parseNotificationSnapshot } from '../notifications/snapshot.js';
import { validateDigestContext } from '../ai/permission-query.js';

const eventSchema = z.enum(['owner_changed','scheduled_follow_overdue','visit_reminder','status_changed','daily_report','weekly_report','inactive_lead']);
const ruleUpdateSchema = z.object({ enabled: z.boolean(), recipient_strategy: z.string(), channel_order: z.array(z.string()).max(1), config: z.unknown(), expected_version: z.number().int().positive() }).strict();
const previewSchema = z.object({ rule: ruleUpdateSchema, sample: z.object({ lead_id: z.number().int().positive(), actor_user_id: z.number().int().positive(), old_owner_id: z.number().int().positive().nullable(), new_owner_id: z.number().int().positive() }).strict(), as_of: z.string().optional() }).strict();
const retrySchema = z.object({ expected_version: z.number().int().positive(), reason: z.string().min(1).max(200) }).strict();
const idSchema = z.coerce.number().int().positive();
function bad(reply: any, msg: string, code = 'RULE_CONFIG_INVALID', status = 400) { return reply.code(status).send({ code: 1, msg, data: { error_code: code } }); }
function allowedSingleChannel(channelOrder: readonly string[]): 'mock' | 'openclaw' | undefined {
  return channelOrder.length === 1 && (channelOrder[0] === 'mock' || channelOrder[0] === 'openclaw') ? channelOrder[0] : undefined;
}
function validateRuleTarget(eventType: string, recipientStrategy: string, channelOrder: readonly string[]): { channel: 'mock' | 'openclaw' } | undefined {
  const aiEvent = eventType === 'scheduled_follow_overdue' || eventType === 'daily_report';
  const channel = allowedSingleChannel(channelOrder);
  if ((eventType === 'owner_changed' && recipientStrategy !== 'new_owner') || (aiEvent && recipientStrategy !== 'reserved') || !channel) return undefined;
  return { channel };
}
function safeRule(row: any) { return { event_type: row.event_type, enabled: Boolean(row.enabled), recipient_strategy: row.recipient_strategy, channel_order: JSON.parse(row.channel_order_json), config_schema_version: row.config_schema_version, config: JSON.parse(row.config_json), version: row.version, updated_at: row.updated_at }; }
function safeLog(row: any) { return { id: row.id, event_type: row.event_type, event_source: row.event_source, operation_id: row.operation_id, lead_id: row.lead_id, recipient_user_id: row.recipient_user_id, status: row.status, channel: row.channel, attempt_count: row.attempt_count, automatic_attempt_count: row.automatic_attempt_count, failure_class: row.failure_class, last_error_code: row.last_error_code, suppression_reason: row.suppression_reason, cancellation_reason: row.cancellation_reason, created_at: row.created_at, updated_at: row.updated_at, row_version: row.row_version }; }

export async function notificationAdminRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/admin/notification-rules', { preHandler: requireAdmin }, async (_request, reply) => {
    const rows = getDb().prepare('SELECT * FROM notification_rules ORDER BY event_type').all();
    return reply.send({ code: 0, msg: 'ok', data: rows.map(safeRule) });
  });
  app.get('/api/admin/notification-rules/:eventType', { preHandler: requireAdmin }, async (request, reply) => {
    const event = eventSchema.safeParse((request.params as any).eventType); if (!event.success) return bad(reply, '事件类型不合法', 'EVENT_NOT_IMPLEMENTED', 404);
    const row = getDb().prepare('SELECT * FROM notification_rules WHERE event_type=?').get(event.data); if (!row) return bad(reply, '规则不存在', 'EVENT_NOT_IMPLEMENTED', 404);
    return reply.send({ code: 0, msg: 'ok', data: safeRule(row) });
  });
  app.put('/api/admin/notification-rules/:eventType', { preHandler: requireAdmin }, async (request, reply) => {
    const event = eventSchema.safeParse((request.params as any).eventType); const parsed = ruleUpdateSchema.safeParse(request.body);
    if (!event.success || !parsed.success) return bad(reply, parsed.success ? '事件类型不合法' : parsed.error.issues[0].message);
    const body = parsed.data; const aiEvent = event.data === 'scheduled_follow_overdue' || event.data === 'daily_report';
    if (event.data !== 'owner_changed' && !aiEvent) return bad(reply, '该事件尚未实现，不能启用', 'EVENT_NOT_IMPLEMENTED');
    const target = validateRuleTarget(event.data, body.recipient_strategy, body.channel_order);
    if (!target) return bad(reply, '该事件只允许一个受控渠道，禁止 fallback', 'CHANNEL_NOT_ALLOWED');
    const notificationConfig = resolveNotificationConfig();
    if (body.enabled && ((target.channel === 'mock' && !notificationConfig.mockEnabled) || (target.channel === 'openclaw' && !notificationConfig.openclawEnabled))) return bad(reply, '所选通知渠道未启用，不能启用规则', 'CHANNEL_NOT_ALLOWED');
    const candidate = { event_type: event.data, enabled: body.enabled ? 1 : 0, recipient_strategy: body.recipient_strategy, channel_order_json: JSON.stringify(body.channel_order), config_schema_version: 1, config_json: JSON.stringify(body.config), version: body.expected_version };
    try { if (event.data === 'owner_changed') parseOwnerRule(candidate); else parseAiRule(candidate, event.data as 'scheduled_follow_overdue' | 'daily_report'); } catch { return bad(reply, '规则配置不合法'); }
    const db = getDb(); const now = nowDatetime(); db.exec('BEGIN IMMEDIATE;');
    try {
      const result = db.prepare(`UPDATE notification_rules SET enabled=?, recipient_strategy=?, channel_order_json=?, config_schema_version=1, config_json=?, version=version+1, updated_by=?, updated_at=? WHERE event_type=? AND version=?`).run(body.enabled ? 1 : 0, body.recipient_strategy, JSON.stringify(body.channel_order), JSON.stringify(body.config), request.user.id, now, event.data, body.expected_version);
      if (!result.changes) { db.exec('ROLLBACK;'); return bad(reply, '规则版本已变化，请刷新后重试', 'RULE_VERSION_CONFLICT', 409); }
      if (!body.enabled) db.prepare(`UPDATE notification_logs SET status='cancelled', cancellation_reason='rule_disabled', cancelled_at=?, retain_until=datetime(?, '+180 days'), updated_at=?, row_version=row_version+1 WHERE event_type=? AND status IN ('pending','retry_wait')`).run(now, now, now, event.data);
      db.exec('COMMIT;');
    } catch (error) { try { db.exec('ROLLBACK;'); } catch {} throw error; }
    console.log(JSON.stringify({ event: 'notification.rule.updated', event_type: event.data }));
    const row = db.prepare('SELECT * FROM notification_rules WHERE event_type=?').get(event.data); return reply.send({ code: 0, msg: '已更新', data: safeRule(row) });
  });
  app.post('/api/admin/notification-rules/:eventType/preview', { preHandler: requireAdmin }, async (request, reply) => {
    const event = eventSchema.safeParse((request.params as any).eventType); const parsed = previewSchema.safeParse(request.body);
    if (!event.success || !parsed.success) return bad(reply, parsed.success ? '事件类型不合法' : parsed.error.issues[0].message);
    if (event.data !== 'owner_changed') return bad(reply, '该事件尚未实现', 'EVENT_NOT_IMPLEMENTED');
    const { rule, sample } = parsed.data;
    // Preview is an admin-facing dry run of the same persisted rule contract.
    // A disabled rule still must name its sole channel; otherwise it could
    // misleadingly render a pending decision that PUT would reject.
    if (!validateRuleTarget(event.data, rule.recipient_strategy, rule.channel_order)) return bad(reply, '该事件只允许一个受控渠道，禁止 fallback', 'CHANNEL_NOT_ALLOWED');
    const candidate = { event_type: event.data, enabled: rule.enabled ? 1 : 0, recipient_strategy: rule.recipient_strategy, channel_order_json: JSON.stringify(rule.channel_order), config_schema_version: 1, config_json: JSON.stringify(rule.config), version: rule.expected_version };
    let ruleConfig: ReturnType<typeof parseOwnerRule>;
    try { ruleConfig = parseOwnerRule(candidate); } catch { return bad(reply, '规则配置不合法'); }
    const noEvent = sample.old_owner_id === sample.new_owner_id || sample.new_owner_id === sample.actor_user_id;
    const asOf = parsed.data.as_of || nowDatetime();
    let availableAt;
    try { availableAt = ownerRuleAvailableAt(ruleConfig, asOf); } catch { return bad(reply, 'as_of 时间不合法', 'QUERY_INVALID'); }
    const recipient = getDb().prepare('SELECT is_active FROM users WHERE id=?').get(sample.new_owner_id) as { is_active: number } | undefined;
    let decision: 'no_event' | 'pending' | 'suppressed' = 'pending';
    let suppressionReason: string | null = null;
    if (noEvent) decision = 'no_event';
    else if (!rule.enabled) { decision = 'suppressed'; suppressionReason = 'rule_disabled'; }
    else if (!recipient?.is_active) { decision = 'suppressed'; suppressionReason = 'recipient_inactive'; }
    else {
      const channel = rule.channel_order[0]; const config = resolveNotificationConfig();
      if ((channel === 'mock' && !config.mockEnabled) || (channel === 'openclaw' && !config.openclawEnabled)) { decision = 'suppressed'; suppressionReason = 'no_usable_channel'; }
    }
    return reply.send({ code: 0, msg: 'ok', data: { decision, suppression_reason: suppressionReason, recipient_user_id: sample.new_owner_id, available_at: availableAt, message: { title: '负责人已变更', detail_path: `/pages/leads/detail?id=${sample.lead_id}` } } });
  });
  app.get('/api/admin/notification-logs', { preHandler: requireAdmin }, async (request, reply) => {
    const q = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20), event_type: z.string().optional(), status: z.string().optional(), channel: z.enum(['mock','openclaw']).optional(), recipient_user_id: z.coerce.number().int().optional(), lead_id: z.coerce.number().int().optional(), operation_id: z.string().max(100).optional(), from: z.string().optional(), to: z.string().optional() }).safeParse(request.query);
    if (!q.success) return bad(reply, q.error.issues[0].message, 'QUERY_INVALID'); const parts: string[] = []; const values: any[] = [];
    for (const [key, column] of [['event_type','event_type'],['status','status'],['channel','channel'],['recipient_user_id','recipient_user_id'],['lead_id','lead_id'],['operation_id','operation_id']] as const) if ((q.data as any)[key] !== undefined) { parts.push(`${column}=?`); values.push((q.data as any)[key]); }
    if (q.data.from) { parts.push('created_at >= ?'); values.push(q.data.from); } if (q.data.to) { parts.push('created_at <= ?'); values.push(q.data.to); }
    const where = parts.length ? `WHERE ${parts.join(' AND ')}` : ''; const db = getDb(); const total = (db.prepare(`SELECT COUNT(*) AS count FROM notification_logs ${where}`).get(...values) as any).count;
    const rows = db.prepare(`SELECT * FROM notification_logs ${where} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`).all(...values, q.data.pageSize, (q.data.page - 1) * q.data.pageSize); return reply.send({ code: 0, msg: 'ok', data: { total, page: q.data.page, pageSize: q.data.pageSize, list: rows.map(safeLog) } });
  });
  app.get('/api/admin/notification-logs/:id', { preHandler: requireAdmin }, async (request, reply) => { const id = idSchema.safeParse((request.params as any).id); if (!id.success) return bad(reply, '通知任务 ID 不合法', 'QUERY_INVALID'); const row = getDb().prepare('SELECT * FROM notification_logs WHERE id=?').get(id.data); if (!row) return bad(reply, '通知任务不存在', 'NOTIFICATION_NOT_FOUND', 404); return reply.send({ code: 0, msg: 'ok', data: safeLog(row) }); });
  app.post('/api/admin/notification-logs/:id/retry', { preHandler: requireAdmin }, async (request, reply) => {
    const body = retrySchema.safeParse(request.body); if (!body.success) return bad(reply, body.error.issues[0].message); const id = idSchema.safeParse((request.params as any).id); if (!id.success) return bad(reply, '通知任务 ID 不合法', 'QUERY_INVALID'); const db = getDb(); const now = nowDatetime();
    const row = db.prepare('SELECT * FROM notification_logs WHERE id=?').get(id.data) as any; if (!row) return bad(reply, '通知任务不存在', 'NOTIFICATION_NOT_FOUND', 404);
    const active = db.prepare('SELECT role,is_active FROM users WHERE id=?').get(row.recipient_user_id) as any;
    const rule = db.prepare('SELECT event_type,enabled,recipient_strategy,channel_order_json,config_schema_version,config_json,version FROM notification_rules WHERE event_type=?').get(row.event_type) as any;
    const aiEvent = row.event_type === 'scheduled_follow_overdue' || row.event_type === 'daily_report';
    let ruleUsable = false; let contextUsable = false;
    try {
      if (aiEvent) {
        parseAiRule(rule, row.event_type);
        const snapshot = parseNotificationSnapshot(row.event_type, row.message_snapshot_json) as any;
        contextUsable = active?.is_active === 1
          && (row.event_type !== 'daily_report' || snapshot.scope !== 'team' || active.role === 'admin')
          && validateDigestContext(db, row.event_type, row.recipient_user_id, snapshot.subject_lead_ids);
      } else {
        parseOwnerRule(rule);
        const lead = db.prepare('SELECT owner_id,is_deleted FROM leads WHERE id=?').get(row.lead_id) as any;
        contextUsable = active?.is_active === 1 && !lead?.is_deleted && lead?.owner_id === row.recipient_user_id;
      }
      const channel = parseSingleNotificationChannel(rule.channel_order_json);
      const config = resolveNotificationConfig();
      ruleUsable = Boolean(rule?.enabled) && ((channel === 'mock' && config.mockEnabled) || (channel === 'openclaw' && config.openclawEnabled));
    } catch { ruleUsable = false; contextUsable = false; }
    if (row.status !== 'failed' || !row.retry_allowed || row.expires_at <= now || row.provider_message_id || !contextUsable || !ruleUsable) return bad(reply, '该任务当前不符合人工重试条件', 'RETRY_NOT_ALLOWED', 409);
    const result = db.prepare(`UPDATE notification_logs SET status='pending', available_at=?, manual_retry_count=manual_retry_count+1, failed_at=NULL, retain_until=NULL, failure_class=NULL, last_error_code=NULL, last_error_message=NULL, management_audit_json=json_insert(management_audit_json, '$[#]', json_object('action','manual_retry','by',?,'reason',?,'at',?)), row_version=row_version+1, updated_at=? WHERE id=? AND row_version=?`).run(now, request.user.id, body.data.reason, now, now, id.data, body.data.expected_version);
    if (!result.changes) return bad(reply, '任务版本已变化，请刷新后重试', 'RULE_VERSION_CONFLICT', 409); console.log(JSON.stringify({ event: 'notification.admin.retry', id: id.data })); return reply.send({ code: 0, msg: '已加入重试队列', data: null });
  });
}
