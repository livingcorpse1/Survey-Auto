import { afterEach, describe, expect, it, vi } from 'vitest';
import { abortableFetch, AbortError, isAbortError, sleep, throwIfAborted } from '@/lib/agent/abort';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('abort helpers', () => {
  it('rejects a pending sleep as soon as the signal aborts', async () => {
    const controller = new AbortController();
    const pending = sleep(60_000, controller.signal);
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(AbortError);
  });

  it('throws before starting an HTTP request when already aborted', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    controller.abort();

    await expect(abortableFetch('/api/openrouter/chat', {}, controller.signal)).rejects.toBeInstanceOf(AbortError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards the abort signal to fetch', async () => {
    const response = new Response('{}', { status: 200 });
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    await abortableFetch('/api/dump-xml', { method: 'POST' }, controller.signal);

    expect(fetchMock).toHaveBeenCalledWith('/api/dump-xml', expect.objectContaining({ signal: controller.signal }));
  });

  it('recognizes native AbortError-shaped failures and ignores others', () => {
    expect(isAbortError(new AbortError())).toBe(true);
    expect(isAbortError(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe(true);
    expect(isAbortError(new Error('boom'))).toBe(false);
    expect(isAbortError(null)).toBe(false);
  });

  it('throwIfAborted is a no-op without an aborted signal', () => {
    expect(() => throwIfAborted()).not.toThrow();
    expect(() => throwIfAborted(new AbortController().signal)).not.toThrow();
  });
});
