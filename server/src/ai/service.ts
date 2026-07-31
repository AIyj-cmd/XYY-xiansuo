import type { AiConfig } from '../config.js';
import { dailyFallback, scheduledFallback } from './fallback.js';
import { systemPrompt } from './prompt.js';
import { dailyReportOutputSchema, scheduledFollowOutputSchema, validateDailyOutput, validateScheduledOutput } from './output-schemas.js';
import type { AiProvider } from './providers/provider.js';
import type { ContextItem } from './context-builder.js';

type GenerationResult = { value: any; fallback: boolean; attempts: number; provider?: string; model?: string; inputTokens?: number; outputTokens?: number; latencyMs?: number; errorCode?: string };
export async function generateScheduled(config: AiConfig, provider: AiProvider | undefined, requestId: string, context: unknown, items: ContextItem[], reserve?: () => boolean): Promise<GenerationResult> {
  if (!config.deepseekEnabled || !provider) return config.fallbackEnabled ? { value: scheduledFallback(items), fallback: true, attempts: 0, errorCode: 'DEEPSEEK_DISABLED' } : Promise.reject(Object.assign(new Error('disabled'), { code: 'DEEPSEEK_DISABLED' }));
  let error: any; let attempts = 0;
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (reserve && !reserve()) {
      if (config.fallbackEnabled) return { value: scheduledFallback(items), fallback: true, attempts, errorCode: 'AI_DAILY_LIMIT_EXCEEDED' };
      throw Object.assign(new Error('daily limit'), { code: 'AI_DAILY_LIMIT_EXCEEDED' });
    }
    attempts += 1;
    try {
      const result = await provider.generateStructured({ feature: 'scheduled_follow_overdue', systemPrompt: systemPrompt('scheduled_follow_overdue'), context, outputSchema: scheduledFollowOutputSchema, timeoutMs: config.requestTimeoutMs, requestId, signal: new AbortController().signal });
      return { value: validateScheduledOutput(result.data, items.map((i) => i.item_ref)), fallback: false, attempts, provider: result.provider, model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens, latencyMs: result.latencyMs };
    } catch (caught: any) { error = caught; if (!caught?.retryable || attempt === 2) break; }
  }
  if (config.fallbackEnabled) return { value: scheduledFallback(items), fallback: true, attempts, errorCode: error?.code || 'AI_INTERNAL_ERROR' };
  throw error;
}
export async function generateDaily(config: AiConfig, provider: AiProvider | undefined, requestId: string, context: unknown, metrics: Record<string, number>, reserve?: () => boolean): Promise<GenerationResult> {
  if (!config.deepseekEnabled || !provider) return config.fallbackEnabled ? { value: dailyFallback(metrics), fallback: true, attempts: 0, errorCode: 'DEEPSEEK_DISABLED' } : Promise.reject(Object.assign(new Error('disabled'), { code: 'DEEPSEEK_DISABLED' }));
  let error: any; let attempts = 0;
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (reserve && !reserve()) {
      if (config.fallbackEnabled) return { value: dailyFallback(metrics), fallback: true, attempts, errorCode: 'AI_DAILY_LIMIT_EXCEEDED' };
      throw Object.assign(new Error('daily limit'), { code: 'AI_DAILY_LIMIT_EXCEEDED' });
    }
    attempts += 1;
    try {
      const result = await provider.generateStructured({ feature: 'daily_report', systemPrompt: systemPrompt('daily_report'), context, outputSchema: dailyReportOutputSchema, timeoutMs: config.requestTimeoutMs, requestId, signal: new AbortController().signal });
      return { value: validateDailyOutput(result.data), fallback: false, attempts, provider: result.provider, model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens, latencyMs: result.latencyMs };
    } catch (caught: any) { error = caught; if (!caught?.retryable || attempt === 2) break; }
  }
  if (config.fallbackEnabled) return { value: dailyFallback(metrics), fallback: true, attempts, errorCode: error?.code || 'AI_INTERNAL_ERROR' };
  throw error;
}
