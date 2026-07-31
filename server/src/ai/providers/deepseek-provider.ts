import type { AiProvider, AiProviderError, AiProviderResult } from './provider.js';
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
  constructor(private readonly config: { apiKey: string; baseUrl: string; model: string; maxOutputTokens?: number }, private readonly fetchImpl: typeof fetch = fetch) {}
  async generateStructured<T>(options: any): Promise<AiProviderResult<T>> {
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
    const abort = () => controller.abort(); options.signal.addEventListener('abort', abort, { once: true });
    if (options.signal.aborted) controller.abort();
    let requestStarted = false;
    let started = 0;
    const elapsed = () => Math.max(0, Math.round(performance.now() - started));
    const withLatency = (error: unknown): AiProviderError => {
      const source = error as Partial<AiProviderError> | undefined;
      return Object.assign(new Error(source?.message || 'provider request failed'), {
        code: source?.code || 'AI_PROVIDER_UNAVAILABLE',
        retryable: source?.retryable === true,
        latencyMs: elapsed(),
      });
    };
    try {
      if (controller.signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'AI_REQUEST_CANCELLED' });
      started = performance.now();
      requestStarted = true;
      const response = await this.fetchImpl(`${this.config.baseUrl}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${this.config.apiKey}` }, signal: controller.signal, body: JSON.stringify({ model: this.config.model, stream: false, response_format: { type: 'json_object' }, thinking: { type: 'disabled' }, max_tokens: this.config.maxOutputTokens ?? 2048, messages: [{ role: 'system', content: options.systemPrompt }, { role: 'user', content: buildPromptContext(options.context) }] }) });
      if (!response.ok) { const code = response.status === 429 ? 'AI_PROVIDER_RATE_LIMITED' : response.status >= 500 ? 'AI_PROVIDER_UNAVAILABLE' : response.status === 401 || response.status === 402 || response.status === 403 ? 'AI_PROVIDER_AUTH_FAILED' : 'AI_RESPONSE_INVALID'; throw Object.assign(new Error(code), { code, retryable: response.status === 429 || response.status === 500 || response.status === 503 }); }
      const raw = await readBoundedBody(response, 32_768);
      let parsed: any; try { parsed = JSON.parse(raw); } catch { throw Object.assign(new Error('response not json'), { code: 'AI_RESPONSE_INVALID' }); }
      const choice = parsed?.choices?.[0];
      if (!choice || !choice.message) throw Object.assign(new Error('invalid response'), { code: 'AI_RESPONSE_INVALID' });
      if (['length', 'content_filter', 'insufficient_system_resource'].includes(choice.finish_reason)) throw Object.assign(new Error('unfinished output'), { code: 'AI_OUTPUT_REJECTED' });
      if (choice.message.tool_calls || choice.message.function_call) throw Object.assign(new Error('tool call rejected'), { code: 'AI_OUTPUT_REJECTED' });
      const content = choice.message.content;
      if (typeof content !== 'string' || !content.trim()) throw Object.assign(new Error('empty content'), { code: 'AI_RESPONSE_INVALID' });
      if (/^\s*```/.test(content)) throw Object.assign(new Error('markdown output'), { code: 'AI_OUTPUT_REJECTED' });
      let data: T; try { data = options.outputSchema.parse(JSON.parse(content)); assertSafeAiOutput(data); } catch { throw Object.assign(new Error('invalid output'), { code: 'AI_OUTPUT_REJECTED' }); }
      const inputTokens = Number.isSafeInteger(parsed?.usage?.prompt_tokens) && parsed.usage.prompt_tokens >= 0 ? parsed.usage.prompt_tokens : undefined;
      const outputTokens = Number.isSafeInteger(parsed?.usage?.completion_tokens) && parsed.usage.completion_tokens >= 0 ? parsed.usage.completion_tokens : undefined;
      return { data, provider: 'deepseek', model: this.config.model, inputTokens, outputTokens, latencyMs: elapsed() };
    } catch (error: any) {
      if (!requestStarted) throw Object.assign(new Error('cancelled'), { code: 'AI_REQUEST_CANCELLED', retryable: false });
      if (controller.signal.aborted) {
        throw withLatency(Object.assign(new Error(options.signal.aborted ? 'cancelled' : 'timeout'), {
          code: options.signal.aborted ? 'AI_REQUEST_CANCELLED' : 'AI_PROVIDER_TIMEOUT',
          retryable: !options.signal.aborted,
        }));
      }
      if (error?.code) throw withLatency(error);
      throw withLatency(Object.assign(new Error('network failure'), { code: 'AI_PROVIDER_UNAVAILABLE', retryable: true }));
    }
    finally { clearTimeout(timeout); options.signal.removeEventListener('abort', abort); }
  }
}
