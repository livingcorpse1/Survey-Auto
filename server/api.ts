import { exec, execFile } from 'node:child_process';
import path from 'node:path';
import util from 'node:util';
import {
  buildModelCandidates,
  isEmptyCompletion,
  runWithModelFallback,
  shouldRetryCompletion,
} from '../src/lib/agent/retry';
import { inspectDeviceStatus } from '../src/lib/agent/device';
import { DEFAULT_CDP_PORT, isAllowedDevToolsUrl } from '../src/lib/agent/cdp';

const execFileAsync = util.promisify(execFile);

export type ServerEnv = Record<string, string | undefined>;

export interface ApiState {
  adb: string;
  frida: string;
  activeSerial: string;
  openRouterApiKey: string;
  openRouterModel: string;
  openRouterFallbackModel: string;
  bluestacksAddress: string;
}

export interface ApiServer {
  middlewares: {
    use: (route: string, handler: (req: any, res: any) => void) => void;
  };
}

export function createApiState(env: ServerEnv): ApiState {
  return {
    adb: env.ADB_PATH || 'adb',
    frida: env.FRIDA_PATH || 'frida',
    activeSerial: env.ADB_SERIAL?.trim() || '',
    openRouterApiKey: env.OPENROUTER_API_KEY?.trim() || '',
    openRouterModel: env.OPENROUTER_MODEL?.trim() || 'nvidia/nemotron-3-ultra-550b-a55b:free',
    openRouterFallbackModel: env.OPENROUTER_MODEL_FALLBACK?.trim() || '',
    bluestacksAddress: env.BLUESTACKS_ADDRESS?.trim() || '127.0.0.1:5555',
  };
}

export interface AdbDevice {
  serial: string;
  state: string;
  details: string;
}

export async function listAdbDevices(state: ApiState): Promise<AdbDevice[]> {
  const { stdout } = await execFileAsync(state.adb, ['devices', '-l'], { windowsHide: true });
  return stdout.split(/\r?\n/).slice(1).flatMap((line: string) => {
    const match = line.trim().match(/^(\S+)\s+(device|offline|unauthorized)\b(.*)$/);
    return match ? [{ serial: match[1], state: match[2], details: match[3].trim() }] : [];
  });
}

export async function resolveSerial(state: ApiState, requestedSerial = state.activeSerial): Promise<string> {
  if (requestedSerial) return requestedSerial;
  const devices = (await listAdbDevices(state)).filter(device => device.state === 'device');
  if (devices.length === 1) return devices[0].serial;
  if (devices.length === 0) throw new Error('No online Android device found. Connect a phone or enable ADB in BlueStacks.');
  throw new Error('More than one Android device is connected. Select the BlueStacks or phone device first.');
}

export async function runAdb(state: ApiState, args: string[]) {
  const serial = await resolveSerial(state);
  return execFileAsync(state.adb, ['-s', serial, ...args], { windowsHide: true });
}

