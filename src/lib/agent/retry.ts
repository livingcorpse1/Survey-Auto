import { AbortError } from './abort';

export const DEFAULT_MAX_ATTEMPTS_PER_MODEL = 3;
export const RETRY_BASE_DELAY_MS = 800;
export const RETRY_MAX_DELAY_MS = 10_000;

export interface CompletionAttempt<T> {
  ok: boolean;
  value?: T;
  status?: number;
  retryable: boolean;
  error?: string;
}

export interface RetryEvent {
  model: string;
  attempt: number;
  delayMs: number;
  reason: string;
}

export interface FallbackSuccess<T> {
  ok: true;
  model: string;
  value: T;
  attempts: number;
}

export interface FallbackFailure {
  ok: false;
  error: string;
  attempts: number;
  status?: number;
}

export function isRetryableStatus(status: number | undefined): boolean {
  if (!status) return false;
  return status === 408 || status === 429 || status >= 500;
}

export function isEmptyCompletion(payload: any): boolean {
  const message = payload?.choices?.[0]?.message;
  if (!message) return true;
  const text = typeof message.content === 'string' ? message.content.trim() : '';
  const contentParts = Array.isArray(message.content) ? message.content.length : 0;
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls.length : 0;
  return text.length === 0 && contentParts === 0 && toolCalls === 0;
}

export function shouldRetryCompletion(status: number | undefined, payload: any): boolean {
  if (isRetryableStatus(status)) return true;
  return status === 200 && isEmptyCompletion(payload);
}

export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const exponential = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1));
  const jitter = 0.5 + random() * 0.5;
  return Math.round(exponential * jitter);
}

export function buildModelCandidates(primary: string, fallback?: string): string[] {
  const candidates = [primary, fallback]
    .map(model => model?.trim())
    .filter((model): model is string => Boolean(model));
  return Array.from(new Set(candidates));
}

export async function runWithModelFallback<T>(options: {
  models: string[];
  maxAttemptsPerModel?: number;
  attempt: (model: string, attempt: number) => Promise<CompletionAttempt<T>>;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  onRetry?: (event: RetryEvent) => void;
  signal?: AbortSignal;
}): Promise<FallbackSuccess<T> | FallbackFailure> {
  const models = Array.from(new Set(options.models.filter(Boolean)));
  const maxAttempts = Math.max(1, options.maxAttemptsPerModel ?? DEFAULT_MAX_ATTEMPTS_PER_MODEL);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const random = options.random ?? Math.random;

  let attempts = 0;
  let lastError = 'All model attempts failed.';
  let lastStatus: number | undefined;

  for (const model of models) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (options.signal?.aborted) throw new AbortError();
      attempts++;
      const result = await options.attempt(model, attempt);
      lastStatus = result.status;
      lastError = result.error || `Model ${model} returned an empty response.`;

      if (result.ok) {
        return { ok: true, model, value: result.value as T, attempts };
      }

      if (!result.retryable) break;
      if (attempt < maxAttempts) {
        const delayMs = backoffDelay(attempt, random);
        options.onRetry?.({ model, attempt, delayMs, reason: lastError });
        await sleep(delayMs);
      }
    }
  }

  return { ok: false, error: lastError, attempts, status: lastStatus };
}
