import type { ModelConfig } from './config.ts';
import { JournalError } from './errors.ts';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatUsage {
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
}

export interface ChatResult {
  content: string;
  usage: ChatUsage;
  model: string;
  finishReason: string | null;
}

export interface ChatProvider {
  complete(messages: ChatMessage[], options: { maxOutputTokens: number; timeoutMs?: number }): Promise<ChatResult>;
}

export interface ProviderDependencies {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
}

function classify(status: number, detail: string): JournalError {
  if (status === 401) return new JournalError('MODEL_UNAUTHORIZED', 'permanent', `${detail} (HTTP 401)`);
  if (status === 403) return new JournalError('MODEL_FORBIDDEN', 'permanent', `${detail} (HTTP 403)`);
  if (status === 429) return new JournalError('MODEL_RATE_LIMITED', 'transient', `${detail} (HTTP 429)`);
  if (status >= 500) return new JournalError('MODEL_UNAVAILABLE', 'transient', `${detail} (HTTP ${status})`);
  return new JournalError('MODEL_REQUEST', 'permanent', `${detail} (HTTP ${status})`);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function extractText(content: unknown): string | null {
  if (typeof content === 'string') return content.trim() || null;
  if (!Array.isArray(content)) return null;
  const text = content.map((part) => {
    if (typeof part === 'string') return part;
    if (part && typeof part === 'object') {
      const block = part as Record<string, unknown>;
      if (typeof block.text === 'string') return block.text;
      if (typeof block.content === 'string') return block.content;
    }
    return '';
  }).join('');
  return text.trim() || null;
}

/** Minimal OpenAI-compatible chat-completions client. The key is read only
 * from the configured environment variable and is never logged. */
export function createOpenAiCompatibleProvider(model: ModelConfig, dependencies: ProviderDependencies = {}): ChatProvider {
  const env = dependencies.env ?? process.env;
  const fetchImpl = dependencies.fetch ?? fetch;
  const key = env[model.apiKeyEnv];
  if (typeof key !== 'string' || !key.trim()) {
    throw new JournalError('MODEL_KEY_MISSING', 'config', `Environment variable ${model.apiKeyEnv} is missing or empty`);
  }
  if (key.trim() !== key) throw new JournalError('MODEL_KEY_MISSING', 'config', `Environment variable ${model.apiKeyEnv} has surrounding whitespace`);
  const endpoint = `${model.baseUrl.replace(/\/+$/, '')}/chat/completions`;

  return {
    async complete(messages: ChatMessage[], options: { maxOutputTokens: number; timeoutMs?: number }): Promise<ChatResult> {
      const timeoutMs = (options.timeoutMs ?? model.timeoutSeconds * 1000);
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${key}`,
            accept: 'application/json',
          },
          body: JSON.stringify({
            model: model.model,
            messages,
            temperature: 0.2,
            max_tokens: options.maxOutputTokens,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        if ((error as Error).name === 'TimeoutError' || (error as Error).name === 'AbortError') {
          throw new JournalError('MODEL_TIMEOUT', 'transient', 'Model request timed out');
        }
        throw new JournalError('MODEL_UNAVAILABLE', 'transient', `Model request failed: ${(error as Error).message}`);
      }
      const raw = await response.text();
      if (!response.ok) throw classify(response.status, `Model request failed: ${raw.slice(0, 300)}`);
      let body: unknown;
      try { body = JSON.parse(raw); } catch { throw new JournalError('MODEL_OUTPUT', 'permanent', 'Model response is not JSON'); }
      const value = body as Record<string, unknown>;
      const choices = value.choices;
      if (!Array.isArray(choices) || !choices.length) throw new JournalError('MODEL_OUTPUT', 'permanent', 'Model response has no choices');
      const choice = choices[0] as Record<string, unknown>;
      const message = choice.message as Record<string, unknown> | undefined;
      const content = extractText(message?.content);
      if (!content) {
        const finish = choice.finish_reason;
        const keys = message ? Object.keys(message).join(',') : 'missing';
        const usage = value.usage as Record<string, unknown> | undefined;
        const usageText = usage
          ? `usage=${JSON.stringify({ prompt_tokens: usage.prompt_tokens ?? null, completion_tokens: usage.completion_tokens ?? null })}`
          : 'usage=unknown';
        throw new JournalError('MODEL_OUTPUT', 'permanent',
          `Model response has no text content (finish_reason=${String(finish)}, message_keys=[${keys}], ${usageText})`);
      }
      const usage = value.usage as Record<string, unknown> | undefined;
      return {
        content,
        usage: {
          input_tokens: numberOrNull(usage?.prompt_tokens),
          output_tokens: numberOrNull(usage?.completion_tokens),
          total_tokens: numberOrNull(usage?.total_tokens),
        },
        model: typeof value.model === 'string' && value.model ? value.model : model.model,
        finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
      };
    },
  };
}
