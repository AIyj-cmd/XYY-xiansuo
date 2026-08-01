import { enqueueOpenClawSyntheticPilot } from '../openclaw-synthetic-pilot.js';

function value(args: readonly string[], name: string): string | undefined {
  const positions = args.map((arg, index) => arg === name ? index : -1).filter((index) => index >= 0);
  return positions.length === 1 && positions[0] < args.length - 1 ? args[positions[0] + 1] : undefined;
}
export function runOpenClawSyntheticPilotCli(args = process.argv): Record<string, unknown> {
  const values = args.slice(2); const databasePath = value(values, '--db-path'); const user = value(values, '--pilot-user-id'); const idempotencyKey = value(values, '--idempotency-key');
  if (!databasePath || !user || !idempotencyKey || values.length !== 6 || !['--db-path', '--pilot-user-id', '--idempotency-key'].every((flag) => values.includes(flag))) {
    throw new Error('用法: openclaw:enqueue-synthetic-pilot --db-path /tmp/私有目录/openclaw-synthetic-pilot.db --pilot-user-id 正整数 --idempotency-key 固定键');
  }
  const pilotUserId = Number(user);
  const result = enqueueOpenClawSyntheticPilot({ databasePath, pilotUserId, idempotencyKey });
  return { result: result.result, task_id: result.taskId, business_date: result.businessDate, database_path_hash: result.databasePathHash };
}
if (process.argv[1]?.endsWith('openclaw-enqueue-synthetic-pilot.ts') || process.argv[1]?.endsWith('openclaw-enqueue-synthetic-pilot.js')) {
  try { console.log(JSON.stringify(runOpenClawSyntheticPilotCli())); } catch (error) { process.exitCode = 2; console.log(JSON.stringify({ code: error instanceof Error ? error.message : 'OPENCLAW_SYNTHETIC_CLI_INVALID' })); }
}
