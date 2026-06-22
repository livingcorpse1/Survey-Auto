import React, { useState, useEffect, useRef } from 'react';
import Anthropic from '@anthropic-ai/sdk';
import { Bot, Play, Square, Loader2, Target, Activity, Code2, FolderOpen, DollarSign, CheckCircle, XCircle, AlertTriangle, Smartphone, Copy } from 'lucide-react';
import { showSuccess, showError } from '@/utils/toast';
import { cn } from '@/lib/utils';

interface LogEntry {
  id: string;
  time: string;
  type: 'info' | 'action' | 'success' | 'error' | 'debug';
  message: string;
}

const APPS = [
  { name: 'AttaPoll', package: 'com.requapp.requ' },
  { name: '5Surveys', package: 'com.fivesurveys.mobile' },
];

export const AndroidAgent = () => {
  const [apiKey, setApiKey] = useState('');
  const [scrcpyDir, setScrcpyDir] = useState('C:\\path\\to\\scrcpy');
  const [appPackage, setAppPackage] = useState(APPS[0].package);
  const [goal, setGoal] = useState('Complete as many surveys as possible for maximum profit. After each survey (completed or screened out), return to the survey list and start the next best one immediately. Never stop unless there are no surveys available.');
  const [maxCost, setMaxCost] = useState('0.50');
  const [surveyGoal, setSurveyGoal] = useState('5');
  
  const [isRunning, setIsRunning] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [stats, setStats] = useState({ completed: 0, screenedOut: 0, cdpFailed: 0, cdpCrashes: 0 });
  
  const [wsUrl, setWsUrl] = useState<string | null>(null);
  const [pageText, setPageText] = useState<string>('Press Start Agent to begin analysis...');
  
  const isRunningRef = useRef(false);
  const wsUrlRef = useRef<string | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const savedKey = localStorage.getItem('anthropic_api_key');
    if (savedKey) setApiKey(savedKey);
    const savedDir = localStorage.getItem('scrcpy_directory');
    if (savedDir) setScrcpyDir(savedDir);
    const savedPkg = localStorage.getItem('agent_package');
    if (savedPkg) setAppPackage(savedPkg);
  }, []);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const addLog = (type: LogEntry['type'], message: string) => {
    setLogs(prev => [...prev, {
      id: Math.random().toString(36).substring(7),
      time: new Date().toLocaleTimeString(),
      type,
      message
    }]);
  };

  const copyLiveContext = () => {
    navigator.clipboard.writeText(pageText);
    showSuccess('Live context copied to clipboard');
  };

  const copyLogs = () => {
    const logsText = logs.map(l => `[${l.time}] ${l.type.toUpperCase()}: ${l.message}`).join('\n');
    navigator.clipboard.writeText(logsText || 'No logs available');
    showSuccess('Execution logs copied to clipboard');
  };

  const executeCDP = async (url: string, script: string) => {
    const res = await fetch('/api/cdp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wsUrl: url, script }),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    return data.result?.value;
  };

  const simplifyXml = (rawXml: string) => {
    try {
      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(rawXml, "text/xml");
      const nodes = Array.from(xmlDoc.getElementsByTagName('node'));
      
      const simplified = nodes
        .filter(n => n.getAttribute('clickable') === 'true' || (n.getAttribute('text') || '').trim() !== '' || (n.getAttribute('content-desc') || '').trim() !== '')
        .map(n => {
          const clazz = (n.getAttribute('class') || '').split('.').pop();
          const text = n.getAttribute('text') || '';
          const desc = n.getAttribute('content-desc') || '';
          const bounds = n.getAttribute('bounds') || '';
          return `<${clazz} bounds="${bounds}"${text ? ` text="${text}"` : ''}${desc ? ` desc="${desc}"` : ''} />`;
        });
        
      return simplified.join('\n');
    } catch (e) {
      return rawXml;
    }
  };

  const runAgentLoop = async () => {
    if (!apiKey.trim() || !goal.trim() || !scrcpyDir.trim()) {
      showError('API Key, Goal, and Scrcpy Directory are required.');
      return;
    }

    setIsRunning(true);
    isRunningRef.current = true;
    wsUrlRef.current = wsUrl;
    
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let conversationHistory: any[] = [];
    let cdpRetryCount = 0;
    let surveysCompletedThisRun = 0;
    let consecutiveFailures = 0;
    let lastActionString = "";
    let webModeStartTime: number | null = null;
    
    const appName = APPS.find(a => a.package === appPackage)?.name || appPackage;
    addLog('info', `Starting Hybrid Agent Loop... (App: ${appName}, Max Spend: $${maxCost}, Goal: ${surveyGoal} surveys)`);
    
    try {
      addLog('info', `Launching ${appName} (${appPackage})...`);
      await fetch('/api/launch-app', { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appPackage }) 
      });
      addLog('info', 'Waiting 3s for app to load...');
      await new Promise(r => setTimeout(r, 3000));

      const anthropic = new Anthropic({
        apiKey: apiKey,
        dangerouslyAllowBrowser: true,
      });

      const systemPrompt = `You are a hybrid automated agent controlling an Android device. You dynamically switch between NATIVE MODE and WEB MODE based on the provided context.

If provided with UI XML, you are in NATIVE MODE:
- Analyze the simplified UI XML to find the element that progresses the goal.
- To click an element, calculate the center (x, y) of its bounds="[x1,y1][x2,y2]" and provide the exact x and y coordinates.
- After selecting a multiple choice answer, ALWAYS tap the Next button in the same action sequence. If you see a Next button in the XML, tap the answer first, then on the very next action tap Next — never leave a question without tapping Next.
- Also: if you see a screen with 'Sorry that didn't work out', tap the X/close button (top right corner) to return to the survey list.
- JSON Format:
{
  "observation": "what you see and what element you target",
  "action": "tap" | "wait" | "done",
  "x": 123,
  "y": 456,
  "reason": "why you are tapping here"
}

If provided with DOM Text and HTML, you are in WEB MODE:
- Analyze the page text and exact HTML to find precise selectors.
- Write robust JavaScript to interact with the DOM using exact IDs or classes when possible (e.g., document.querySelector('#choice-0').click()).
- Before clicking any element, verify its selector exists in the HTML provided. If you cannot find the exact selector in the HTML, use document.querySelector and check what elements are actually present.
- When filling inputs or selecting options, always find the submit/next button by examining the actual HTML provided. Look for buttons with type='submit', or buttons containing text like 'Next', 'Continue', 'Submit', 'Suivant'. Use the exact selector from the HTML. Never hardcode button selectors — always derive them from the page HTML.
- Also use unique variable names in every script (add a random suffix like _12345) to avoid redeclaration errors.
- JSON Format:
{
  "observation": "what you see and what element you target",
  "action": "evaluate" | "wait" | "done",
  "script": "document.querySelector('button.submit').click();",
  "reason": "why you are executing this script"
}

General Rules:
- SURVEY SELECTION RULE: Always pick the fastest survey available (lowest minutes). Fast surveys are simpler, have lower screen-out risk, and keep the loop moving. If two surveys have the same time, pick the higher paying one. Never pick surveys over 5 minutes. For 5Surveys, since time is not shown, pick surveys with the lowest star rating (1-2 stars) as they tend to be shorter and simpler.
- CRITICAL PROGRESSION RULE: Once you have tapped on a survey and entered it (you can tell because the XML shows survey questions instead of a survey list), you have ALREADY found and selected the correct survey. DO NOT go back. Your ONLY job at that point is to answer the questions and tap Submit. Never go back to the survey list once inside a survey unless the survey is finished or shows an error.
- QUALIFICATION QUESTIONS: When you see a qualification popup with answer options visible in the PAGE TEXT, click immediately using innerText matching — do NOT use children.length === 0 as a filter since options have child elements. Use this pattern:
  Array.from(document.querySelectorAll('label, li, div, span')).find(el => el.innerText && el.innerText.trim() === 'EXACT_OPTION_TEXT')?.click();
  Then immediately click the Next button after selecting.
  Always pick the most neutral answer (e.g. 'None of the above', 'No', 'I do not consume alcohol', 'I don\\'t read newspapers or magazines').
  NOTE: The above qualification question rule applies specifically to 5Surveys. For 5Surveys qualification popups, use innerText matching without children.length filtering:
  Array.from(document.querySelectorAll('label, li, div, span')).find(el => el.innerText && el.innerText.trim() === 'I don\\'t read newspapers or magazines')?.click();
- CRITICAL: When filling a textarea or input, ALWAYS click the Next button in the same script immediately after filling. Never split fill and click into separate steps.
- When filling any input field, always trigger focus BEFORE setting value and blur AFTER, in addition to input and change events:
  var input = document.getElementById('myInput');
  input.focus();
  input.value = 'text';
  input.dispatchEvent(new Event('input', {bubbles: true}));
  input.dispatchEvent(new Event('change', {bubbles: true}));
  input.blur();
  document.querySelector('button.next-button').click();
  This is required for React and Next.js forms to recognize the input as valid and enable the submit button.
- For Quest Mindshare surveys (you can tell by 'css-175oi2r' classes in the HTML), use the native input setter to trigger React state:
  var nativeSetter_xyz = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  nativeSetter_xyz.call(input_xyz, 'your answer here');
  input_xyz.dispatchEvent(new Event('input', {bubbles: true}));
- IMPORTANT: IDs that start with numbers are not valid CSS selectors. Never use querySelector('#0') or querySelector('#1'). Instead use: document.getElementById('0').click()
- If you see a dialog asking why you are leaving early, tap Lost interest to confirm the exit.
- If you need to wait for a loading screen or network request, use action: "wait".
- If the goal is completely achieved or impossible to progress further, use action: "done".
- Respond ONLY with the raw JSON object. Do not wrap in Markdown.`;

      while (isRunningRef.current) {
        addLog('info', 'Analyzing current screen state (XML Dump)...');
        
        let rawXml = '';
        try {
          const xmlRes = await fetch('/api/dump-xml', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ directory: scrcpyDir }),
          });
          const xmlData = await xmlRes.json();
          if (xmlData.success) rawXml = xmlData.xml || '';
        } catch (e: any) {
          addLog('error', `XML Dump failed: ${e.message}`);
        }

        const isAppOpen = rawXml.includes(`package="${appPackage}"`);
        if (!isAppOpen && rawXml.length > 200) {
          addLog('error', `${appName} closed! Relaunching...`);
          setStats(prev => ({ ...prev, cdpCrashes: prev.cdpCrashes + 1 }));
          
          await fetch('/api/launch-app', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ appPackage })
          });
          wsUrlRef.current = null;
          setWsUrl(null);
          webModeStartTime = null;
          await new Promise(r => setTimeout(r, 3000));
          continue;
        }

        addLog('debug', `XML length: ${rawXml.length} | Has <node: ${rawXml.includes('<node')}`);

        const hasWebView = rawXml.includes('class="android.webkit.WebView"');
        const hasRealElements = rawXml.length > 200 && rawXml.includes('<node') && !hasWebView;
        const mode = hasRealElements ? 'NATIVE' : 'WEB';
        
        addLog('info', `Detected Mode: ${mode}`);

        if (mode === 'NATIVE') {
          webModeStartTime = null;
          if (wsUrlRef.current) {
            addLog('debug', 'Resetting CDP connection cache (switched back to NATIVE).');
            wsUrlRef.current = null;
            setWsUrl(null);
          }
        }

        let userMessageContent: any[] = [];

        if (mode === 'NATIVE') {
          const simpleXml = simplifyXml(rawXml).substring(0, 2000);
          setPageText(`// NATIVE UI DETECTED\n\n${simpleXml}`);
          
          userMessageContent = [
            {
              type: "text",
              text: `Current Mode: NATIVE\nGoal: ${goal}\n\nSimplified UI XML:\n${simpleXml}\n\nAnalyze the XML bounds and provide the exact center x,y coordinates to tap.`,
            }
          ];
        } else {
          if (!webModeStartTime) webModeStartTime = Date.now();
          
          if (!wsUrlRef.current) {
            addLog('info', 'Setting up CDP Connection for WebView...');
            try {
              const cdpRes = await fetch('/api/setup-cdp', { 
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ appPackage })
              });
              const cdpData = await cdpRes.json();
              if (!cdpData.success) throw new Error(cdpData.error);
              wsUrlRef.current = cdpData.wsUrl;
              setWsUrl(cdpData.wsUrl);
              cdpRetryCount = 0;
              addLog('success', 'CDP Connection Established!');
            } catch (e: any) {
              cdpRetryCount++;
              if (cdpRetryCount >= 3) {
                addLog('error', 'CDP Setup failed 3 times. Survey may not support WebView debugging. Skipping.');
                setStats(prev => ({ ...prev, cdpFailed: prev.cdpFailed + 1 }));
                
                try {
                  await fetch('/api/adb-keyevent', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ key: 4 })
                  });
                  addLog('info', 'Sent ADB BACK command to skip survey.');
                  await new Promise(r => setTimeout(r, 2000));
                  await fetch('/api/adb-tap', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ x: 541, y: 1036 })
                  });
                  addLog('info', 'Confirmed survey exit.');
                } catch(err: any) {
                  addLog('error', `Failed to send BACK command: ${err.message}`);
                }
                cdpRetryCount = 0;
                webModeStartTime = null;
              } else {
                addLog('error', `CDP Setup Failed (Attempt ${cdpRetryCount}/3): ${e.message}`);
              }
              await new Promise(r => setTimeout(r, 3000));
              continue;
            }
          }

          addLog('info', 'Extracting live DOM context via CDP...');
          let pageState;
          try {
            const domQuery = `(() => { 
              const html = document.body ? document.body.outerHTML : document.documentElement.outerHTML;
              return JSON.stringify({ 
                text: document.body ? document.body.innerText : '', 
                html: html || ''
              }); 
            })()`;
            const rawState = await executeCDP(wsUrlRef.current, domQuery);
            pageState = JSON.parse(rawState);
            
            if (pageState.text.trim().length < 50 && (pageState.html || '').includes('ps-loader')) {
              addLog('info', 'Survey stuck on loading — skipping.');
              setStats(prev => ({ ...prev, screenedOut: prev.screenedOut + 1 }));
              await fetch('/api/adb-keyevent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 4 }) });
              await new Promise(r => setTimeout(r, 2000));
              await fetch('/api/adb-tap', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ x: 541, y: 1036 }) });
              wsUrlRef.current = null;
              setWsUrl(null);
              webModeStartTime = null;
              continue;
            }

            const webModeElapsed = Date.now() - webModeStartTime;
            if (webModeElapsed > 30000) {
              addLog('info', 'Page loading timeout — skipping survey.');
              webModeStartTime = null;
              await fetch('/api/adb-keyevent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 4 }) });
              await new Promise(r => setTimeout(r, 2000));
              await fetch('/api/adb-tap', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ x: 541, y: 1036 }) });
              wsUrlRef.current = null;
              setWsUrl(null);
              continue;
            }
            
            const screenOutKeywords = [
              "don't qualify", "do not qualify", "not eligible", "we're sorry", 
              "thank you for your interest", "unfortunately", "no longer available", "quota full",
              "captcha", "i'm not a robot", "verify you are human", "recaptcha", "are you a robot"
            ];
            
            const textLower = pageState.text.toLowerCase();
            const matchedKeyword = screenOutKeywords.find(k => textLower.includes(k));

            if (matchedKeyword) {
              setStats(prev => ({ ...prev, screenedOut: prev.screenedOut + 1 }));
              const isCaptcha = ["captcha", "i'm not a robot", "verify you are human", "recaptcha", "are you a robot"].includes(matchedKeyword);
              if (isCaptcha) {
                addLog('info', 'Captcha detected — skipping survey');
              } else {
                addLog('info', 'Survey screen-out detected. Going back to survey list...');
              }
              await fetch('/api/adb-keyevent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 4 }) });
              await new Promise(r => setTimeout(r, 2000));
              await fetch('/api/adb-tap', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ x: 541, y: 1036 }) });
              addLog('info', 'Confirmed survey exit.');
              wsUrlRef.current = null;
              setWsUrl(null);
              webModeStartTime = null;
              continue;
            }

            const hardPlatforms = ['nfieldmr.com', 'nfield-interviewing'];
            if (hardPlatforms.some(p => (pageState.html || '').toLowerCase().includes(p.toLowerCase()))) {
              addLog('info', 'Complex survey platform detected — skipping.');
              setStats(prev => ({ ...prev, screenedOut: prev.screenedOut + 1 }));
              await fetch('/api/adb-keyevent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 4 }) });
              await new Promise(r => setTimeout(r, 2000));
              await fetch('/api/adb-tap', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ x: 541, y: 1036 }) });
              addLog('info', 'Confirmed survey exit.');
              wsUrlRef.current = null;
              setWsUrl(null);
              webModeStartTime = null;
              continue;
            }

            const hardUIKeywords = ['select-scroll-slide', 'keen-slider', 'swiper-slide', 'ps-select-scroll', 'ps-captcha'];
            if (hardUIKeywords.some(k => (pageState.html || '').toLowerCase().includes(k))) {
              addLog('info', 'Complex slider/picker UI detected — skipping survey.');
              setStats(prev => ({ ...prev, screenedOut: prev.screenedOut + 1 }));
              await fetch('/api/adb-keyevent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 4 }) });
              await new Promise(r => setTimeout(r, 2000));
              await fetch('/api/adb-tap', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ x: 541, y: 1036 }) });
              addLog('info', 'Confirmed survey exit.');
              wsUrlRef.current = null;
              setWsUrl(null);
              webModeStartTime = null;
              continue;
            }
            
            setPageText(`// WEB VIEW DETECTED\n\n${pageState.text}\n\n// TRUNCATED HTML (for UI only)\n${(pageState.html || '').substring(0, 2000)}...`);
          } catch(e: any) {
            addLog('error', `CDP Context Error: ${e.message}. Dropping connection cache.`);
            wsUrlRef.current = null;
            setWsUrl(null);
            continue;
          }
          
          const htmlLimit = appPackage === 'com.fivesurveys.mobile' ? 30000 : (pageState.html || '').length;
          userMessageContent = [
            {
              type: "text",
              text: `Current Mode: WEB\nGoal: ${goal}\n\nPAGE TEXT:\n${pageState.text}\n\nPAGE HTML:\n${(pageState.html || '').substring(0, htmlLimit)}\n\nAnalyze the DOM and provide JavaScript to interact with it.`,
            }
          ];
        }

        addLog('info', `Sending context to Claude...`);
        conversationHistory.push({
          role: "user",
          content: userMessageContent,
        });

        if (conversationHistory.length > 2) {
          conversationHistory.splice(0, 2);
        }

        const response = await anthropic.messages.create({
          model: 'claude-sonnet-4-6',
          system: systemPrompt,
          max_tokens: 512,
          messages: conversationHistory,
        });
        
        if (response.usage) {
          totalInputTokens += response.usage.input_tokens;
          totalOutputTokens += response.usage.output_tokens;
          
          const currentCost = (totalInputTokens / 1_000_000) * 3.00 + (totalOutputTokens / 1_000_000) * 15.00;
          if (currentCost >= parseFloat(maxCost)) {
            addLog('error', `Cost limit $${maxCost} reached! Stopping agent.`);
            isRunningRef.current = false;
            break;
          }
        }

        const responseText = response.content.find(c => c.type === 'text')?.text || '';
        conversationHistory.push({ role: "assistant", content: responseText });

        let action;
        try {
          const startIndex = responseText.indexOf('{');
          const endIndex = responseText.lastIndexOf('}');
          if (startIndex === -1 || endIndex === -1) throw new Error("No JSON object found");
          action = JSON.parse(responseText.substring(startIndex, endIndex + 1));
        } catch (e) {
          addLog('error', `Claude returned invalid JSON. Retrying...`);
          consecutiveFailures++;
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }

        addLog('info', `Observation: ${action.observation}`);
        
        let actionStr = `Action: ${action.action}`;
        if (action.action === 'evaluate') actionStr += ` (Executing JS: ${action.script})`;
        if (action.action === 'tap') actionStr += ` (Tapping at: ${action.x}, ${action.y})`;
        if (action.action === 'wait') actionStr += ` (Waiting for changes)`;
        actionStr += ` (Reason: ${action.reason})`;
        addLog('action', actionStr);

        if (action.action === 'done') {
          surveysCompletedThisRun++;
          setStats(prev => ({ ...prev, completed: prev.completed + 1 }));
          addLog('success', `Survey ${surveysCompletedThisRun}/${surveyGoal} completed!`);
          
          if (surveysCompletedThisRun >= parseInt(surveyGoal)) {
            addLog('success', `Survey goal of ${surveyGoal} reached! Stopping agent.`);
            showSuccess(`Goal reached! Completed ${surveyGoal} surveys.`);
            break;
          }
          
          conversationHistory = [];
          wsUrlRef.current = null;
          setWsUrl(null);
          webModeStartTime = null;
          consecutiveFailures = 0;
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }

        let actionFailed = false;
        
        const currentActionString = JSON.stringify(action);
        if (currentActionString === lastActionString && action.action !== 'wait') {
          addLog('error', 'Agent repeated the exact same action as last time.');
          actionFailed = true;
        }
        lastActionString = currentActionString;

        if (!actionFailed) {
          if (action.action === 'evaluate' && action.script && mode === 'WEB') {
            addLog('info', 'Injecting script via WebSocket...');
            try {
              await executeCDP(wsUrlRef.current!, action.script);
              consecutiveFailures = 0;
              webModeStartTime = null;
              
              await new Promise(r => setTimeout(r, 300));
              try {
                await executeCDP(wsUrlRef.current!, `
                  var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
                  var inp = document.querySelector('[data-testid="question-input"]');
                  if (inp && inp.value && inp.value.length > 0 && nativeSetter) {
                    nativeSetter.call(inp, inp.value);
                    inp.dispatchEvent(new Event('input', {bubbles: true}));
                    setTimeout(() => { var btn = document.querySelector('[data-testid="submit-text"]'); if(btn) btn.click(); }, 300);
                  } else {
                    var submitBtn = document.querySelector('[data-testid="submit-text"]');
                    if (submitBtn && !submitBtn.disabled) submitBtn.click();
                  }
                `);
              } catch(e) {}
              
            } catch(e: any) {
              addLog('error', `Script execution failed: ${e.message}`);
              actionFailed = true;
            }
          } else if (action.action === 'tap' && action.x !== undefined && action.y !== undefined && mode === 'NATIVE') {
            addLog('info', `Sending ADB Tap to ${action.x}, ${action.y}...`);
            try {
              const res = await fetch('/api/adb-tap', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ x: action.x, y: action.y }),
              });
              const data = await res.json();
              if (!data.success) throw new Error(data.error);
              
              await new Promise(r => setTimeout(r, 500));
              const nextXmlRes = await fetch('/api/dump-xml', { 
                method: 'POST', 
                headers: { 'Content-Type': 'application/json' }, 
                body: JSON.stringify({ directory: scrcpyDir }) 
              });
              const nextXmlData = await nextXmlRes.json();
              
              if (nextXmlData.success) {
                const nextXml = nextXmlData.xml || '';
                const nodeMatch = nextXml.match(/<node[^>]*(?:text|content-desc)="(?:Next|Submit)"[^>]*>/i);
                if (nodeMatch) {
                  const boundsMatch = nodeMatch[0].match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
                  if (boundsMatch) {
                    const nx = Math.floor((parseInt(boundsMatch[1]) + parseInt(boundsMatch[3])) / 2);
                    const ny = Math.floor((parseInt(boundsMatch[2]) + parseInt(boundsMatch[4])) / 2);
                    addLog('info', `Auto-clicking Next/Submit at ${nx}, ${ny}`);
                    await fetch('/api/adb-tap', { 
                      method: 'POST', 
                      headers: { 'Content-Type': 'application/json' }, 
                      body: JSON.stringify({ x: nx, y: ny }) 
                    });
                  }
                }
              }

              consecutiveFailures = 0;
            } catch(e: any) {
              addLog('error', `ADB Tap failed: ${e.message}`);
              actionFailed = true;
            }
          } else if (action.action === 'wait') {
            consecutiveFailures = 0;
          }
        }

        if (actionFailed) {
          consecutiveFailures++;
          if (consecutiveFailures >= 3) {
            addLog('error', 'Stuck on current survey (3 failures) — going back to survey list.');
            try {
              await fetch('/api/adb-keyevent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 4 }) });
              await new Promise(r => setTimeout(r, 2000));
              await fetch('/api/adb-tap', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ x: 541, y: 1036 }) });
              addLog('info', 'Confirmed survey exit.');
            } catch (err) {}
            wsUrlRef.current = null;
            setWsUrl(null);
            webModeStartTime = null;
            conversationHistory = [];
            consecutiveFailures = 0;
            lastActionString = "";
            continue;
          }
        }

        const waitTime = mode === 'WEB' ? 5000 : 3000;
        addLog('info', `Waiting for UI to settle (${waitTime / 1000}s)...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    } catch (error: any) {
      console.error(error);
      addLog('error', `Agent crashed: ${error.message}`);
      showError('Agent encountered an error. Check logs.');
    } finally {
      if (totalInputTokens > 0 || totalOutputTokens > 0) {
        const inputCost = (totalInputTokens / 1_000_000) * 3.00;
        const outputCost = (totalOutputTokens / 1_000_000) * 15.00;
        addLog('success', `Session complete! Tokens: ${totalInputTokens} in / ${totalOutputTokens} out — Cost: $${(inputCost + outputCost).toFixed(4)}`);
      }
      setIsRunning(false);
      isRunningRef.current = false;
    }
  };

  const stopAgent = () => {
    isRunningRef.current = false;
    addLog('info', 'Stop requested. Finishing current cycle...');
  };

  return (
    <div className="flex flex-col w-full max-w-[1400px] mx-auto gap-6 mt-4">
      
      <div className="flex flex-col items-center text-center gap-3 mb-2">
        <div className="p-4 bg-orange-500 rounded-full text-white shadow-lg shadow-orange-500/30">
          <Bot size={32} />
        </div>
        <h2 className="text-2xl font-bold text-gray-800 dark:text-gray-100">Hybrid Autopilot</h2>
        <p className="text-gray-500 dark:text-gray-400">Dynamically switches between UI Automator Vision and CDP DOM Injection.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start h-[700px]">
        
        {/* Column 1: Config */}
        <div className="bg-white dark:bg-gray-900 rounded-3xl shadow-sm border border-gray-100 dark:border-gray-800 overflow-hidden p-6 flex flex-col gap-5 h-full">
          <div className="flex items-center gap-2 font-bold text-gray-800 dark:text-gray-200 pb-2 border-b border-gray-100 dark:border-gray-800">
            <Target size={18} className="text-orange-500" /> Mission Briefing
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-semibold text-gray-700 dark:text-gray-300">Anthropic API Key</label>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  localStorage.setItem('anthropic_api_key', e.target.value);
                }}
                className="w-full px-4 py-2.5 bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 rounded-xl outline-none focus:ring-2 focus:ring-orange-500/20 focus:border-orange-500 transition-all text-sm"
              />
            </div>
            
            <div className="space-y-2">
              <label className="text-sm font-semibold text-gray-700 dark:text-gray-300 flex items-center gap-2">
                <Smartphone size={16} className="text-orange-500" />
                Survey App
              </label>
              <select
                value={appPackage}
                onChange={(e) => {
                  setAppPackage(e.target.value);
                  localStorage.setItem('agent_package', e.target.value);
                }}
                className="w-full px-4 py-2.5 bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 rounded-xl outline-none focus:ring-2 focus:ring-orange-500/20 focus:border-orange-500 transition-all text-sm cursor-pointer"
              >
                {APPS.map(a => <option key={a.package} value={a.package}>{a.name}</option>)}
              </select>
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-semibold text-gray-700 dark:text-gray-300 flex items-center gap-2">
              <FolderOpen size={16} className="text-orange-500" />
              Scrcpy Folder Path (contains adb)
            </label>
            <input
              type="text"
              value={scrcpyDir}
              onChange={(e) => {
                setScrcpyDir(e.target.value);
                localStorage.setItem('scrcpy_directory', e.target.value);
              }}
              placeholder="C:\path\to\scrcpy"
              className="w-full px-4 py-2.5 bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 rounded-xl outline-none focus:ring-2 focus:ring-orange-500/20 focus:border-orange-500 transition-all font-mono text-sm"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-semibold text-gray-700 dark:text-gray-300 flex items-center gap-2">
                <DollarSign size={16} className="text-orange-500" />
                Max Cost ($)
              </label>
              <input
                type="number"
                step="0.10"
                value={maxCost}
                onChange={(e) => setMaxCost(e.target.value)}
                className="w-full px-4 py-2.5 bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 rounded-xl outline-none focus:ring-2 focus:ring-orange-500/20 focus:border-orange-500 transition-all text-sm"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-semibold text-gray-700 dark:text-gray-300 flex items-center gap-2">
                <Target size={16} className="text-orange-500" />
                Survey Goal
              </label>
              <input
                type="number"
                min="1"
                value={surveyGoal}
                onChange={(e) => setSurveyGoal(e.target.value)}
                className="w-full px-4 py-2.5 bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 rounded-xl outline-none focus:ring-2 focus:ring-orange-500/20 focus:border-orange-500 transition-all text-sm"
              />
            </div>
          </div>

          <div className="space-y-2 flex-1 flex flex-col">
            <label className="text-sm font-semibold text-gray-700 dark:text-gray-300">Agent Goal</label>
            <textarea
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              className="flex-1 w-full p-4 bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 rounded-xl outline-none focus:ring-2 focus:ring-orange-500/20 focus:border-orange-500 transition-all text-sm resize-none"
            />
          </div>

          <div className="flex flex-col gap-3 pt-2">
            {!isRunning ? (
              <button
                onClick={runAgentLoop}
                className="w-full flex items-center justify-center gap-2 py-4 bg-orange-500 hover:bg-orange-600 disabled:bg-orange-300 dark:disabled:bg-orange-900/50 text-white rounded-xl font-bold transition-all shadow-lg shadow-orange-500/30 disabled:shadow-none hover:scale-[1.02] active:scale-[0.98] disabled:scale-100"
              >
                <Play size={20} />
                Start Hybrid Agent
              </button>
            ) : (
              <button
                onClick={stopAgent}
                className="w-full flex items-center justify-center gap-2 py-4 bg-red-500 hover:bg-red-600 text-white rounded-xl font-bold transition-all shadow-lg shadow-red-500/30 hover:scale-[1.02] active:scale-[0.98]"
              >
                <Square size={20} />
                Stop Agent
              </button>
            )}
          </div>
        </div>

        {/* Column 2: Live View / Context */}
        <div className="bg-[#121212] rounded-3xl shadow-md border border-gray-800 overflow-hidden flex flex-col h-full relative">
          <div className="px-5 py-4 border-b border-white/10 bg-black/40 flex items-center justify-between">
            <div className="flex items-center gap-2 text-gray-200 font-semibold">
              <Code2 size={18} className="text-emerald-400" />
              Live Context
            </div>
            <div className="flex items-center gap-3">
              {wsUrl && <span className="flex h-3 w-3 rounded-full bg-emerald-500 shadow-[0_0_8px_#10b981] animate-pulse" title="WebSocket Connected"></span>}
              <button 
                onClick={copyLiveContext} 
                className="p-1.5 text-gray-400 hover:text-white rounded-md hover:bg-white/10 transition-colors" 
                title="Copy Context"
              >
                <Copy size={16} />
              </button>
            </div>
          </div>
          
          <div className="flex-1 p-5 overflow-auto custom-scrollbar font-mono text-xs sm:text-sm text-gray-300 whitespace-pre-wrap leading-relaxed">
            {pageText}
          </div>
        </div>

        {/* Column 3: Logs & Stats */}
        <div className="bg-[#1e1e1e] rounded-3xl shadow-md border border-gray-800 overflow-hidden flex flex-col h-full">
          <div className="px-5 py-4 border-b border-white/10 bg-black/20 flex justify-between items-center">
            <div className="flex items-center gap-2 text-gray-200 font-semibold">
              <Activity size={18} className="text-orange-400" />
              Execution Logs
            </div>
            <div className="flex items-center gap-3">
              {isRunning && (
                <div className="flex items-center gap-2 text-xs font-medium text-orange-400 bg-orange-400/10 px-3 py-1.5 rounded-full">
                  <Loader2 size={12} className="animate-spin" />
                  Thinking...
                </div>
              )}
              <button 
                onClick={copyLogs} 
                className="p-1.5 text-gray-400 hover:text-white rounded-md hover:bg-white/10 transition-colors" 
                title="Copy Logs"
              >
                <Copy size={16} />
              </button>
            </div>
          </div>
          
          {/* Stats Bar */}
          <div className="px-5 py-3 border-b border-white/10 bg-black/40 flex flex-wrap gap-4 text-xs font-medium">
            <div className="flex items-center gap-1.5 text-emerald-400" title="Surveys Completed">
              <CheckCircle size={14} /> {stats.completed} Completed
            </div>
            <div className="flex items-center gap-1.5 text-yellow-400" title="Survey rejected user">
              <XCircle size={14} /> {stats.screenedOut} Screened Out
            </div>
            <div className="flex items-center gap-1.5 text-purple-400" title="Failed to attach CDP">
              <XCircle size={14} /> {stats.cdpFailed} CDP Failed
            </div>
            <div className="flex items-center gap-1.5 text-red-400" title="App Crashes (Auto-recovered)">
              <AlertTriangle size={14} /> {stats.cdpCrashes} App Crashes
            </div>
          </div>

          <div className="flex-1 p-5 overflow-auto custom-scrollbar font-mono text-xs sm:text-sm flex flex-col gap-3">
            {logs.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center gap-3 text-gray-500">
                <Bot size={48} className="opacity-20" />
                <p>Logs will appear here</p>
              </div>
            ) : (
              logs.map((log) => (
                <div key={log.id} className="flex gap-3 pb-3 border-b border-white/5 last:border-0 leading-relaxed">
                  <span className="text-gray-500 shrink-0">[{log.time}]</span>
                  <span className={cn(
                    "flex-1 break-words",
                    log.type === 'info' && "text-gray-300",
                    log.type === 'action' && "text-blue-400 font-semibold whitespace-pre-wrap",
                    log.type === 'success' && "text-green-400 font-bold",
                    log.type === 'error' && "text-red-400 font-bold",
                    log.type === 'debug' && "text-yellow-400",
                  )}>
                    {log.message}
                  </span>
                </div>
              ))
            )}
            <div ref={logsEndRef} />
          </div>
        </div>

      </div>
    </div>
  );
};