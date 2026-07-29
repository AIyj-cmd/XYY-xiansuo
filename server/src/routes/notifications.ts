import { FastifyInstance } from 'fastify';
import { getDb } from '../db.js';
import { authenticate } from '../middleware/auth.js';
import { todayDate } from '../utils/datetime.js';

interface NotificationItem {
  id: string;
  type: 'transfer' | 'overdue';
  lead_id: number;
  company_name: string | null;
  contact_name: string;
  occurred_at: string;
  from_name?: string | null;
  operator_name?: string | null;
  overdue_days?: number;
}

export async function notificationRoutes(app: FastifyInstance): Promise<void> {
  // 消息通知：线索转移给我 + 我名下已逾期未跟进的线索，按时间合并排序
  app.get('/api/notifications', { preHandler: authenticate }, async (request, reply) => {
    const db = getDb();
    const userId = String(request.user.id);

    const transfers = db.prepare(`
      SELECT a.id, a.lead_id, a.created_at,
        l.company_name, l.contact_name,
        ou.name AS from_name,
        u.name AS operator_name
      FROM audit_logs a
      JOIN leads l ON l.id = a.lead_id
      LEFT JOIN users ou ON ou.id = CAST(a.old_val AS INTEGER)
      LEFT JOIN users u ON u.id = a.user_id
      WHERE a.action = 'transfer' AND a.new_val = ? AND l.is_deleted = 0
      ORDER BY a.created_at DESC
      LIMIT 50
    `).all(userId) as any[];

    const overdue = db.prepare(`
      SELECT l.id, l.company_name, l.contact_name, l.next_follow_at,
        CAST((julianday('now','localtime') - julianday(l.next_follow_at)) AS INTEGER) AS overdue_days
      FROM leads l
      WHERE l.is_deleted = 0 AND l.owner_id = ? AND l.next_follow_at < ?
        AND l.status NOT IN ('已成交','已流失','停止跟进')
      ORDER BY overdue_days DESC
      LIMIT 50
    `).all(Number(request.user.id), todayDate()) as any[];

    const list: NotificationItem[] = [
      ...transfers.map((t): NotificationItem => ({
        id: `t${t.id}`,
        type: 'transfer',
        lead_id: t.lead_id,
        company_name: t.company_name,
        contact_name: t.contact_name,
        occurred_at: t.created_at,
        from_name: t.from_name,
        operator_name: t.operator_name,
      })),
      ...overdue.map((o): NotificationItem => ({
        id: `o${o.id}`,
        type: 'overdue',
        lead_id: o.id,
        company_name: o.company_name,
        contact_name: o.contact_name,
        // 用到期日期本身作为"发生时间"参与排序和已读比较，逾期越久不代表越新，
        // 但到期日期越晚说明这条线索是最近才变成逾期的
        occurred_at: o.next_follow_at,
        overdue_days: o.overdue_days,
      })),
    ].sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : a.occurred_at > b.occurred_at ? -1 : 0));

    return reply.send({ code: 0, msg: 'ok', data: list });
  });
}
