import type { z } from 'zod';
export type AiFeature = 'scheduled_follow_overdue' | 'daily_report';
export type AiProviderResult<T> = { data: T; provider: 'deepseek' | 'fake'; model: string; inputTokens?: number; outputTokens?: number; latencyMs: number };
/**
 * Safe, classified error metadata for an attempted Provider request.  It must
 * never contain an upstream body, prompt, context, Authorization value, or key.
 */
export type AiProviderError = Error & { code: string; retryable: boolean; latencyMs: number };
export interface AiProvider { generateStructured<T>(options: { feature: AiFeature; systemPrompt: string; context: unknown; outputSchema: z.ZodType<T>; timeoutMs: number; requestId: string; signal: AbortSignal }): Promise<AiProviderResult<T>>; }
