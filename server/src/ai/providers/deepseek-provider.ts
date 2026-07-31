import type { AiProvider, AiProviderResult } from './provider.js';
import { buildPromptContext } from '../prompt.js';
import { assertSafeAiOutput } from '../output-schemas.js';

async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (contentLength && Number(contentLength) > maxBytes) {
    throw Object.assign(new Error('response too large'), { code: 'AI_RESPONSE_INVALID' });
  }
  if (!response.body) return '';
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw Object.assign(new Error('response too large'), { code: 'AI_RESPONSE_INVALID' });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(combined);
}

export class DeepSeekProvider implements AiProvider {
  constructor(private readonly config: { apiKey: string; baseUrl: string; model: string }, private readonly fetchImpl: typeof fetch = fetch) {}
  async generateStructured<T>(options: any): Promise<AiProviderResult<T>> {
    const started = Date.now(); const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
    const abort = () => controller.abort(); options.signal.addEventListener('abort', abort, { once: true });
    if (options.signal.aborted) controller.abort();
    try {
      if (controller.signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'AI_REQUEST_CANCELLED' });
      const response = await this.fetchImpl(`${this.config.baseUrl}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${this.config.apiKey}` }, signal: controller.signal, body: JSON.stringify({ model: this.config.model, stream: false, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: options.systemPrompt }, { role: 'user', content: buildPromptContext(options.context) }] }) });
      if (!response.ok) { const code = response.status === 429 ? 'AI_PROVIDER_RATE_LIMITED' : response.status >= 500 ? 'AI_PROVIDER_UNAVAILABLE' : response.status === 401 || response.status === 402 || response.status === 403 ? 'AI_PROVIDER_AUTH_FAILED' : 'AI_RESPONSE_INVALID'; throw Object.assign(new Error(code), { code, retryable: response.status === 429 || response.status === 500 || response.status === 503 }); }
      const raw = await readBoundedBody(response, 32_768);
      let parsed: any; try { parsed = JSON.parse(raw); } catch { throw Object.assign(new Error('response not json'), { code: 'AI_RESPONSE_INVALID' }); }
      const content = parsed?.choices?.[0]?.message?.content; if (typeof content !== 'string' || !content.trim()) throw Object.assign(new Error('empty content'), { code: 'AI_RESPONSE_INVALID' });
      let data: T; try { data = options.outputSchema.parse(JSON.parse(content)); assertSafeAiOutput(data); } catch { throw Object.assign(new Error('invalid output'), { code: 'AI_OUTPUT_REJECTED' }); }
      const inputTokens = Number.isSafeInteger(parsed?.usage?.prompt_tokens) && parsed.usage.prompt_tokens >= 0 ? parsed.usage.prompt_tokens : undefined;
      const outputTokens = Number.isSafeInteger(parsed?.usage?.completion_tokens) && parsed.usage.completion_tokens >= 0 ? parsed.usage.completion_tokens : undefined;
      return { data, provider: 'deepseek', model: this.config.model, inputTokens, outputTokens, latencyMs: Date.now() - started };
    } catch (error: any) { if (controller.signal.aborted) throw Object.assign(new Error('timeout'), { code: options.signal.aborted ? 'AI_REQUEST_CANCELLED' : 'AI_PROVIDER_TIMEOUT', retryable: !options.signal.aborted }); if (error?.code) throw error; throw Object.assign(new Error('network failure'), { code: 'AI_PROVIDER_UNAVAILABLE', retryable: true }); }
    finally { clearTimeout(timeout); options.signal.removeEventListener('abort', abort); }
  }
}
