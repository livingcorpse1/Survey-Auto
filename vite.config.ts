import { defineConfig, loadEnv } from "vite";
import dyadComponentTagger from "@dyad-sh/react-vite-component-tagger";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { exec, execFile } from "child_process";
import util from "util";

const execAsync = util.promisify(exec);
const execFileAsync = util.promisify(execFile);

export default defineConfig(({ mode }) => {
  // Load .env variables so we can use them in the server plugin
  const env = loadEnv(mode, process.cwd(), '');

  const ADB = env.ADB_PATH || 'adb';
  const FRIDA = env.FRIDA_PATH || 'frida';
  let activeSerial = env.ADB_SERIAL?.trim() || '';
  const OPENROUTER_API_KEY = env.OPENROUTER_API_KEY?.trim() || '';
  const OPENROUTER_MODEL = env.OPENROUTER_MODEL?.trim() || 'nvidia/nemotron-3-ultra-550b-a55b:free';

  const listAdbDevices = async () => {
    const { stdout } = await execFileAsync(ADB, ['devices', '-l'], { windowsHide: true });
    return stdout.split(/\r?\n/).slice(1).flatMap((line: string) => {
      const match = line.trim().match(/^(\S+)\s+(device|offline|unauthorized)\b(.*)$/);
      return match ? [{ serial: match[1], state: match[2], details: match[3].trim() }] : [];
    });
  };

  const resolveSerial = async (requestedSerial = activeSerial) => {
    if (requestedSerial) return requestedSerial;
    const devices = (await listAdbDevices()).filter((device: any) => device.state === 'device');
    if (devices.length === 1) return devices[0].serial;
    if (devices.length === 0) throw new Error('No online Android device found. Connect a phone or enable ADB in BlueStacks.');
    throw new Error('More than one Android device is connected. Select the BlueStacks or phone device first.');
  };

  const runAdb = async (args: string[]) => {
    const serial = await resolveSerial();
    return execFileAsync(ADB, ['-s', serial, ...args], { windowsHide: true });
  };

  const cdpPlugin = () => ({
    name: 'cdp-plugin',
    configureServer(server: any) {

      server.middlewares.use('/api/openrouter/status', (req: any, res: any) => {
        if (req.method !== 'GET') return req.next();
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: true, configured: Boolean(OPENROUTER_API_KEY), model: OPENROUTER_MODEL }));
      });

      server.middlewares.use('/api/openrouter/chat', (req: any, res: any) => {
        if (req.method !== 'POST') return req.next();
        let body = '';
        req.on('data', (chunk: any) => { body += chunk.toString(); });
        req.on('end', async () => {
          res.setHeader('Content-Type', 'application/json');
          try {
            if (!OPENROUTER_API_KEY) throw new Error('Set OPENROUTER_API_KEY in the ignored .env file and restart SurveyPilot.');
            const { system, messages, max_tokens, tools, tool_choice } = JSON.parse(body || '{}');
            if (typeof system !== 'string' || !Array.isArray(messages)) throw new Error('A system prompt and message history are required.');
            if (tools !== undefined && !Array.isArray(tools)) throw new Error('Tools must be an array.');
            const upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'http://localhost:8080',
                'X-Title': 'SurveyPilot',
              },
              body: JSON.stringify({
                model: OPENROUTER_MODEL,
                messages: [{ role: 'system', content: system }, ...messages],
                max_tokens: Math.min(Math.max(Number(max_tokens) || 512, 1), 2048),
                ...(tools ? { tools, tool_choice: tool_choice || 'auto' } : {}),
                usage: { include: true },
              }),
            });
            const data = await upstream.json();
            res.statusCode = upstream.status;
            res.end(JSON.stringify({ success: upstream.ok, ...data }));
          } catch (e: any) {
            res.statusCode = e.message?.startsWith('Set OPENROUTER_API_KEY') ? 503 : 502;
            res.end(JSON.stringify({ success: false, error: e.message }));
          }
        });
      });

      // List and select one ADB target so commands never spill onto another device.
      server.middlewares.use('/api/adb-devices', async (req: any, res: any) => {
        if (req.method !== 'GET') return req.next();
        res.setHeader('Content-Type', 'application/json');
        try {
          const devices = await listAdbDevices();
          const online = devices.filter((device: any) => device.state === 'device');
          const selectedSerial = activeSerial || (online.length === 1 ? online[0].serial : '');
          res.end(JSON.stringify({ success: true, devices, selectedSerial }));
        } catch (e: any) {
          res.statusCode = 500;
          res.end(JSON.stringify({ success: false, error: e.message }));
        }
      });

      server.middlewares.use('/api/adb-select', (req: any, res: any) => {
        if (req.method !== 'POST') return req.next();
        let body = '';
        req.on('data', (chunk: any) => { body += chunk.toString(); });
        req.on('end', async () => {
          res.setHeader('Content-Type', 'application/json');
          try {
            const { serial } = JSON.parse(body || '{}');
            const devices = (await listAdbDevices()).filter((device: any) => device.state === 'device');
            const selected = serial ? devices.find((device: any) => device.serial === serial) : devices.length === 1 ? devices[0] : null;
            if (!selected) throw new Error(serial ? `ADB device ${serial} is not online.` : 'Select an online ADB device first.');
            activeSerial = selected.serial;
            res.end(JSON.stringify({ success: true, selectedSerial: activeSerial }));
          } catch (e: any) {
            res.statusCode = 400;
            res.end(JSON.stringify({ success: false, error: e.message }));
          }
        });
      });

      server.middlewares.use('/api/adb-connect', (req: any, res: any) => {
        if (req.method !== 'POST') return req.next();
        let body = '';
        req.on('data', (chunk: any) => { body += chunk.toString(); });
        req.on('end', async () => {
          res.setHeader('Content-Type', 'application/json');
          try {
            const { address } = JSON.parse(body || '{}');
            const addressMatch = typeof address === 'string' ? address.match(/^(localhost|127\.0\.0\.1):(\d{1,5})$/) : null;
            if (!addressMatch || Number(addressMatch[2]) < 1 || Number(addressMatch[2]) > 65535) {
              throw new Error('Use BlueStacks’ local ADB address, for example 127.0.0.1:5555.');
            }
            await execFileAsync(ADB, ['connect', address], { windowsHide: true });
            const devices = (await listAdbDevices()).filter((device: any) => device.state === 'device');
            const selected = devices.find((device: any) => device.serial.toLowerCase() === address.toLowerCase());
            if (!selected) throw new Error(`BlueStacks did not appear online at ${address}. Check that ADB is enabled and the port is correct.`);
            activeSerial = selected.serial;
            res.end(JSON.stringify({ success: true, selectedSerial: activeSerial }));
          } catch (e: any) {
            res.statusCode = 400;
            res.end(JSON.stringify({ success: false, error: e.message }));
          }
        });
      });
      
      // 1. Setup CDP Endpoint
      server.middlewares.use('/api/setup-cdp', (req: any, res: any) => {
        if (req.method !== 'POST') return req.next();
        let body = '';
        req.on('data', (chunk: any) => { body += chunk.toString(); });
        req.on('end', async () => {
          res.setHeader('Content-Type', 'application/json');
          try {
            const { appPackage } = JSON.parse(body || '{}');
            if (!appPackage) throw new Error("appPackage is required to find the PID.");

            // Find Target PID
            console.log(`[CDP Setup] Looking for ${appPackage} PID...`);
            if (!/^[a-zA-Z0-9._]+$/.test(appPackage)) throw new Error('Invalid app package name.');
            const { stdout: psOut } = await runAdb(['shell', 'ps', '-e']);
            const appLine = psOut.split(/\r?\n/).find((line: string) => {
              const processName = line.trim().split(/\s+/).at(-1) || '';
              return processName === appPackage || processName.startsWith(`${appPackage}:`);
            });
            if (!appLine) throw new Error(`App not running. Open ${appPackage} first.`);
            const pid = appLine.trim().split(/\s+/)[1];
            console.log(`[CDP Setup] Found PID: ${pid}`);

            console.log("[CDP Setup] Starting frida-server...");
            await runAdb(['shell', 'su', '-c', '/data/local/tmp/frida-server >/dev/null 2>&1 &']).catch(() => {});

            console.log("[CDP Setup] Injecting WebView debug flag via Frida...");
            try {
              await runAdb(['forward', '--remove', 'tcp:27042']).catch(() => {});
              await runAdb(['forward', 'tcp:27042', 'tcp:27042']);
              const script = "Java.perform(()=>{Java.scheduleOnMainThread(()=>{Java.use('android.webkit.WebView').setWebContentsDebuggingEnabled(true);})})";
              await execFileAsync(FRIDA, ['-H', '127.0.0.1:27042', '-p', pid, '-e', script], { windowsHide: true, timeout: 15000 });
            } catch(e) {
              console.log('[CDP Setup] Frida injection failed, trying port forward anyway...');
            }

            console.log("[CDP Setup] Forwarding ADB port 9222...");
            await runAdb(['forward', '--remove', 'tcp:9222']).catch(() => {});
            await runAdb(['forward', 'tcp:9222', `localabstract:webview_devtools_remote_${pid}`]);

            await new Promise(r => setTimeout(r, 1500));

            console.log("[CDP Setup] Fetching DevTools pages...");
            const wsRes = await fetch('http://127.0.0.1:9222/json');
            if (!wsRes.ok) throw new Error("Failed to connect to local port 9222. Forwarding may have failed.");
            const pages = await wsRes.json();

            if (!pages || pages.length === 0) {
              throw new Error("No WebView pages detected. Is a WebView currently visible on screen?");
            }

            let wsUrl = pages[0].webSocketDebuggerUrl;
            for (const p of pages) {
              if (p.type === 'page' && p.webSocketDebuggerUrl) {
                wsUrl = p.webSocketDebuggerUrl;
                break;
              }
            }

            if (!wsUrl) throw new Error("Could not find a valid WebSocket URL from DevTools.");

            console.log(`[CDP Setup] Success! WebSocket URL: ${wsUrl}`);
            res.end(JSON.stringify({ success: true, wsUrl }));

          } catch (e: any) {
            console.error(e);
            res.statusCode = 500;
            res.end(JSON.stringify({ success: false, error: e.message }));
          }
        });
      });

      // 2. Execute CDP Script Endpoint
      server.middlewares.use('/api/cdp', (req: any, res: any) => {
        if (req.method !== 'POST') return req.next();
        let body = '';
        req.on('data', (chunk: any) => { body += chunk.toString(); });
        req.on('end', async () => {
          try {
            const { wsUrl, script } = JSON.parse(body);
            const WebSocket = (await import('ws')).default;
            
            const ws = new WebSocket(wsUrl);
            
            await new Promise<void>((resolve, reject) => {
              ws.on('open', () => {
                ws.send(JSON.stringify({
                  id: 1,
                  method: 'Runtime.evaluate',
                  params: { 
                    expression: script, 
                    returnByValue: true 
                  }
                }));
              });

              ws.on('message', (data: any) => {
                const msg = JSON.parse(data.toString());
                if (msg.id === 1) {
                  res.setHeader('Content-Type', 'application/json');
                  
                  if (msg.result.exceptionDetails) {
                    const errorDesc = msg.result.exceptionDetails.exception?.description || 'JavaScript Exception occurred';
                    res.end(JSON.stringify({ success: false, error: errorDesc }));
                  } else {
                    res.end(JSON.stringify({ success: true, result: msg.result.result }));
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
              res.statusCode = 500;
              res.end(JSON.stringify({ success: false, error: e.message }));
            }
          }
        });
      });

      // 3. Execute ADB Tap Endpoint
      server.middlewares.use('/api/adb-tap', (req: any, res: any) => {
        if (req.method !== 'POST') return req.next();
        let body = '';
        req.on('data', (chunk: any) => { body += chunk.toString(); });
        req.on('end', async () => {
          res.setHeader('Content-Type', 'application/json');
          try {
            const { x, y } = JSON.parse(body);
            console.log(`[ADB Tap] Tapping at ${x}, ${y}`);
            await runAdb(['shell', 'input', 'tap', String(x), String(y)]);
            res.end(JSON.stringify({ success: true }));
          } catch (e: any) {
            console.error(e);
            res.statusCode = 500;
            res.end(JSON.stringify({ success: false, error: e.message }));
          }
        });
      });

      // 4. Execute ADB Keyevent Endpoint
      server.middlewares.use('/api/adb-keyevent', (req: any, res: any) => {
        if (req.method !== 'POST') return req.next();
        let body = '';
        req.on('data', (chunk: any) => { body += chunk.toString(); });
        req.on('end', async () => {
          res.setHeader('Content-Type', 'application/json');
          try {
            const { key } = JSON.parse(body);
            console.log(`[ADB Keyevent] Sending keyevent ${key}`);
            await runAdb(['shell', 'input', 'keyevent', String(key)]);
            res.end(JSON.stringify({ success: true }));
          } catch (e: any) {
            console.error(e);
            res.statusCode = 500;
            res.end(JSON.stringify({ success: false, error: e.message }));
          }
        });
      });

      // 5. Dump XML Endpoint
      server.middlewares.use('/api/dump-xml', (req: any, res: any) => {
        if (req.method !== 'POST') return req.next();
        let body = '';
        req.on('data', (chunk: any) => { body += chunk.toString(); });
        req.on('end', async () => {
          res.setHeader('Content-Type', 'application/json');
          try {
            await runAdb(['shell', 'uiautomator', 'dump', '/data/local/tmp/window_dump.xml']);
            const { stdout } = await runAdb(['shell', 'cat', '/data/local/tmp/window_dump.xml']);
            res.end(JSON.stringify({ success: true, xml: stdout }));
          } catch (e: any) {
            console.error(e);
            res.statusCode = 500;
            res.end(JSON.stringify({ success: false, error: e.message }));
          }
        });
      });

      // 6. Launch App Endpoint
      server.middlewares.use('/api/launch-app', (req: any, res: any) => {
        if (req.method !== 'POST') return req.next();
        let body = '';
        req.on('data', (chunk: any) => { body += chunk.toString(); });
        req.on('end', async () => {
          res.setHeader('Content-Type', 'application/json');
          try {
            const { appPackage } = JSON.parse(body);
            console.log(`[App Launch] Launching ${appPackage}`);
            if (!/^[a-zA-Z0-9._]+$/.test(appPackage)) throw new Error('Invalid app package name.');
            await runAdb(['shell', 'monkey', '-p', appPackage, '-c', 'android.intent.category.LAUNCHER', '1']);
            res.end(JSON.stringify({ success: true }));
          } catch (e: any) {
            console.error(e);
            res.statusCode = 500;
            res.end(JSON.stringify({ success: false, error: e.message }));
          }
        });
      });

      // 7. Run Scrcpy Endpoint
      server.middlewares.use('/api/run-scrcpy', (req: any, res: any) => {
        if (req.method !== 'POST') return req.next();
        let body = '';
        req.on('data', (chunk: any) => { body += chunk.toString(); });
        req.on('end', async () => {
          res.setHeader('Content-Type', 'application/json');
          try {
            const { directory, appPackage } = JSON.parse(body);
            const scrcpyExe = path.join(directory, 'scrcpy.exe');
            
            const child = exec(`"${scrcpyExe}" --new-display`);
            child.unref();
            
            if (appPackage) {
              setTimeout(() => {
                runAdb(['shell', 'monkey', '-p', appPackage, '-c', 'android.intent.category.LAUNCHER', '1']);
              }, 2000);
            }
            
            res.end(JSON.stringify({ success: true }));
          } catch (e: any) {
            console.error(e);
            res.statusCode = 500;
            res.end(JSON.stringify({ success: false, error: e.message }));
          }
        });
      });

    }
  });

  return {
    server: {
      host: "::",
      port: 8080,
    },
    plugins: [dyadComponentTagger(), react(), cdpPlugin()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
  };
});
