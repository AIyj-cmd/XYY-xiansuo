import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { enqueueOpenClawSyntheticPilot } from '../openclaw-synthetic-pilot.js';

function value(args: readonly string[], name: string): string | undefined {
  const positions = args.map((arg, index) => arg === name ? index : -1).filter((index) => index >= 0);
  return positions.length === 1 && positions[0] < args.length - 1 ? args[positions[0] + 1] : undefined;
}
function privateKey(keyFile: string | undefined, stdin: string | undefined): string {
  if (Boolean(keyFile) === Boolean(stdin)) throw new Error('OPENCLAW_SYNTHETIC_KEY_SOURCE_REQUIRED');
  if (stdin !== undefined) return stdin.trim();
  if (!keyFile || !path.isAbsolute(keyFile)) throw new Error('OPENCLAW_SYNTHETIC_KEY_FILE_INVALID');
  const resolved = path.resolve(keyFile); let stat: ReturnType<typeof lstatSync>;
  try { stat = lstatSync(resolved); } catch { throw new Error('OPENCLAW_SYNTHETIC_KEY_FILE_INVALID'); }
  const uid = process.getuid?.();
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || typeof uid !== 'number' || stat.uid !== uid) throw new Error('OPENCLAW_SYNTHETIC_KEY_FILE_INVALID');
  try { if (realpathSync(resolved) !== resolved) throw new Error('OPENCLAW_SYNTHETIC_KEY_FILE_INVALID'); } catch { throw new Error('OPENCLAW_SYNTHETIC_KEY_FILE_INVALID'); }
  return readFileSync(resolved, 'utf8').trim();
}
function positiveInteger(raw: string | undefined): number | undefined { return raw && /^\d+$/.test(raw) ? Number(raw) : undefined; }

export function runOpenClawSyntheticPilotCli(args = process.argv, stdin = ''): Record<string, unknown> {
  const values = args.slice(2); const databasePath = value(values, '--db-path'); const user = positiveInteger(value(values, '--pilot-user-id'));
  const generation = positiveInteger(value(values, '--generation')); const runId = value(values, '--run-id'); const authorizationId = value(values, '--authorization-id'); const deliveryRequestId = value(values, '--delivery-request-id');
  const previousKeyHash = value(values, '--previous-key-hash') ?? null; const useStdin = values.includes('--stdin'); const keyFile = value(values, '--key-file');
  const allowed = new Set(['--db-path','--pilot-user-id','--generation','--run-id','--authorization-id','--delivery-request-id','--previous-key-hash','--key-file','--stdin']);
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index]; if (!allowed.has(token)) throw new Error('OPENCLAW_SYNTHETIC_CLI_USAGE');
    if (token !== '--stdin') index += 1;
  }
  if (!databasePath || !user || !generation || !runId || !authorizationId || !deliveryRequestId || (generation === 1 ? previousKeyHash !== null : previousKeyHash === null)) throw new Error('OPENCLAW_SYNTHETIC_CLI_USAGE');
  const idempotencyKey = privateKey(keyFile, useStdin ? stdin : undefined);
  const result = enqueueOpenClawSyntheticPilot({ databasePath, pilotUserId: user, idempotencyKey, control: { runId, generation, authorizationId, deliveryRequestId, previousKeyHash } });
  return { result: result.result, task_id: result.taskId, business_date: result.businessDate, database_path_hash: result.databasePathHash, generation: result.generation, manifest_hash: result.manifestHash };
}
if (process.argv[1]?.endsWith('openclaw-enqueue-synthetic-pilot.ts') || process.argv[1]?.endsWith('openclaw-enqueue-synthetic-pilot.js')) {
  try { console.log(JSON.stringify(runOpenClawSyntheticPilotCli(process.argv, process.argv.includes('--stdin') ? readFileSync(0, 'utf8') : ''))); } catch (error) { process.exitCode = 2; console.log(JSON.stringify({ code: error instanceof Error ? error.message : 'OPENCLAW_SYNTHETIC_CLI_INVALID' })); }
}
