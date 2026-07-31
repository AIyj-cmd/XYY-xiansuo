import { z } from 'zod';

const safeText = (max: number) => z.string().min(1).max(max);
export const scheduledFollowOutputSchema = z.object({
  title: safeText(40), summary: safeText(300),
  items: z.array(z.object({ item_ref: z.string().regex(/^L[1-9][0-9]*$/), reason: safeText(100), suggested_focus: safeText(160) }).strict()).min(1).max(10),
  closing: safeText(120),
}).strict();
export const dailyReportOutputSchema = z.object({
  title: safeText(40), summary: safeText(300), highlights: z.array(safeText(160)).max(5), actions: z.array(safeText(160)).max(5), closing: safeText(120),
}).strict();
export type ScheduledFollowOutput = z.infer<typeof scheduledFollowOutputSchema>;
export type DailyReportOutput = z.infer<typeof dailyReportOutputSchema>;

const forbidden = [/(?:\+?86[- ]?)?1[3-9]\d{9}/, /(?:wxid[_-]?|微信(?:号)?\s*[:：]?\s*)[A-Za-z][A-Za-z0-9_-]{5,}/i, /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, /(?:sk|api)[_-]?[A-Za-z0-9]{16,}/i, /[A-Za-z0-9+/]{40,}={0,2}/];
export function assertSafeAiOutput(value: unknown, maxBytes = 8192): void {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw Object.assign(new Error('AI 输出超过限制'), { code: 'AI_OUTPUT_REJECTED' });
  if (forbidden.some((pattern) => pattern.test(text))) throw Object.assign(new Error('AI 输出包含敏感信息'), { code: 'AI_OUTPUT_REJECTED' });
}
export function validateScheduledOutput(value: unknown, inputRefs: readonly string[]): ScheduledFollowOutput {
  const output = scheduledFollowOutputSchema.parse(value); assertSafeAiOutput(output);
  const seen = new Set<string>();
  for (const item of output.items) if (!inputRefs.includes(item.item_ref) || seen.has(item.item_ref)) throw Object.assign(new Error('AI 输出引用非法条目'), { code: 'AI_OUTPUT_REJECTED' }); else seen.add(item.item_ref);
  return output;
}
export function validateDailyOutput(value: unknown): DailyReportOutput { const output = dailyReportOutputSchema.parse(value); assertSafeAiOutput(output); return output; }
