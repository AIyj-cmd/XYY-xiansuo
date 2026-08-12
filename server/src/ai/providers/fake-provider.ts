import type { AiProvider, AiProviderError, AiProviderResult } from './provider.js';
/** Test-only deterministic provider. It has no network dependency. */
export class FakeAiProvider implements AiProvider {
  constructor(private readonly responder: (input: any) => unknown) {}
  async generateStructured<T>(options: any): Promise<AiProviderResult<T>> {
    if (options.signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'AI_REQUEST_CANCELLED' });
    const started = performance.now();
    const elapsed = () => Math.max(0, Math.round(performance.now() - started));
    try {
      const data = options.outputSchema.parse(this.responder(options));
      return { data, provider: 'fake', model: 'fake', latencyMs: elapsed() };
    } catch (error: any) {
      throw Object.assign(new Error('fake provider response invalid'), {
        code: error?.code || 'AI_OUTPUT_REJECTED',
        retryable: error?.retryable === true,
        latencyMs: elapsed(),
      }) as AiProviderError;
    }
  }
}
