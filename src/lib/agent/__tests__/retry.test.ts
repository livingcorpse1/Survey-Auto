import { describe, expect, it, vi } from 'vitest';
import {
  backoffDelay,
  buildModelCandidates,
  DEFAULT_MAX_ATTEMPTS_PER_MODEL,
  isEmptyCompletion,
  isRetryableStatus,
  runWithModelFallback,
  shouldRetryCompletion,
} from '@/lib/agent/retry';
import { AbortError } from '@/lib/agent/abort';

const success = (value: string) => ({ ok: true, value, status: 200, retryable: false });
const retryableFailure = (status = 429, error = 'rate limited') => ({ ok: false, status, retryable: true, error });
const fatalFailure = (status = 400, error = 'bad request') => ({ ok: false, status, retryable: false, error });

function completion(content = 'hello', toolCalls: unknown[] = []) {
  return { choices: [{ message: { content, tool_calls: toolCalls } }] };
}

describe('model retry helpers', () => {
  it('treats 429, 408 and 5xx as retryable', () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(408)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(200)).toBe(false);
    expect(isRetryableStatus(undefined)).toBe(false);
  });

  it('detects empty completions but accepts content or tool calls', () => {
    expect(isEmptyCompletion(undefined)).toBe(true);
    expect(isEmptyCompletion({})).toBe(true);
    expect(isEmptyCompletion({ choices: [] })).toBe(true);
    expect(isEmptyCompletion({ choices: [{ message: { content: '   ' } }] })).toBe(true);
    expect(isEmptyCompletion(completion('answer'))).toBe(false);
    expect(isEmptyCompletion(completion('', [{ id: 'call_1' }]))).toBe(false);
    expect(isEmptyCompletion({ choices: [{ message: { content: [{ type: 'text', text: 'hi' }] } }] })).toBe(false);
  });

  it('retries 5xx and empty 200 responses', () => {
    expect(shouldRetryCompletion(500, {})).toBe(true);
    expect(shouldRetryCompletion(200, { choices: [] })).toBe(true);
    expect(shouldRetryCompletion(200, completion('ok'))).toBe(false);
    expect(shouldRetryCompletion(400, completion('ok'))).toBe(false);
  });

  it('adds jittered exponential backoff up to the cap', () => {
    expect(backoffDelay(1, () => 0)).toBe(400);
    expect(backoffDelay(1, () => 1)).toBe(800);
    expect(backoffDelay(2, () => 0)).toBe(800);
    expect(backoffDelay(3, () => 0)).toBe(1600);
    expect(backoffDelay(20, () => 1)).toBe(10_000);
  });

  it('deduplicates primary and fallback models', () => {
    expect(buildModelCandidates(' primary ', 'fallback')).toEqual(['primary', 'fallback']);
    expect(buildModelCandidates('primary', 'primary')).toEqual(['primary']);
    expect(buildModelCandidates('primary', '   ')).toEqual(['primary']);
  });
});

describe('runWithModelFallback', () => {
  it('recovers from rate limits within the primary model', async () => {
    const replies = [retryableFailure(429), retryableFailure(503), success('primary-ok')];
    const attempt = vi.fn().mockImplementation(async () => replies.shift());
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await runWithModelFallback({
      models: ['primary'],
      attempt,
      sleep,
      random: () => 0,
    });

    expect(result).toEqual({ ok: true, model: 'primary', value: 'primary-ok', attempts: 3 });
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 400);
    expect(sleep).toHaveBeenNthCalledWith(2, 800);
  });

  it('falls back to the secondary model after exhausting retries', async () => {
    const attempt = vi.fn().mockImplementation(async (model: string) => {
      if (model === 'primary') return retryableFailure(503, 'primary down');
      return success('fallback-ok');
    });
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await runWithModelFallback({
      models: ['primary', 'fallback'],
      attempt,
      sleep,
      random: () => 0,
    });

    expect(result).toEqual({ ok: true, model: 'fallback', value: 'fallback-ok', attempts: 4 });
    expect(attempt).toHaveBeenCalledTimes(4);
  });

  it('does not retry a non-retryable failure and moves to the next model', async () => {
    const attempt = vi.fn().mockImplementation(async (model: string) => {
      if (model === 'primary') return fatalFailure(400, 'bad request');
      return success('fallback-ok');
    });
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await runWithModelFallback({
      models: ['primary', 'fallback'],
      attempt,
      sleep,
    });

    expect(result).toEqual({ ok: true, model: 'fallback', value: 'fallback-ok', attempts: 2 });
    expect(sleep).not.toHaveBeenCalled();
  });

  it('reports the last failure after every model is exhausted', async () => {
    const attempt = vi.fn()
      .mockResolvedValueOnce(retryableFailure(429, 'first'))
      .mockResolvedValueOnce(retryableFailure(500, 'last'));

    const result = await runWithModelFallback({
      models: ['primary'],
      maxAttemptsPerModel: 2,
      attempt,
      sleep: async () => {},
      random: () => 0,
    });

    expect(result).toEqual({ ok: false, error: 'last', attempts: 2, status: 500 });
  });

  it('stops immediately when the signal aborts between attempts', async () => {
    const controller = new AbortController();
    const attempt = vi.fn().mockImplementation(async () => {
      controller.abort();
      return retryableFailure(429);
    });

    await expect(
      runWithModelFallback({
        models: ['primary'],
        maxAttemptsPerModel: DEFAULT_MAX_ATTEMPTS_PER_MODEL,
        attempt,
        sleep: async () => {},
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(AbortError);
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});
