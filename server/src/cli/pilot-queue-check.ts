import { getDatabasePath, openReadOnlyDatabase } from '../db.js';
import { nowDatetime } from '../utils/datetime.js';
import { inspectPilotQueue } from '../pilot-queue-check.js';

function argument(args: string[], name: string): string | undefined { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; }
export function runPilotQueueCheckCli(args = process.argv, databasePath = getDatabasePath()): Record<string, unknown> {
  const recipientUserId = Number(argument(args, '--recipient-user-id'));
  const eventType = argument(args, '--event-type'); const businessDate = argument(args, '--business-date'); const now = nowDatetime();
  if (!Number.isInteger(recipientUserId) || recipientUserId < 1 || (eventType !== 'scheduled_follow_overdue' && eventType !== 'daily_report') || !businessDate || !/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) throw new Error('用法: pilot:queue-check --recipient-user-id 正整数 --event-type scheduled_follow_overdue|daily_report --business-date YYYY-MM-DD');
  const db = openReadOnlyDatabase(databasePath);
  try { return inspectPilotQueue(db, { recipientUserId, eventType, businessDate, now, databasePath }); } finally { db.close(); }
}
if (process.argv[1]?.endsWith('pilot-queue-check.ts') || process.argv[1]?.endsWith('pilot-queue-check.js')) {
  const report = runPilotQueueCheckCli(); console.log(JSON.stringify(report)); if (report.conclusion !== 'SAFE') process.exitCode = 1;
}
