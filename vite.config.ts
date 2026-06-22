import { defineConfig, loadEnv } from "vite";
import dyadComponentTagger from "@dyad-sh/react-vite-component-tagger";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { exec } from "child_process";
import util from "util";

const execAsync = util.promisify(exec);

export default defineConfig(({ mode }) => {
  // Load .env variables so we can use them in the server plugin
  const env = loadEnv(mode, process.cwd(), '');

  const ADB = env.ADB_PATH || 'adb';
  const FRIDA = env.FRIDA_PATH || 'frida';

  const cdpPlugin = () => ({
    name: 'cdp-plugin',
    configureServer(server: any) {
      
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
            const { stdout: psOut } = await execAsync(`"${ADB}" shell "ps -e | grep ${appPackage}"`);
            const lines = psOut.trim().split('\n');
            if (!lines[0]) throw new Error(`App not running. Open ${appPackage} first.`);
            
            const pid = lines[0].trim().split(/\s+/)[1];
            console.log(`[CDP Setup] Found PID: ${pid}`);

            console.log("[CDP Setup] Starting frida-server...");
            await execAsync(`"${ADB}" shell su -c '/data/local/tmp/frida-server &'`).catch(() => {});

            console.log("[CDP Setup] Injecting WebView debug flag via Frida...");
            const fridaCmd = `"${FRIDA}" -U -p ${pid} -e "Java.perform(()=>{Java.scheduleOnMainThread(()=>{Java.use('android.webkit.WebView').setWebContentsDebuggingEnabled(true);})})"`;
            try {
              exec(fridaCmd);
              await new Promise(r => setTimeout(r, 6000));
            } catch(e) {
              console.log('[CDP Setup] Frida injection failed, trying port forward anyway...');
            }

            console.log("[CDP Setup] Forwarding ADB port 9222...");
            await execAsync(`"${ADB}" forward tcp:9222 localabstract:webview_devtools_remote_${pid}`);

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
            await execAsync(`"${ADB}" shell input tap ${x} ${y}`);
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
            await execAsync(`"${ADB}" shell input keyevent ${key}`);
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
            await execAsync(`"${ADB}" shell uiautomator dump /data/local/tmp/window_dump.xml`);
            const { stdout } = await execAsync(`"${ADB}" shell cat /data/local/tmp/window_dump.xml`);
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
            await execAsync(`"${ADB}" shell monkey -p ${appPackage} -c android.intent.category.LAUNCHER 1`);
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
                exec(`"${ADB}" shell monkey -p ${appPackage} -c android.intent.category.LAUNCHER 1`);
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