function readJsonBody(req: any): Promise<any> {
  return new Promise(resolve => {
    let body = '';
    req.on('data', (chunk: any) => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

function sendJson(res: any, statusCode: number, payload: unknown) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

export function registerApi(middlewares: ApiServer['middlewares'], state: ApiState) {
  middlewares.use('/api/openrouter/status', (req: any, res: any) => {
    if (req.method !== 'GET') return req.next?.();
    sendJson(res, 200, {
      success: true,
      configured: Boolean(state.openRouterApiKey),
      model: state.openRouterModel,
      fallbackModel: state.openRouterFallbackModel || null,
    });
  });

  middlewares.use('/api/openrouter/chat', async (req: any, res: any) => {
    if (req.method !== 'POST') return req.next?.();
    try {
      if (!state.openRouterApiKey) throw new Error('Set OPENROUTER_API_KEY in the ignored .env file and restart SurveyPilot.');
      const { system, messages, max_tokens, tools, tool_choice } = await readJsonBody(req);
      if (typeof system !== 'string' || !Array.isArray(messages)) throw new Error('A system prompt and message history are required.');
      if (tools !== undefined && !Array.isArray(tools)) throw new Error('Tools must be an array.');
      const models = buildModelCandidates(state.openRouterModel, state.openRouterFallbackModel);
      const result = await runWithModelFallback<{ status: number; data: any }>({
        models,
        attempt: async (model) => {
          const upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${state.openRouterApiKey}`,
              'Content-Type': 'application/json',
              'HTTP-Referer': 'http://localhost:8080',
              'X-Title': 'SurveyPilot',
            },
            body: JSON.stringify({
              model,
              messages: [{ role: 'system', content: system }, ...messages],
              max_tokens: Math.min(Math.max(Number(max_tokens) || 4096, 1), 4096),
              ...(tools ? { tools, tool_choice: tool_choice || 'auto' } : {}),
              usage: { include: true },
            }),
          });
          let data: any = null;
          try {
            data = await upstream.json();
          } catch {
            data = null;
          }
          const empty = isEmptyCompletion(data);
          return {
            ok: upstream.ok && !empty,
            value: { status: upstream.status, data },
            status: upstream.status,
            retryable: shouldRetryCompletion(upstream.status, data),
            error: upstream.ok
              ? 'OpenRouter returned an empty completion.'
              : data?.error?.message || `OpenRouter request failed (${upstream.status}).`,
          };
        },
        onRetry: event => {
          console.log(`[OpenRouter] ${event.model} attempt ${event.attempt} failed (${event.reason}); retrying in ${event.delayMs}ms.`);
        },
      });

      if (!result.ok) {
        sendJson(res, result.status && result.status >= 400 ? result.status : 502, {
          success: false,
          error: result.error,
          attempts: result.attempts,
        });
        return;
      }

      sendJson(res, result.value.status, {
        success: true,
        ...result.value.data,
        model: result.model,
        attempts: result.attempts,
        fallbackUsed: result.model !== state.openRouterModel,
      });
    } catch (e: any) {
      sendJson(res, e.message?.startsWith('Set OPENROUTER_API_KEY') ? 503 : 502, { success: false, error: e.message });
    }
  });

  // List and select one ADB target so commands never spill onto another device.
  middlewares.use('/api/adb-devices', async (req: any, res: any) => {
    if (req.method !== 'GET') return req.next?.();
    try {
      const devices = await listAdbDevices(state);
      const online = devices.filter(device => device.state === 'device');
      const selectedSerial = state.activeSerial || (online.length === 1 ? online[0].serial : '');
      sendJson(res, 200, { success: true, devices, selectedSerial });
    } catch (e: any) {
      sendJson(res, 500, { success: false, error: e.message });
    }
  });

  // Watchdog used by the agent before each step: verify the target is still online
  // and reconnect a dropped BlueStacks/emulator adb bridge when it can.
  middlewares.use('/api/adb-ensure', async (req: any, res: any) => {
    if (req.method !== 'POST') return req.next?.();
    try {
      const body = await readJsonBody(req);
      const serial = typeof body.serial === 'string' ? body.serial.trim() : state.activeSerial;
      const address = typeof body.address === 'string' && body.address.trim()
        ? body.address.trim()
        : state.bluestacksAddress;
      const readStatus = async () => {
        const { stdout } = await execFileAsync(state.adb, ['devices', '-l'], { windowsHide: true });
        return inspectDeviceStatus(stdout, serial, address);
      };

      let status = await readStatus();
      let reconnected = false;
      let connectOutput = '';

      if (status.recoveryReason && status.reconnectTarget) {
        try {
          const { stdout, stderr } = await execFileAsync(
            state.adb,
            ['connect', status.reconnectTarget],
            { windowsHide: true, timeout: 10_000 },
          );
          connectOutput = `${stdout}${stderr}`.trim();
          reconnected = /connected to/i.test(connectOutput) && !/unable to connect|failed to connect|cannot connect/i.test(connectOutput);
        } catch (e: any) {
          connectOutput = e.message;
        }
        if (reconnected) {
          await new Promise(resolve => setTimeout(resolve, 1200));
          status = await readStatus();
        }
      }

      sendJson(res, 200, {
        success: status.recoveryReason === null,
        reconnected,
        connectOutput,
        ...status,
      });
    } catch (e: any) {
      sendJson(res, 502, { success: false, error: e.message });
    }
  });

  middlewares.use('/api/adb-select', async (req: any, res: any) => {
    if (req.method !== 'POST') return req.next?.();
    try {
      const { serial } = await readJsonBody(req);
      const devices = (await listAdbDevices(state)).filter(device => device.state === 'device');
      const selected = serial ? devices.find(device => device.serial === serial) : devices.length === 1 ? devices[0] : null;
      if (!selected) throw new Error(serial ? `ADB device ${serial} is not online.` : 'Select an online ADB device first.');
      state.activeSerial = selected.serial;
      sendJson(res, 200, { success: true, selectedSerial: state.activeSerial });
    } catch (e: any) {
      sendJson(res, 400, { success: false, error: e.message });
    }
  });

  middlewares.use('/api/adb-connect', async (req: any, res: any) => {
    if (req.method !== 'POST') return req.next?.();
    try {
      const { address } = await readJsonBody(req);
      const addressMatch = typeof address === 'string' ? address.match(/^(localhost|127\.0\.0\.1):(\d{1,5})$/) : null;
      if (!addressMatch || Number(addressMatch[2]) < 1 || Number(addressMatch[2]) > 65535) {
        throw new Error('Use BlueStacks’ local ADB address, for example 127.0.0.1:5555.');
      }
      await execFileAsync(state.adb, ['connect', address], { windowsHide: true });
      const devices = (await listAdbDevices(state)).filter(device => device.state === 'device');
      const selected = devices.find(device => device.serial.toLowerCase() === address.toLowerCase());
      if (!selected) throw new Error(`BlueStacks did not appear online at ${address}. Check that ADB is enabled and the port is correct.`);
      state.activeSerial = selected.serial;
      sendJson(res, 200, { success: true, selectedSerial: state.activeSerial });
    } catch (e: any) {
      sendJson(res, 400, { success: false, error: e.message });
    }
  });

  // 1. Setup CDP Endpoint
  middlewares.use('/api/setup-cdp', async (req: any, res: any) => {
    if (req.method !== 'POST') return req.next?.();
    try {
      const { appPackage } = await readJsonBody(req);
      if (!appPackage) throw new Error("appPackage is required to find the PID.");

      console.log(`[CDP Setup] Looking for ${appPackage} PID...`);
      if (!/^[a-zA-Z0-9._]+$/.test(appPackage)) throw new Error('Invalid app package name.');
      const { stdout: psOut } = await runAdb(state, ['shell', 'ps', '-e']);
      const appLine = psOut.split(/\r?\n/).find((line: string) => {
        const processName = line.trim().split(/\s+/).at(-1) || '';
        return processName === appPackage || processName.startsWith(`${appPackage}:`);
      });
      if (!appLine) throw new Error(`App not running. Open ${appPackage} first.`);
      const pid = appLine.trim().split(/\s+/)[1];
      console.log(`[CDP Setup] Found PID: ${pid}`);

      console.log('[CDP Setup] Starting frida-server...');
      await runAdb(state, ['shell', 'su', '-c', '/data/local/tmp/frida-server >/dev/null 2>&1 &']).catch(() => {});

      console.log('[CDP Setup] Injecting WebView debug flag via Frida...');
      try {
        await runAdb(state, ['forward', '--remove', 'tcp:27042']).catch(() => {});
        await runAdb(state, ['forward', 'tcp:27042', 'tcp:27042']);
        const script = "Java.perform(()=>{Java.scheduleOnMainThread(()=>{Java.use('android.webkit.WebView').setWebContentsDebuggingEnabled(true);})})";
        await execFileAsync(state.frida, ['-H', '127.0.0.1:27042', '-p', pid, '-e', script], { windowsHide: true, timeout: 15000 });
      } catch {
        console.log('[CDP Setup] Frida injection failed, trying port forward anyway...');
      }

      console.log('[CDP Setup] Forwarding ADB port 9222...');
      await runAdb(state, ['forward', '--remove', 'tcp:9222']).catch(() => {});
      await runAdb(state, ['forward', 'tcp:9222', `localabstract:webview_devtools_remote_${pid}`]);

      await new Promise(r => setTimeout(r, 1500));

      console.log('[CDP Setup] Fetching DevTools pages...');
      const wsRes = await fetch('http://127.0.0.1:9222/json');
      if (!wsRes.ok) throw new Error('Failed to connect to local port 9222. Forwarding may have failed.');
      const pages = (await wsRes.json()) as any[];

      if (!pages || pages.length === 0) {
        throw new Error('No WebView pages detected. Is a WebView currently visible on screen?');
      }

      let wsUrl = pages[0].webSocketDebuggerUrl;
      for (const page of pages) {
        if (page.type === 'page' && page.webSocketDebuggerUrl) {
          wsUrl = page.webSocketDebuggerUrl;
          break;
        }
      }

      if (!wsUrl) throw new Error('Could not find a valid WebSocket URL from DevTools.');
      if (!isAllowedDevToolsUrl(wsUrl, DEFAULT_CDP_PORT)) {
        throw new Error('DevTools returned a non-loopback WebSocket URL; refusing to expose it.');
      }

      console.log(`[CDP Setup] Success! WebSocket URL: ${wsUrl}`);
      sendJson(res, 200, { success: true, wsUrl });
    } catch (e: any) {
      console.error(e);
      sendJson(res, 500, { success: false, error: e.message });
    }
  });

  // 2. Execute CDP Script Endpoint
  middlewares.use('/api/cdp', async (req: any, res: any) => {
    if (req.method !== 'POST') return req.next?.();
    try {
      const { wsUrl, script } = await readJsonBody(req);
      if (!isAllowedDevToolsUrl(wsUrl, DEFAULT_CDP_PORT)) {
        sendJson(res, 400, { success: false, error: 'CDP URL must be a loopback DevTools WebSocket (127.0.0.1:9222).' });
        return;
      }
      const WebSocket = (await import('ws')).default;

      const ws = new WebSocket(wsUrl);

      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => {
          ws.send(JSON.stringify({
            id: 1,
            method: 'Runtime.evaluate',
            params: {
              expression: script,
              returnByValue: true,
            },
          }));
        });

        ws.on('message', (data: any) => {
          const msg = JSON.parse(data.toString());
          if (msg.id === 1) {
            if (msg.result.exceptionDetails) {
              const errorDesc = msg.result.exceptionDetails.exception?.description || 'JavaScript Exception occurred';
              sendJson(res, 200, { success: false, error: errorDesc });
            } else {
              sendJson(res, 200, { success: true, result: msg.result.result });
            }

            ws.close();
            resolve();
          }
        });

        ws.on('error', (err: any) => {
          reject(err);
        });
      });
    } catch (e: any) {
      console.error(e);
      if (!res.headersSent) {
        sendJson(res, 500, { success: false, error: e.message });
      }
    }
  });

  // 3. Execute ADB Tap Endpoint
  middlewares.use('/api/adb-tap', async (req: any, res: any) => {
    if (req.method !== 'POST') return req.next?.();
    try {
      const { x, y } = await readJsonBody(req);
      console.log(`[ADB Tap] Tapping at ${x}, ${y}`);
      await runAdb(state, ['shell', 'input', 'tap', String(x), String(y)]);
      sendJson(res, 200, { success: true });
    } catch (e: any) {
      console.error(e);
      sendJson(res, 500, { success: false, error: e.message });
    }
  });

  // 4. Execute ADB Keyevent Endpoint
  middlewares.use('/api/adb-keyevent', async (req: any, res: any) => {
    if (req.method !== 'POST') return req.next?.();
    try {
      const { key } = await readJsonBody(req);
      console.log(`[ADB Keyevent] Sending keyevent ${key}`);
      await runAdb(state, ['shell', 'input', 'keyevent', String(key)]);
      sendJson(res, 200, { success: true });
    } catch (e: any) {
      console.error(e);
      sendJson(res, 500, { success: false, error: e.message });
    }
  });

  // 5. Dump XML Endpoint
  middlewares.use('/api/dump-xml', async (req: any, res: any) => {
    if (req.method !== 'POST') return req.next?.();
    try {
      await runAdb(state, ['shell', 'uiautomator', 'dump', '/data/local/tmp/window_dump.xml']);
      const { stdout } = await runAdb(state, ['shell', 'cat', '/data/local/tmp/window_dump.xml']);
      sendJson(res, 200, { success: true, xml: stdout });
    } catch (e: any) {
      console.error(e);
      sendJson(res, 500, { success: false, error: e.message });
    }
  });

  // 6. Screen Size Endpoint
  middlewares.use('/api/screen-size', async (req: any, res: any) => {
    if (req.method !== 'GET') return req.next?.();
    try {
      const { stdout } = await runAdb(state, ['shell', 'wm', 'size']);
      sendJson(res, 200, { success: true, size: stdout.trim() });
    } catch (e: any) {
      console.error(e);
      sendJson(res, 500, { success: false, error: e.message });
    }
  });

  // 7. Launch App Endpoint
  middlewares.use('/api/launch-app', async (req: any, res: any) => {
    if (req.method !== 'POST') return req.next?.();
    try {
      const { appPackage } = await readJsonBody(req);
      console.log(`[App Launch] Launching ${appPackage}`);
      if (!/^[a-zA-Z0-9._]+$/.test(appPackage)) throw new Error('Invalid app package name.');
      await runAdb(state, ['shell', 'monkey', '-p', appPackage, '-c', 'android.intent.category.LAUNCHER', '1']);
      sendJson(res, 200, { success: true });
    } catch (e: any) {
      console.error(e);
      sendJson(res, 500, { success: false, error: e.message });
    }
  });

  // 8. Run Scrcpy Endpoint
  middlewares.use('/api/run-scrcpy', async (req: any, res: any) => {
    if (req.method !== 'POST') return req.next?.();
    try {
      const { directory, appPackage } = await readJsonBody(req);
      const scrcpyExe = path.join(directory, 'scrcpy.exe');

      const child = exec(`"${scrcpyExe}" --new-display`);
      child.unref();

      if (appPackage) {
        setTimeout(() => {
          runAdb(state, ['shell', 'monkey', '-p', appPackage, '-c', 'android.intent.category.LAUNCHER', '1']);
        }, 2000);
      }

      sendJson(res, 200, { success: true });
    } catch (e: any) {
      console.error(e);
      sendJson(res, 500, { success: false, error: e.message });
    }
  });
}

export function createApiPlugin(env: ServerEnv) {
  const state = createApiState(env);
  return {
    name: 'survey-pilot-api',
    configureServer(server: ApiServer) {
      registerApi(server.middlewares, state);
    },
    configurePreviewServer(server: ApiServer) {
      registerApi(server.middlewares, state);
    },
  };
}
