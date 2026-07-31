import type { AiProvider, AiProviderResult } from './provider.js';
/** Test-only deterministic provider. It has no network dependency. */
export class FakeAiProvider implements AiProvider {
  constructor(private readonly responder: (input: any) => unknown) {}
  async generateStructured<T>(options: any): Promise<AiProviderResult<T>> {
    if (options.signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'AI_REQUEST_CANCELLED' });
    const data = options.outputSchema.parse(this.responder(options)); return { data, provider: 'fake', model: 'fake', latencyMs: 0 };
  }
}
