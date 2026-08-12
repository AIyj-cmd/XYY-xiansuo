import path from 'node:path';
import { closeDb, getDb, initDb } from './db.js';
import { resolveAiConfig } from './config.js';
import { nowDatetime } from './utils/datetime.js';
import { runAiSchedulerOnce, shanghaiBusinessDate, shanghaiTime } from './scheduler/runner.js';
let stopping = false; let running: Promise<void> | undefined;
export async function startAiScheduler(): Promise<void> {
  const config = resolveAiConfig();
  if (!process.env.DB_PATH || !path.isAbsolute(process.env.DB_PATH)) throw new Error('AI Scheduler 启用时 DB_PATH 必须为与 API 相同的绝对路径');
  if ((config.scheduledFollowEnabled || config.dailyReportEnabled) && config.pilotUserIds.length === 0) {
    console.warn(JSON.stringify({ event: 'ai.scheduler.empty_pilot_allowlist' }));
  }
  initDb();
  const tick = async () => {
    if (stopping) return;
    const clock = new Date(); const now = nowDatetime(); const time = shanghaiTime(clock);
    const scheduledFollow = config.scheduledFollowEnabled && time === config.scheduledFollowTime;
    const dailyReport = config.dailyReportEnabled && time === config.dailyReportTime;
    if (scheduledFollow || dailyReport) {
      running = runAiSchedulerOnce(getDb(), config, now, undefined, { scheduledFollow, dailyReport, businessDate: shanghaiBusinessDate(clock) });
      try { await running; } catch (error) { console.error(JSON.stringify({ event: 'ai.scheduler.error', error: error instanceof Error ? error.name : 'UnknownError' })); } finally { running = undefined; }
    }
    if (!stopping) setTimeout(tick, 60_000);
  };
  await tick();
}
if (process.argv[1]?.endsWith('ai-scheduler.ts') || process.argv[1]?.endsWith('ai-scheduler.js')) { void startAiScheduler().catch((error) => { console.error(JSON.stringify({ event: 'ai.scheduler.start_failed', error: error instanceof Error ? error.message : 'UnknownError' })); process.exitCode = 1; }); const stop = () => { stopping = true; void (running || Promise.resolve()).finally(() => { closeDb(); process.exit(0); }); }; process.on('SIGTERM', stop); process.on('SIGINT', stop); }
