import type { z } from 'zod';
export type AiFeature = 'scheduled_follow_overdue' | 'daily_report';
export type AiProviderResult<T> = { data: T; provider: 'deepseek' | 'fake'; model: string; inputTokens?: number; outputTokens?: number; latencyMs: number };
export interface AiProvider { generateStructured<T>(options: { feature: AiFeature; systemPrompt: string; context: unknown; outputSchema: z.ZodType<T>; timeoutMs: number; requestId: string; signal: AbortSignal }): Promise<AiProviderResult<T>>; }
