import { DatabaseSync } from 'node:sqlite';
import { getDatabasePath, configureConnection } from '../db.js';
import { resolveAiConfig } from '../config.js';
import { todayDate } from '../utils/datetime.js';
import { buildLeadContext } from '../ai/context-builder.js';
import { getActiveRecipient, overdueLeads, dailyHighlights, dailyMetrics } from '../ai/permission-query.js';

function argument(name: string): string | undefined { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; }
const job = argument('--job'); const userId = Number(argument('--user-id')); const date = argument('--business-date') || todayDate();
if ((job !== 'scheduled_follow_overdue' && job !== 'daily_report') || !Number.isInteger(userId) || userId < 1 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('用法: ai:dry-run --job scheduled_follow_overdue|daily_report --user-id 正整数 [--business-date YYYY-MM-DD]');
const config = resolveAiConfig(); const db = new DatabaseSync(getDatabasePath(), { readOnly: true, enableForeignKeyConstraints: true }); configureConnection(db);
try { const recipient = getActiveRecipient(db, userId); if (!recipient) throw new Error('接收人不存在或已停用'); const source = job === 'scheduled_follow_overdue' ? overdueLeads(db, recipient, date) : { total: dailyHighlights(db, recipient, date).length, leads: dailyHighlights(db, recipient, date) }; const context = buildLeadContext(db, source.leads, date, config.maxContextChars); console.log(JSON.stringify({ job, recipient_user_id: userId, business_date: date, candidate_count: source.total, ordered_item_refs: context.items.map((item) => item.item_ref), context_hash: context.hash, context_chars: context.chars, clipped_items: source.total - context.items.length, redaction: '电话、微信号和控制字符不会查询或输出', ...(job === 'daily_report' ? { metrics: dailyMetrics(db, recipient, date) } : {}) })); } finally { db.close(); }
