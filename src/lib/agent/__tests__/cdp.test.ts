import { describe, expect, it } from 'vitest';
import { isAllowedDevToolsUrl, isLoopbackHost, parseDevToolsUrl } from '@/lib/agent/cdp';

const GOOD_URL = 'ws://127.0.0.1:9222/devtools/page/3E2FE2A1B2C3D4E5F6A7B8C9D0E1F2A';

describe('cdp url helpers', () => {
  it('allows the local adb DevTools forward', () => {
    expect(isAllowedDevToolsUrl(GOOD_URL)).toBe(true);
  });

  it('allows localhost and ::1 variants', () => {
    expect(isAllowedDevToolsUrl('ws://localhost:9222/devtools/browser/abc')).toBe(true);
    expect(isAllowedDevToolsUrl('ws://[::1]:9222/devtools/page/abc')).toBe(true);
  });

  it('rejects external hosts', () => {
    expect(isAllowedDevToolsUrl('ws://192.168.1.50:9222/devtools/page/abc')).toBe(false);
    expect(isAllowedDevToolsUrl('ws://devtools.example.com:9222/devtools/page/abc')).toBe(false);
    expect(isAllowedDevToolsUrl('ws://10.0.0.5:9222/devtools/page/abc')).toBe(false);
  });

  it('rejects other ports on loopback', () => {
    expect(isAllowedDevToolsUrl('ws://127.0.0.1:8080/devtools/page/abc')).toBe(false);
    expect(isAllowedDevToolsUrl('ws://127.0.0.1:3000/devtools/page/abc')).toBe(false);
  });

  it('rejects non-DevTools paths and protocols', () => {
    expect(isAllowedDevToolsUrl('ws://127.0.0.1:9222/json')).toBe(false);
    expect(isAllowedDevToolsUrl('http://127.0.0.1:9222/devtools/page/abc')).toBe(false);
    expect(isAllowedDevToolsUrl('https://127.0.0.1:9222/devtools/page/abc')).toBe(false);
    expect(isAllowedDevToolsUrl('ws://127.0.0.1:9222/')).toBe(false);
  });

  it('rejects malformed input', () => {
    expect(isAllowedDevToolsUrl('not a url')).toBe(false);
    expect(isAllowedDevToolsUrl('')).toBe(false);
    expect(isAllowedDevToolsUrl(null)).toBe(false);
    expect(isAllowedDevToolsUrl(undefined)).toBe(false);
  });

  it('parses host and port for diagnostics', () => {
    expect(parseDevToolsUrl(GOOD_URL)).toEqual({
      ok: true,
      protocol: 'ws:',
      host: '127.0.0.1',
      port: 9222,
      isDevTools: true,
    });
    expect(parseDevToolsUrl('ws://192.168.1.1:9222/devtools/page/abc').isDevTools).toBe(true);
  });

  it('recognizes loopback hosts', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('LOCALHOST')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('192.168.1.1')).toBe(false);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost(null)).toBe(false);
  });
});
