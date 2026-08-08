import { FastifyInstance } from 'fastify';
import ExcelJS from 'exceljs';
import { getDb } from '../db.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { Readable } from 'stream';
import { recomputeFollowUpDerived } from '../services/follow-up-derived.js';

const VALID_STATUS = ['新线索', '跟进中', '已报价', '已成交', '已流失', '暂搁置', '停止跟进'];

// 状态映射：先看是不是系统里本来就认识的状态文字（原样保留），
// 认不出来的旧表述再走模糊匹配兜底
function mapStatus(raw: string): string {
  const s = (raw || '').trim();
  if (VALID_STATUS.includes(s)) return s;
  if (/停止跟进|不再跟进|放弃/.test(s)) return '停止跟进';
  if (/已处理|已更进/.test(s)) return '跟进中';
  if (/待处理|待更进|未处理|未更进/.test(s)) return '新线索';
  return '新线索';
}

// 解析线索日期：年份 + "1月31" → YYYY-MM-DD
function parseLeadDate(year: string | number, dateStr: string): string {
  const y = String(year).trim();
  const d = String(dateStr || '').trim();
  const m = d.match(/(\d{1,2})月(\d{1,2})/);
  if (m) {
    return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  // 尝试解析已经是日期格式的
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  return `${y}-01-01`; // 解析失败
}

const TEMPLATE_HEADERS = ['序号', '年份', '月份', '线索日期', '跟进人', '线索来源', '跟进情况', '行业类型', '联系人', '手机', '微信号', '跟进记录', '跟进状态'];

export async function importExportRoutes(app: FastifyInstance): Promise<void> {

  // 下载导入模板
  app.get('/api/import/template', { preHandler: requireAdmin }, async (_request, reply) => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('线索导入模板');
    ws.addRow(TEMPLATE_HEADERS);
    ws.addRow([1, 2025, 1, '1月15', '张三', '小红书', '已处理', '女装', '李四', '13800138000', 'wxid_abc', '已沟通需求，发了方案', '跟进中']);
    ws.addRow([2, 2025, 2, '2月10', '王五', '抖音', '待处理', '男装', '赵六', '', 'xiaohongshu_id', '', '停止跟进']);
    ws.addRow([3, 2025, 3, '3月5', '陈燕', '朋友介绍', '', '美妆', '周七', '13700137000', '', '', '新线索']);

    // PRD未覆盖：模板备注在页面提示，.ods 请先用 WPS 另存 xlsx
    ws.getRow(1).font = { bold: true };
    ws.columns.forEach(col => { col.width = 14; });

    reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    reply.header('Content-Disposition', 'attachment; filename="leads_import_template.xlsx"');
    const buf = await wb.xlsx.writeBuffer();
    return reply.send(Buffer.from(buf));
  });

  // 数据导入
  app.post('/api/import', { preHandler: requireAdmin }, async (request, reply) => {
    const data = await request.file();
    if (!data) return reply.send({ code: 1, msg: '请上传文件', data: null });

    const chunks: Buffer[] = [];
    for await (const chunk of data.file) chunks.push(chunk as Buffer);
    const buf = Buffer.concat(chunks);

    const db = getDb();
    const users = db.prepare('SELECT id, name, is_active FROM users').all() as { id: number; name: string; is_active: number }[];
    const activeUserMap = new Map(users.filter(u => u.is_active === 1).map(u => [u.name, u.id]));

    let successCount = 0;
    const skipped: { row: number; reason: string }[] = [];
    const warnings: { row: number; reason: string }[] = [];

    const wb = new ExcelJS.Workbook();
    const isCSV = data.filename?.endsWith('.csv');

    if (isCSV) {
      await wb.csv.read(Readable.from(buf));
    } else {
      // ExcelJS 4 的类型定义要求 ArrayBuffer，而 Node 的 Buffer 在新版
      // @types/node 中可能以 SharedArrayBuffer 为底层类型；复制为 Uint8Array
      // 可同时满足运行时和类型检查。
      await wb.xlsx.load(Uint8Array.from(buf).buffer);
    }

    const ws = wb.worksheets[0];
    if (!ws) return reply.send({ code: 1, msg: '文件内容为空', data: null });

    const rows = ws.getSheetValues() as any[][];
    // 第1行是索引占位（ExcelJS从1开始），第2行是表头，从第3行开始是数据
    for (let i = 2; i < rows.length; i++) {
      const row = rows[i];
      if (!row) continue;
      // 列索引：1=序号 2=年份 3=月份 4=线索日期 5=跟进人 6=线索来源 7=跟进情况 8=行业类型 9=联系人 10=手机 11=微信号 12=跟进记录 13=跟进状态
      const phone = String(row[10] || '').trim();
      const wechat = String(row[11] || '').trim();
      if (!phone && !wechat) {
        skipped.push({ row: i, reason: '手机号和微信号均为空' });
        continue;
      }

      if (phone) {
        const existing = db.prepare('SELECT id FROM leads WHERE phone = ?').get(phone);
        if (existing) {
          skipped.push({ row: i, reason: `手机号 ${phone} 已存在` });
          continue;
        }
      }

      const year = String(row[2] || '').trim();
      const dateStr = String(row[4] || '').trim();
      let leadDate = parseLeadDate(year, dateStr);
      if (leadDate === `${year}-01-01` && dateStr && !/(\d{1,2})月(\d{1,2})/.test(dateStr)) {
        skipped.push({ row: i, reason: `日期解析失败（${dateStr}），用 ${leadDate} 代替` });
        // 继续导入，但记录到报告
      }

      const ownerName = String(row[5] || '').trim();
      const ownerId = activeUserMap.get(ownerName) ?? request.user.id;
      if (ownerName && !activeUserMap.has(ownerName)) {
        const reason = users.some((user) => user.name === ownerName)
          ? `跟进人"${ownerName}"已停用，已归入导入者`
          : `跟进人"${ownerName}"不存在，已归入导入者`;
        warnings.push({ row: i, reason });
      }

      const statusRaw1 = String(row[7] || '').trim();
      const statusRaw2 = String(row[13] || '').trim();
      const status = mapStatus(statusRaw1 || statusRaw2);

      const contactName = String(row[9] || '').trim();
      if (!contactName) {
        skipped.push({ row: i, reason: '联系人为空' });
        continue;
      }

      const source = String(row[6] || '').trim() || '其他';

      try {
        db.exec('BEGIN IMMEDIATE;');
        const res = db.prepare(`
          INSERT INTO leads (contact_name, phone, wechat, industry, source, status, owner_id, lead_date, created_by)
          VALUES (?,?,?,?,?,?,?,?,?)
        `).run(
          contactName, phone || null,
          wechat || null,
          String(row[8] || '').trim() || null,
          source, status, ownerId, leadDate,
          request.user.id
        );

        const followContent = String(row[12] || '').trim();
        if (followContent) {
          const leadId = Number(res.lastInsertRowid);
          db.prepare(`
            INSERT INTO follow_ups (lead_id, user_id, type, content, created_at)
            VALUES (?,?,?,?,?)
          `).run(leadId, request.user.id, '其他', followContent, leadDate + ' 00:00:00');
          recomputeFollowUpDerived(db, leadId, leadDate + ' 00:00:00');
        }
        db.exec('COMMIT;');
      } catch (error) {
        try { db.exec('ROLLBACK;'); } catch { /* no open transaction */ }
        throw error;
      }

      successCount++;
    }

    return reply.send({
      code: 0, msg: '导入完成', data: {
        success: successCount,
        skipped: skipped.length,
        skipped_details: skipped,
        warnings: warnings.length,
        warning_details: warnings,
      },
    });
  });

  // 导出 xlsx（流式写入响应，避免整份文件先在内存里拼好）
  // admin 导出全量（含软删）；普通用户只能导出自己负责的线索，且不含软删数据
  app.get('/api/export', { preHandler: authenticate }, async (request, reply) => {
    const isAdmin = request.user.role === 'admin';
    const db = getDb();

    const leads = isAdmin
      ? db.prepare(`
          SELECT l.*, u.name AS owner_name, c.name AS creator_name
          FROM leads l
          LEFT JOIN users u ON l.owner_id = u.id
          LEFT JOIN users c ON l.created_by = c.id
          ORDER BY l.id ASC
        `).all() as any[]
      : db.prepare(`
          SELECT l.*, u.name AS owner_name, c.name AS creator_name
          FROM leads l
          LEFT JOIN users u ON l.owner_id = u.id
          LEFT JOIN users c ON l.created_by = c.id
          WHERE l.is_deleted = 0 AND l.owner_id = ?
          ORDER BY l.id ASC
        `).all(request.user.id) as any[];

    const leadIds = leads.map(l => l.id);
    const follows = leadIds.length === 0 ? [] : db.prepare(`
      SELECT f.*, u.name AS user_name, l.contact_name, l.phone
      FROM follow_ups f
      LEFT JOIN users u ON f.user_id = u.id
      LEFT JOIN leads l ON f.lead_id = l.id
      WHERE f.lead_id IN (${leadIds.map(() => '?').join(',')})
      ORDER BY f.id ASC
    `).all(...leadIds) as any[];

    const filename = isAdmin
      ? `leads_export_${new Date().toISOString().slice(0, 10)}.xlsx`
      : `my_leads_export_${new Date().toISOString().slice(0, 10)}.xlsx`;

    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
    });

    const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: reply.raw });

    const ws1 = wb.addWorksheet('线索');
    ws1.columns = ['ID', '公司/品牌', '联系人', '手机', '微信号', '行业', '来源', '来源细分', '需求概况', '意向等级', '状态', '负责人', '线索日期', '下次跟进', '最近跟进', '创建人', '是否删除', '创建时间', '更新时间']
      .map(header => ({ header, width: 16 }));
    ws1.getRow(1).font = { bold: true };
    for (const l of leads) {
      ws1.addRow([l.id, l.company_name, l.contact_name, l.phone, l.wechat, l.industry, l.source, l.source_note, l.demand_note, l.intent_level, l.status, l.owner_name, l.lead_date, l.next_follow_at, l.last_follow_at, l.creator_name, l.is_deleted ? '是' : '否', l.created_at, l.updated_at]).commit();
    }
    ws1.commit();

    const ws2 = wb.addWorksheet('跟进记录');
    ws2.columns = ['ID', '线索ID', '联系人', '手机', '跟进人', '方式', '内容', '本次结果', '约定下次', '时间']
      .map(header => ({ header, width: 16 }));
    ws2.getRow(1).font = { bold: true };
    for (const f of follows) {
      ws2.addRow([f.id, f.lead_id, f.contact_name, f.phone, f.user_name, f.type, f.content, f.result, f.next_follow_at, f.created_at]).commit();
    }
    ws2.commit();

    await wb.commit();
  });

  // 工作台统计导出
  app.get('/api/export/dashboard', { preHandler: authenticate }, async (_request, reply) => {
    const db = getDb();
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
    const monthStart = today.slice(0, 7) + '-01';

    const funnel = db.prepare(`
      SELECT status, COUNT(*) AS cnt FROM leads WHERE is_deleted=0 GROUP BY status
    `).all() as any[];

    const bySource = db.prepare(`
      SELECT source,
        COUNT(*) AS lead_count,
        SUM(CASE WHEN status='已成交' THEN 1 ELSE 0 END) AS deal_count
      FROM leads WHERE is_deleted=0 AND lead_date >= ?
      GROUP BY source ORDER BY lead_count DESC
    `).all(monthStart) as any[];

    const todayLeads = db.prepare(`
      SELECT l.company_name, l.contact_name, l.phone, u.name AS owner_name
      FROM leads l LEFT JOIN users u ON l.owner_id=u.id
      WHERE l.is_deleted=0 AND l.next_follow_at=? AND l.status NOT IN ('已成交','已流失','停止跟进')
    `).all(today) as any[];

    const overdueLeads = db.prepare(`
      SELECT l.company_name, l.contact_name, l.phone, u.name AS owner_name, l.next_follow_at,
        CAST((julianday('now','localtime') - julianday(l.next_follow_at)) AS INTEGER) AS overdue_days
      FROM leads l LEFT JOIN users u ON l.owner_id=u.id
      WHERE l.is_deleted=0 AND l.next_follow_at < ? AND l.status NOT IN ('已成交','已流失','停止跟进')
      ORDER BY overdue_days DESC
    `).all(today) as any[];

    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="dashboard_${today}.xlsx"`,
    });

    const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: reply.raw });

    const ws1 = wb.addWorksheet('状态分布');
    ws1.columns = ['状态', '线索数'].map(header => ({ header, width: 18 }));
    ws1.getRow(1).font = { bold: true };
    for (const r of funnel) ws1.addRow([r.status, r.cnt]).commit();
    ws1.commit();

    const ws2 = wb.addWorksheet('本月来源效果');
    ws2.columns = ['来源', '线索数', '已成交', '转化率'].map(header => ({ header, width: 18 }));
    ws2.getRow(1).font = { bold: true };
    for (const r of bySource) {
      const rate = r.lead_count > 0 ? Math.round(r.deal_count / r.lead_count * 100) + '%' : '0%';
      ws2.addRow([r.source, r.lead_count, r.deal_count, rate]).commit();
    }
    ws2.commit();

    const ws3 = wb.addWorksheet('今日待跟进');
    ws3.columns = ['公司/联系人', '联系人', '手机', '负责人'].map(header => ({ header, width: 18 }));
    ws3.getRow(1).font = { bold: true };
    for (const r of todayLeads) ws3.addRow([r.company_name || r.contact_name, r.contact_name, r.phone, r.owner_name]).commit();
    ws3.commit();

    const ws4 = wb.addWorksheet('逾期未跟进');
    ws4.columns = ['公司/联系人', '联系人', '手机', '负责人', '原定日期', '逾期天数'].map(header => ({ header, width: 18 }));
    ws4.getRow(1).font = { bold: true };
    for (const r of overdueLeads) ws4.addRow([r.company_name || r.contact_name, r.contact_name, r.phone, r.owner_name, r.next_follow_at, r.overdue_days]).commit();
    ws4.commit();

    await wb.commit();
  });
}
