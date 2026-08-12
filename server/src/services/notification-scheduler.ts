export type SchedulerScanResult<T> = { candidates: T[]; suppressed: number; deadlineExceeded: boolean };
export interface SchedulerJob<T> { readonly eventType: string; scan(options: { asOf: string; limit: number; deadlineAt: number; dryRun: boolean }): Promise<SchedulerScanResult<T>>; }
/** 阶段三刻意保持为空：不注册逾期、拜访、日报、周报或不活跃扫描器。 */
export const schedulerRegistry: readonly SchedulerJob<unknown>[] = [];
export function schedulerDryRunOptions(input: { as_of?: string; limit?: number; deadline_ms?: number } = {}) { const limit = Math.min(Math.max(input.limit ?? 100, 1), 1000); return { asOf: input.as_of ?? new Date().toISOString(), limit, deadlineAt: Date.now() + Math.min(Math.max(input.deadline_ms ?? 5000, 1), 30_000), dryRun: true as const }; }
