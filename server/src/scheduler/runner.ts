import type { DatabaseSync } from 'node:sqlite';
import type { AiConfig } from '../config.js';
import { DeepSeekProvider } from '../ai/providers/deepseek-provider.js';
import type { AiProvider } from '../ai/providers/provider.js';
import { listPilotRecipients } from '../ai/permission-query.js';
import { runScheduledFollow } from './jobs/scheduled-follow-overdue.js';
import { runDailyReport } from './jobs/daily-report.js';
import { cleanupAiRetention } from '../ai/audit-store.js';
export function shanghaiBusinessDate(now = new Date()): string { return now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }); }
export function shanghaiTime(now = new Date()): string { return now.toLocaleTimeString('sv-SE', { timeZone: 'Asia/Shanghai', hour12: false }).slice(0, 5); }
export async function runAiSchedulerOnce(db: DatabaseSync, config: AiConfig, now: string, provider?: AiProvider, options: { scheduledFollow?: boolean; dailyReport?: boolean; businessDate?: string } = {}): Promise<void> {
  cleanupAiRetention(db, now);
  const date = options.businessDate || shanghaiBusinessDate();
  const recipients = listPilotRecipients(db, config.pilotUserIds, config.scanRecipientLimit);
  const resolved = provider || (config.deepseekEnabled ? new DeepSeekProvider({ apiKey: config.apiKey!, baseUrl: config.baseUrl!, model: config.model!, maxOutputTokens: config.maxOutputTokens }) : undefined);
  const deadline = Date.now() + config.scanDeadlineMs;
  const scheduledFollow = options.scheduledFollow ?? config.scheduledFollowEnabled;
  const dailyReport = options.dailyReport ?? config.dailyReportEnabled;
  // Calling this explicitly is also used by tests/CLI. Normal process gates each job by Shanghai HH:mm.
  if (scheduledFollow) for (const recipient of recipients) {
    if (Date.now() >= deadline) break;
    try { await runScheduledFollow(db, config, resolved, recipient, date, now); } catch (error) { console.error(JSON.stringify({ event: 'ai.scheduler.recipient_error', job: 'scheduled_follow_overdue', user_id: recipient.id, error: error instanceof Error ? error.name : 'UnknownError' })); }
  }
  if (dailyReport) for (const recipient of recipients) {
    if (Date.now() >= deadline) break;
    try { await runDailyReport(db, config, resolved, recipient, date, now); } catch (error) { console.error(JSON.stringify({ event: 'ai.scheduler.recipient_error', job: 'daily_report', user_id: recipient.id, error: error instanceof Error ? error.name : 'UnknownError' })); }
  }
}
