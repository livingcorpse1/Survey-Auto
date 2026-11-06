export class AbortError extends Error {
  constructor(message = 'Operation aborted') {
    super(message);
    this.name = 'AbortError';
  }
}

export function isAbortError(error: unknown): boolean {
  if (!error) return false;
  if (error instanceof AbortError) return true;
  if (typeof error === 'object' && error !== null && 'name' in error) {
    return (error as { name?: string }).name === 'AbortError';
  }
  return false;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AbortError();
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AbortError());
      return;
    }

    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new AbortError());
    };

    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function abortableFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
  signal?: AbortSignal,
): Promise<Response> {
  throwIfAborted(signal);
  return fetch(input, { ...init, signal: signal ?? init.signal });
}
