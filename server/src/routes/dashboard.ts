import { FastifyInstance } from 'fastify';
import { getDb } from '../db.js';
import { authenticate } from '../middleware/auth.js';
import { todayDate } from '../utils/datetime.js';

function getMondayOfWeek(date: Date): string {
  const d = new Date(date);
  const day = d.getDay();
  const diff = (day === 0 ? -6 : 1 - day);
  d.setDate(d.getDate() + diff);
  return d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

function getMonthStart(): string {
  const now = new Date();
  const y = now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 4);
  const m = now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(5, 7);
  return `${y}-${m}-01`;
}

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/dashboard/summary', { preHandler: authenticate }, async (_request, reply) => {
    const db = getDb();
    const today = todayDate();
    const notDone = `status NOT IN ('已成交','已流失','停止跟进')`;

    // 今日待跟进
    const todayList = db.prepare(`
      SELECT l.id, l.company_name, l.contact_name, l.phone, l.status, l.next_follow_at, u.name AS owner_name
      FROM leads l LEFT JOIN users u ON l.owner_id = u.id
      WHERE l.is_deleted = 0 AND l.next_follow_at = ? AND ${notDone}
      ORDER BY l.contact_name
    `).all(today);

    // 已逾期
    const overdueList = db.prepare(`
      SELECT l.id, l.company_name, l.contact_name, l.phone, l.status, l.next_follow_at, u.name AS owner_name,
        CAST(julianday('now','localtime') - julianday(l.next_follow_at) AS INTEGER) AS overdue_days
      FROM leads l LEFT JOIN users u ON l.owner_id = u.id
      WHERE l.is_deleted = 0 AND l.next_follow_at < ? AND ${notDone}
      ORDER BY overdue_days DESC
    `).all(today);

    // 本周新增
    const monday = getMondayOfWeek(new Date());
    const weekNewRow = db.prepare(
      `SELECT COUNT(*) AS cnt FROM leads WHERE is_deleted = 0 AND DATE(created_at) >= ?`
    ).get(monday) as any;
    const weekNew = weekNewRow.cnt;

    // 状态漏斗
    const funnelRows = db.prepare(
      `SELECT status, COUNT(*) AS cnt FROM leads WHERE is_deleted = 0 GROUP BY status`
    ).all() as any[];
    const funnel: Record<string, number> = {};
    for (const r of funnelRows) funnel[r.status] = r.cnt;

    // 本月来源统计
    const monthStart = getMonthStart();
    const sourceRows = db.prepare(`
      SELECT source,
        COUNT(*) AS lead_count,
        SUM(CASE WHEN status = '已成交' THEN 1 ELSE 0 END) AS deal_count
      FROM leads
      WHERE is_deleted = 0 AND DATE(created_at) >= ?
      GROUP BY source
      ORDER BY lead_count DESC
    `).all(monthStart);

    return reply.send({
      code: 0, msg: 'ok', data: {
        today: todayList,
        overdue: overdueList,
        week_new: weekNew,
        funnel,
        month_by_source: sourceRows,
      },
    });
  });
}
