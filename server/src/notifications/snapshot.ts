import { z } from 'zod';
import { dailyReportOutputSchema, scheduledFollowOutputSchema } from '../ai/output-schemas.js';
const path = z.string().regex(/^\/pages\/[A-Za-z0-9_/?=&-]+$/);
const ids = z.array(z.number().int().positive()).max(10).refine((value) => new Set(value).size === value.length, 'subject_lead_ids 不能重复');
const ownerSnapshot = z.object({ title: z.string().min(1).max(100), detail_path: path }).strict();
export const scheduledSnapshotSchema = scheduledFollowOutputSchema.extend({ schema_version: z.literal(1), subject_lead_ids: ids, business_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), fallback_used: z.boolean(), detail_path: z.literal('/pages/notify/index') }).strict();
export const dailySnapshotSchema = dailyReportOutputSchema.extend({ schema_version: z.literal(1), metrics: z.object({ today_new_count: z.number().int().nonnegative(), today_follow_up_count: z.number().int().nonnegative(), overdue_count: z.number().int().nonnegative(), next_day_count: z.number().int().nonnegative() }).strict(), subject_lead_ids: ids, business_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), scope: z.enum(['self','team']), fallback_used: z.boolean(), detail_path: z.literal('/pages/notify/index') }).strict();
export type NotificationSnapshot = z.infer<typeof ownerSnapshot> | z.infer<typeof scheduledSnapshotSchema> | z.infer<typeof dailySnapshotSchema>;
export function parseNotificationSnapshot(eventType: string, json: string): NotificationSnapshot {
  let value: unknown; try { value = JSON.parse(json); } catch { throw Object.assign(new Error('消息快照不合法'), { code: 'invalid_message_schema', permanent: true }); }
  try { if (eventType === 'owner_changed') return ownerSnapshot.parse(value); if (eventType === 'scheduled_follow_overdue') return scheduledSnapshotSchema.parse(value); if (eventType === 'daily_report') return dailySnapshotSchema.parse(value); } catch { throw Object.assign(new Error('消息快照不合法'), { code: 'invalid_message_schema', permanent: true }); }
  throw Object.assign(new Error('事件未实现'), { code: 'invalid_message_schema', permanent: true });
}
export type NotificationMessage = { title: string; body?: string; detailPath: string };
export function toChannelMessage(eventType: string, snapshot: NotificationSnapshot): NotificationMessage {
  let body: string | undefined;
  if (eventType === 'scheduled_follow_overdue') { const s = snapshot as z.infer<typeof scheduledSnapshotSchema>; body = [s.summary, ...s.items.map((item) => `• ${item.reason} ${item.suggested_focus}`), s.closing].join('\n'); }
  if (eventType === 'daily_report') { const s = snapshot as z.infer<typeof dailySnapshotSchema>; body = [s.summary, `新增 ${s.metrics.today_new_count}｜跟进 ${s.metrics.today_follow_up_count}｜逾期 ${s.metrics.overdue_count}｜次日 ${s.metrics.next_day_count}`, ...s.highlights, ...s.actions, s.closing].join('\n'); }
  if (body && body.length > 2000) body = body.slice(0, 2000);
  return { title: snapshot.title, ...(body ? { body } : {}), detailPath: snapshot.detail_path };
}
