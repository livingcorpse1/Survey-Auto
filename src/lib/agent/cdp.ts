export const DEFAULT_CDP_PORT = 9222;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export function isLoopbackHost(host: string | null | undefined): boolean {
  if (!host) return false;
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return LOOPBACK_HOSTS.has(normalized);
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
