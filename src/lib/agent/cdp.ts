export const DEFAULT_CDP_PORT = 9222;

export const CDP_FETCH_TIMEOUT_MS = 3500;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export function isLoopbackHost(host: string | null | undefined): boolean {
  if (!host) return false;
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return LOOPBACK_HOSTS.has(normalized);
}

export interface DevToolsPage {
  type?: string;
  webSocketDebuggerUrl?: string;
  [key: string]: unknown;
}

export interface DevToolsListResult {
  success: boolean;
  pages: DevToolsPage[];
  error: string | null;
  timedOut: boolean;
}

export function validateDevToolsPages(payload: unknown): DevToolsListResult {
  if (!Array.isArray(payload)) {
    return { success: false, pages: [], error: 'DevTools returned invalid JSON (expected a page list).', timedOut: false };
  }
  const pages = payload as DevToolsPage[];
  const hasDebuggerUrl = pages.some(page => page && typeof page.webSocketDebuggerUrl === 'string');
  if (!hasDebuggerUrl) {
    return { success: false, pages, error: 'No WebView pages detected. Is a WebView currently visible on screen?', timedOut: false };
  }
  return { success: true, pages, error: null, timedOut: false };
}

/**
 * Fetch the DevTools page list from the adb forward with a hard timeout.
 * A stale forward (tunnel bound, target socket gone) accepts TCP then hangs;
 * the race below ensures we never block forever waiting for it.
 */
export async function fetchDevToolsPages(
  fetchImpl: typeof fetch = fetch,
  port = DEFAULT_CDP_PORT,
  timeoutMs = CDP_FETCH_TIMEOUT_MS,
): Promise<DevToolsListResult> {
  const reason = new DOMException('Timeout', 'AbortError');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(reason), timeoutMs);
  try {
    const response = await Promise.race([
      fetchImpl(`http://127.0.0.1:${port}/json`, { signal: controller.signal }),
      new Promise<never>((_, reject) => {
        timer.unref?.();
        setTimeout(() => reject(reason), timeoutMs + 200);
      }),
    ]);
    if (!response.ok) {
      return { success: false, pages: [], error: `DevTools returned HTTP ${response.status}.`, timedOut: false };
    }
    const payload = await response.json().catch(() => null);
    return validateDevToolsPages(payload);
  } catch (error) {
    return {
      success: false,
      pages: [],
      error: controller.signal.aborted
        ? 'Timed out waiting for DevTools on port 9222.'
        : 'Could not reach DevTools on port 9222. Forwarding may have failed.',
      timedOut: controller.signal.aborted,
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface DevToolsUrlParse {
  ok: boolean;
  protocol: string | null;
  host: string | null;
  port: number | null;
  isDevTools: boolean;
}

export function parseDevToolsUrl(rawUrl: string | null | undefined): DevToolsUrlParse {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    return { ok: false, protocol: null, host: null, port: null, isDevTools: false };
  }

  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return { ok: false, protocol: null, host: null, port: null, isDevTools: false };
  }

  const protocol = url.protocol.toLowerCase();
  const port = url.port ? Number(url.port) : null;
  const host = url.hostname || null;

  const hasDevToolsPath = /\/devtools\/(page|browser)\//.test(url.pathname);
  const isDevTools = (protocol === 'ws:' || protocol === 'wss:')
    && hasDevToolsPath
    && port !== null;

  return {
    ok: protocol === 'ws:' || protocol === 'wss:',
    protocol,
    host,
    port,
    isDevTools,
  };
}

/**
 * Allow only loopback DevTools WebSocket URLs (the local adb forward).
 * Rejects external hosts, ports other than the CDP forward, and non-DevTools paths.
 */
export function isAllowedDevToolsUrl(
  rawUrl: string | null | undefined,
  allowedPort = DEFAULT_CDP_PORT,
): boolean {
  const parsed = parseDevToolsUrl(rawUrl);
  if (!parsed.ok || !parsed.isDevTools) return false;
  if (parsed.port !== allowedPort) return false;
  return isLoopbackHost(parsed.host);
}
