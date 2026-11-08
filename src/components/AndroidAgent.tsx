import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Bot, Play, Square, Loader2, Target, Activity, Code2, DollarSign, CheckCircle, XCircle, AlertTriangle, Smartphone, Copy } from 'lucide-react';
import { showSuccess, showError } from '@/utils/toast';
import { cn } from '@/lib/utils';
import type { AdbDevice, AgentAction, ChatMessage, LogEntry, ScreenSize, UiNode } from '@/lib/agent/types';
import { appendLogEntry } from '@/lib/agent/logs';
import { abortableFetch, isAbortError, sleep, throwIfAborted } from '@/lib/agent/abort';
import { buildNativeContext, deriveScreenSize, findNextButton, fnv1aHash, parseUiNodes } from '@/lib/agent/xml';
import { parseWmSize, resolveExitTap, findTopLeftBackButton } from '@/lib/agent/screen';
import { actionKey, createLoopState, updateLoopState } from '@/lib/agent/loop';
import { shouldAutoTapNext } from '@/lib/agent/taps';
import { buildSystemPrompt, getPlaybook } from '@/lib/agent/playbooks';
import {
  DEFAULT_HISTORY_WINDOW_STEPS,
  pruneHistory,
  pushAssistant,
  pushToolResult,
  pushUser,
  toChatMessages,
} from '@/lib/agent/history';

const APPS = [
  { name: 'AttaPoll', package: 'com.requapp.requ' },
  { name: '5Surveys', package: 'com.fivesurveys.mobile' },
];

export const AndroidAgent = () => {
  const [appPackage, setAppPackage] = useState(APPS[0].package);
  const [adbDevices, setAdbDevices] = useState<AdbDevice[]>([]);
  const [selectedDevice, setSelectedDevice] = useState('');
  const [bluestacksAddress, setBluestacksAddress] = useState('127.0.0.1:5555');
  const [deviceStatus, setDeviceStatus] = useState('Looking for Android devices...');
  const [isConnecting, setIsConnecting] = useState(false);
  const [openRouterModel, setOpenRouterModel] = useState('nvidia/nemotron-3-ultra-550b-a55b:free');
  const [openRouterConfigured, setOpenRouterConfigured] = useState(false);
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
  const abortControllerRef = useRef<AbortController | null>(null);
  const screenSizeRef = useRef<ScreenSize | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const savedPkg = localStorage.getItem('agent_package');
    if (savedPkg) setAppPackage(savedPkg);
  }, []);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const addLog = (type: LogEntry['type'], message: string) => {
    setLogs(prev => appendLogEntry(prev, {
      id: Math.random().toString(36).substring(7),
      time: new Date().toLocaleTimeString(),
      type,
      message
    }));
  };

  const refreshAdbDevices = useCallback(async () => {
    try {
      const res = await fetch('/api/adb-devices');
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Could not list Android devices.');
      setAdbDevices(data.devices || []);
      if (data.selectedSerial) setSelectedDevice(data.selectedSerial);
      const onlineCount = (data.devices || []).filter((device: AdbDevice) => device.state === 'device').length;
      setDeviceStatus(onlineCount ? `${onlineCount} Android device${onlineCount === 1 ? '' : 's'} online` : 'No online Android device. Enable ADB in BlueStacks or connect a phone.');
    } catch (error: any) {
      setDeviceStatus(`ADB unavailable: ${error.message}`);
    }
  }, []);

  const refreshOpenRouterStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/openrouter/status');
      const data = await res.json();
      setOpenRouterConfigured(Boolean(data.configured));
      if (data.model) setOpenRouterModel(data.model);
    } catch {
      setOpenRouterConfigured(false);
    }
  }, []);

  const selectAdbDevice = async (serial: string) => {
    setSelectedDevice(serial);
    if (!serial) return;
    try {
      const res = await fetch('/api/adb-select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serial }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Could not select device.');
      setSelectedDevice(data.selectedSerial);
      setDeviceStatus(`Using ${data.selectedSerial}`);
    } catch (error: any) {
      setDeviceStatus(error.message);
    }
  };

  const connectBlueStacks = async () => {
    setIsConnecting(true);
    try {
      const res = await fetch('/api/adb-connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: bluestacksAddress.trim() }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Could not connect to BlueStacks.');
      setSelectedDevice(data.selectedSerial);
      setDeviceStatus(`Connected to BlueStacks at ${data.selectedSerial}`);
      await refreshAdbDevices();
    } catch (error: any) {
      setDeviceStatus(error.message);
    } finally {
      setIsConnecting(false);
    }
  };

  useEffect(() => {
    void refreshAdbDevices();
  }, [refreshAdbDevices]);

  useEffect(() => {
    void refreshOpenRouterStatus();
  }, [refreshOpenRouterStatus]);

  const copyLiveContext = () => {
    navigator.clipboard.writeText(pageText);
    showSuccess('Live context copied to clipboard');
  };

  const copyLogs = () => {
    const logsText = logs.map(l => `[${l.time}] ${l.type.toUpperCase()}: ${l.message}`).join('\n');
    navigator.clipboard.writeText(logsText || 'No logs available');
    showSuccess('Execution logs copied to clipboard');
  };

  const executeCDP = async (url: string, script: string, signal?: AbortSignal) => {
    const res = await abortableFetch('/api/cdp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wsUrl: url, script }),
    }, signal);
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    return data.result?.value;
  };

  const postJson = async (path: string, body: unknown, signal?: AbortSignal) => {
    const res = await abortableFetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    }, signal);
    const data = await res.json();
    if (!data.success) throw new Error(data.error || `${path} failed`);
    return data;
  };

  const dumpXml = async (signal?: AbortSignal) => {
    const data = await postJson('/api/dump-xml', {}, signal);
    return typeof data.xml === 'string' ? data.xml : '';
  };

  const tap = (x: number, y: number, signal?: AbortSignal) => postJson('/api/adb-tap', { x, y }, signal);

  const typeText = (text: string, signal?: AbortSignal) => postJson('/api/adb-type-text', { text }, signal);

  const sendBack = (signal?: AbortSignal) => postJson('/api/adb-keyevent', { key: 4 }, signal);

  const refreshScreenSize = async (signal?: AbortSignal) => {
    try {
      const res = await abortableFetch('/api/screen-size', { method: 'GET' }, signal);
      const data = await res.json();
      if (data.success && typeof data.size === 'string') {
        const parsed = parseWmSize(data.size);
        if (parsed.width > 0 && parsed.height > 0) {
          screenSizeRef.current = parsed;
          addLog('debug', `Screen size: ${parsed.width}x${parsed.height} (${parsed.source})`);
        }
      }
    } catch (error) {
      if (isAbortError(error)) throw error;
      addLog('debug', `Could not read wm size: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const runAgentLoop = async () => {
    if (!goal.trim()) {
      showError('Goal is required.');
      return;
    }

    const controller = new AbortController();
    const signal = controller.signal;
    abortControllerRef.current = controller;

    try {
      const aiStatusRes = await abortableFetch('/api/openrouter/status', { method: 'GET' }, signal);
      const aiStatus = await aiStatusRes.json();
      if (!aiStatus.configured) throw new Error('Set OPENROUTER_API_KEY in .env and restart SurveyPilot.');
      setOpenRouterConfigured(true);
      if (aiStatus.model) setOpenRouterModel(aiStatus.model);

      const deviceData = await postJson('/api/adb-select', { serial: selectedDevice }, signal);
      if (deviceData.selectedSerial) setSelectedDevice(deviceData.selectedSerial);
    } catch (error: any) {
      abortControllerRef.current = null;
      if (!isAbortError(error)) showError(error.message);
      return;
    }

    setIsRunning(true);
    isRunningRef.current = true;
    wsUrlRef.current = wsUrl;

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCostUsd = 0;
    let conversationHistory: ChatMessage[] = [];
    let cdpRetryCount = 0;
    let surveysCompletedThisRun = 0;
    let consecutiveFailures = 0;
    let loopStrikes = 0;
    let loopState = createLoopState();
    let webModeStartTime: number | null = null;

    const appName = APPS.find(a => a.package === appPackage)?.name || appPackage;
    const playbook = getPlaybook(appPackage);
    const systemPrompt = buildSystemPrompt(playbook);
    addLog('info', `Starting Hybrid Agent Loop... (App: ${appName}, Max Spend: $${maxCost}, Goal: ${surveyGoal} surveys)`);

    const resetConversation = () => {
      conversationHistory = [];
      loopState = createLoopState();
      loopStrikes = 0;
      consecutiveFailures = 0;
    };

    const forceBackToList = async (message: string) => {
      addLog('info', message);
      try {
        await postJson('/api/launch-app', { appPackage }, signal);
        await sleep(1500, signal);
      } catch (error) {
        if (isAbortError(error)) throw error;
        addLog('error', `Failed to relaunch app: ${error instanceof Error ? error.message : String(error)}`);
      }
      wsUrlRef.current = null;
      setWsUrl(null);
      webModeStartTime = null;
      resetConversation();
      await sleep(1500, signal);
    };

    const exitSurvey = async (message: string) => {
      addLog('info', message);
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          await sendBack(signal);
          await sleep(1200, signal);
          const nodes = parseUiNodes(await dumpXml(signal));
          if (!nodes.some(node => node.text.includes('Why are you leaving') || node.desc.includes('Why are you leaving'))) break;
          const back = findTopLeftBackButton(nodes);
          if (!back) break;
          addLog('debug', `Back target: ${back.text || back.resourceId || back.shortClass} -> ${back.centerX}, ${back.centerY}`);
          await tap(back.centerX, back.centerY, signal);
          await sleep(1200, signal);
        }
        const nodes = parseUiNodes(await dumpXml(signal));
        const fallbackScreen = deriveScreenSize(nodes);
        const screen = screenSizeRef.current && screenSizeRef.current.width > 0
          ? screenSizeRef.current
          : fallbackScreen;
        if ((!screenSizeRef.current || screenSizeRef.current.width === 0) && screen.width > 0) {
          screenSizeRef.current = screen;
        }
        const target = resolveExitTap(nodes, screen);
        addLog('debug', `Exit target: ${target.derivedFrom} (${target.target}) -> ${target.x}, ${target.y}`);
        await tap(target.x, target.y, signal);
        addLog('info', 'Confirmed survey exit.');
      } catch (error) {
        if (isAbortError(error)) throw error;
        addLog('error', `Failed to exit survey: ${error instanceof Error ? error.message : String(error)}`);
      }
      wsUrlRef.current = null;
      setWsUrl(null);
      webModeStartTime = null;
      resetConversation();
      await sleep(1500, signal);
    };

    try {
      addLog('info', `Launching ${appName} (${appPackage})...`);
      await postJson('/api/launch-app', { appPackage }, signal);
      addLog('info', 'Waiting 3s for app to load...');
      await sleep(3000, signal);
      await refreshScreenSize(signal);

      const actionTools = [{
        type: 'function',
        function: {
          name: 'submit_android_action',
          description: 'Return exactly one action for the current Android or WebView screen.',
          parameters: {
            type: 'object',
            properties: {
              observation: { type: 'string', description: 'Brief description of the visible screen and target.' },
              action: { type: 'string', enum: ['tap', 'type', 'evaluate', 'wait', 'done'] },
              x: { type: 'integer', description: 'Tap x coordinate for native mode.' },
              y: { type: 'integer', description: 'Tap y coordinate for native mode.' },
              text: { type: 'string', description: 'Text to type for action "type" (e.g. an age number).' },
              script: { type: 'string', description: 'JavaScript to evaluate in WebView mode.' },
              reason: { type: 'string', description: 'Why this action is appropriate.' },
            },
            required: ['observation', 'action', 'reason'],
            additionalProperties: false,
          },
        },
      }];

      while (isRunningRef.current && !signal.aborted) {
        throwIfAborted(signal);
        addLog('info', 'Analyzing current screen state (XML Dump)...');

        let rawXml = '';
        try {
          rawXml = await dumpXml(signal);
        } catch (error) {
          if (isAbortError(error)) throw error;
          addLog('error', `XML Dump failed: ${error instanceof Error ? error.message : String(error)}`);
        }

        const isAppOpen = rawXml.includes(`package="${appPackage}"`);
        if (!isAppOpen && rawXml.length > 200) {
          addLog('error', `${appName} closed! Relaunching...`);
          setStats(prev => ({ ...prev, cdpCrashes: prev.cdpCrashes + 1 }));
          await postJson('/api/launch-app', { appPackage }, signal);
          wsUrlRef.current = null;
          setWsUrl(null);
          webModeStartTime = null;
          resetConversation();
          await sleep(3000, signal);
          await refreshScreenSize(signal);
          continue;
        }

        addLog('debug', `XML length: ${rawXml.length} | Has <node: ${rawXml.includes('<node')}`);

        const hasWebView = rawXml.includes('class="android.webkit.WebView"');
        const hasRealElements = rawXml.length > 200 && rawXml.includes('<node');
        const mode = !hasRealElements && hasWebView ? 'WEB' : 'NATIVE';
        addLog('info', `Detected Mode: ${mode}`);

        let userText = '';
        let fingerprint = '';

        if (mode === 'NATIVE') {
          webModeStartTime = null;
          if (wsUrlRef.current) {
            addLog('debug', 'Resetting CDP connection cache (switched back to NATIVE).');
            wsUrlRef.current = null;
            setWsUrl(null);
          }

          const context = buildNativeContext(rawXml);
          if ((!screenSizeRef.current || screenSizeRef.current.width === 0) && context.screen.width > 0) {
            screenSizeRef.current = context.screen;
          }
          const screen = screenSizeRef.current ?? context.screen;
          fingerprint = context.fingerprint;
          setPageText(`// NATIVE UI DETECTED\n\nScreen: ${screen.width}x${screen.height}\n\n${context.text}`);
          userText = `Current Mode: NATIVE\nGoal: ${goal}\nScreen: ${screen.width}x${screen.height}\n\nInteractive UI nodes (${context.shownCount}/${context.totalCount} shown):\n${context.text}\n\nAnalyze the bounds and return the exact center x,y to tap.`;
        } else {
          if (!webModeStartTime) webModeStartTime = Date.now();

          if (!wsUrlRef.current) {
            addLog('info', 'Setting up CDP Connection for WebView...');
            try {
              const cdpData = await postJson('/api/setup-cdp', { appPackage }, signal);
              wsUrlRef.current = cdpData.wsUrl;
              setWsUrl(cdpData.wsUrl);
              cdpRetryCount = 0;
              addLog('success', 'CDP Connection Established!');
            } catch (error) {
              if (isAbortError(error)) throw error;
              cdpRetryCount++;
              if (cdpRetryCount >= 1) {
                addLog('error', `CDP unavailable (${error instanceof Error ? error.message : String(error)}); continuing in native XML mode.`);
                setStats(prev => ({ ...prev, cdpFailed: prev.cdpFailed + 1 }));
                wsUrlRef.current = null;
                setWsUrl(null);
                const context = buildNativeContext(rawXml);
                const screen = screenSizeRef.current ?? context.screen;
                fingerprint = context.fingerprint;
                setPageText(`// NATIVE UI DETECTED (CDP unavailable, falling back)\n\nScreen: ${screen.width}x${screen.height}\n\n${context.text}`);
                userText = `Current Mode: NATIVE (CDP unavailable, answer via taps/type)\nGoal: ${goal}\nScreen: ${screen.width}x${screen.height}\n\nInteractive UI nodes (${context.shownCount}/${context.totalCount} shown):\n${context.text}\n\nTap answer buttons; for text fields use action type with x,y and the text to type.`;
              }
              addLog('error', `CDP Setup Failed (Attempt ${cdpRetryCount}/3): ${error instanceof Error ? error.message : String(error)}`);
              await sleep(3000, signal);
              if (!userText) continue;
            }
          }

          addLog('info', 'Extracting live DOM context via CDP...');
          try {
            const domQuery = `(() => {
              const html = document.body ? document.body.outerHTML : document.documentElement.outerHTML;
              return JSON.stringify({
                text: document.body ? document.body.innerText : '',
                html: html || ''
              });
            })()`;
            const rawState = await executeCDP(wsUrlRef.current!, domQuery, signal);
            const pageState = JSON.parse(rawState);
            fingerprint = fnv1aHash(`${pageState.text}\n${pageState.html || ''}`);

            if (pageState.text.trim().length < 50 && (pageState.html || '').includes('ps-loader')) {
              addLog('info', 'Survey stuck on loading — skipping.');
              setStats(prev => ({ ...prev, screenedOut: prev.screenedOut + 1 }));
              await exitSurvey('Skipping survey stuck on loading.');
              continue;
            }

            const webModeElapsed = Date.now() - (webModeStartTime ?? Date.now());
            if (webModeElapsed > 30000) {
              addLog('info', 'Page loading timeout — skipping survey.');
              await exitSurvey('Skipping survey after a page loading timeout.');
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
              const captchaKeywords = ["captcha", "i'm not a robot", "verify you are human", "recaptcha", "are you a robot"];
              const isCaptcha = captchaKeywords.includes(matchedKeyword);
              addLog('info', isCaptcha ? 'Captcha detected — skipping survey' : 'Survey screen-out detected. Going back to survey list...');
              await exitSurvey('Returning to the survey list after a screen-out.');
              continue;
            }

            const hardPlatforms = ['nfieldmr.com', 'nfield-interviewing'];
            if (hardPlatforms.some(p => (pageState.html || '').toLowerCase().includes(p.toLowerCase()))) {
              addLog('info', 'Complex survey platform detected — skipping.');
              setStats(prev => ({ ...prev, screenedOut: prev.screenedOut + 1 }));
              await exitSurvey('Returning to the survey list from an unsupported platform.');
              continue;
            }

            const hardUIKeywords = ['select-scroll-slide', 'keen-slider', 'swiper-slide', 'ps-select-scroll', 'ps-captcha'];
            if (hardUIKeywords.some(k => (pageState.html || '').toLowerCase().includes(k))) {
              addLog('info', 'Complex slider/picker UI detected — skipping survey.');
              setStats(prev => ({ ...prev, screenedOut: prev.screenedOut + 1 }));
              await exitSurvey('Returning to the survey list from a complex slider/picker UI.');
              continue;
            }

            setPageText(`// WEB VIEW DETECTED\n\n${pageState.text}\n\n// HTML PREVIEW (for UI only)\n${(pageState.html || '').substring(0, 4000)}...`);
            const htmlLimit = appPackage === 'com.fivesurveys.mobile' ? 30000 : (pageState.html || '').length;
            userText = `Current Mode: WEB\nGoal: ${goal}\n\nPAGE TEXT:\n${pageState.text}\n\nPAGE HTML:\n${(pageState.html || '').substring(0, htmlLimit)}\n\nAnalyze the DOM and provide JavaScript to interact with it.`;
          } catch (error) {
            if (isAbortError(error)) throw error;
            addLog('error', `CDP Context Error: ${error instanceof Error ? error.message : String(error)}. Dropping connection cache.`);
            wsUrlRef.current = null;
            setWsUrl(null);
            continue;
          }
        }

        addLog('info', `Sending context to ${openRouterModel} via OpenRouter...`);
        pushUser(conversationHistory, userText);
        conversationHistory = pruneHistory(conversationHistory, DEFAULT_HISTORY_WINDOW_STEPS);

        const useTools = !/crouton-alpha/i.test(openRouterModel);
        const responseRes = await abortableFetch('/api/openrouter/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            system: systemPrompt,
            max_tokens: 4096,
            ...(useTools ? {
              tools: actionTools,
              tool_choice: { type: 'function', function: { name: 'submit_android_action' } },
            } : {}),
            messages: toChatMessages(conversationHistory),
          }),
        }, signal);
        const response = await responseRes.json();
        if (!responseRes.ok || !response.success) {
          throw new Error(response.error?.message || response.error || `OpenRouter request failed (${responseRes.status}).`);
        }

        if (response.usage) {
          totalInputTokens += response.usage.prompt_tokens || 0;
          totalOutputTokens += response.usage.completion_tokens || 0;
          totalCostUsd += Number(response.usage.cost) || 0;

          if (totalCostUsd >= parseFloat(maxCost)) {
            addLog('error', `Cost limit $${maxCost} reached! Stopping agent.`);
            isRunningRef.current = false;
            break;
          }
        }

        const choice = response.choices?.[0];
        const assistantMessage = choice?.message;
        const messageContent = assistantMessage?.content;
        const responseText = typeof messageContent === 'string'
          ? messageContent
          : Array.isArray(messageContent)
            ? messageContent.map((part: { text?: string }) => part.text || '').join('\n')
            : '';
        const assistantToolCalls = assistantMessage?.tool_calls;
        pushAssistant(conversationHistory, { content: responseText, tool_calls: assistantToolCalls });

        let action: AgentAction | undefined;
        const respondToTools = (ok: boolean, detail: string) => {
          for (const call of assistantToolCalls ?? []) {
            const payload = call.function?.name === 'submit_android_action'
              ? JSON.stringify({ ok, action: action?.action ?? null, detail })
              : JSON.stringify({ ok: false, detail: 'Unsupported tool call.' });
            if (call?.id) pushToolResult(conversationHistory, call.id, payload);
          }
        };

        try {
          const actionCall = assistantToolCalls?.find((call: { function?: { name?: string } }) => call.function?.name === 'submit_android_action');
          if (actionCall?.function?.arguments) {
            action = typeof actionCall.function.arguments === 'string'
              ? JSON.parse(actionCall.function.arguments)
              : actionCall.function.arguments;
          } else {
            const fencedJson = responseText.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
            const firstBrace = responseText.indexOf('{');
            const lastBrace = responseText.lastIndexOf('}');
            const jsonCandidate = fencedJson || (firstBrace >= 0 && lastBrace > firstBrace
              ? responseText.slice(firstBrace, lastBrace + 1)
              : '');
            if (!jsonCandidate) throw new Error('No action tool call or JSON object found');
            action = JSON.parse(jsonCandidate);
          }
          if (!action || !['tap', 'type', 'evaluate', 'wait', 'done'].includes(action.action) || typeof action.observation !== 'string' || typeof action.reason !== 'string') {
            throw new Error('Action is missing required fields or has an unsupported action type');
          }
          if (action.action === 'tap' && (!Number.isFinite(action.x) || !Number.isFinite(action.y) || action.x < 0 || action.y < 0)) {
            throw new Error('Tap actions require non-negative numeric x and y coordinates');
          }
          if (action.action === 'type' && (
            !Number.isFinite(action.x) || !Number.isFinite(action.y) || action.x < 0 || action.y < 0
            || typeof action.text !== 'string' || action.text.length === 0 || action.text.length > 256
          )) {
            throw new Error('Type actions require non-negative numeric x and y and a text to type');
          }
          if (action.action === 'evaluate' && (typeof action.script !== 'string' || mode !== 'WEB')) {
            throw new Error('Evaluate actions require a script and WEB mode');
          }
          if (action.action === 'tap' && mode !== 'NATIVE') throw new Error('Tap actions can only be used in NATIVE mode');
          if (action.action === 'type' && mode !== 'NATIVE') throw new Error('Type actions can only be used in NATIVE mode');
          consecutiveFailures = 0;
        } catch (error) {
          const detail = choice?.finish_reason === 'length'
            ? 'Response hit the token limit before returning an action'
            : error instanceof Error ? error.message : 'Unknown action parse error';
          const preview = responseText.replace(/\s+/g, ' ').slice(0, 180);
          addLog('error', `Invalid model action (${choice?.finish_reason || 'no finish reason'}): ${detail}${preview ? ` · Reply: ${preview}` : ' · No text content'} `);
          respondToTools(false, detail);
          consecutiveFailures++;
          if (consecutiveFailures >= 3) {
            addLog('error', 'Stopping after 3 invalid model actions. Check the provider response details before retrying.');
            showError('The model returned invalid actions 3 times. The agent was stopped; check the log for response details.');
            isRunningRef.current = false;
            break;
          }
          await sleep(2000, signal);
          continue;
        }

        addLog('info', `Observation: ${action.observation}`);

        let actionStr = `Action: ${action.action}`;
        if (action.action === 'evaluate') actionStr += ` (Executing JS: ${action.script})`;
        if (action.action === 'tap') actionStr += ` (Tapping at: ${action.x}, ${action.y})`;
        if (action.action === 'type') actionStr += ` (Typing at: ${action.x}, ${action.y})`;
        if (action.action === 'wait') actionStr += ` (Waiting for changes)`;
        actionStr += ` (Reason: ${action.reason})`;
        addLog('action', actionStr);

        const loopResult = updateLoopState(loopState, fingerprint, actionKey(action));
        loopState = loopResult.state;

        if (action.action === 'done') {
          if (surveysCompletedThisRun === 0) {
            addLog('error', `Agent reported done without completing any survey (under 5 min available, only a long one visible).`);
            showError('Agent finished without completing any survey — only a too-long survey was visible. Check the 5-minute playbook limit or wait for shorter surveys.');
            isRunningRef.current = false;
            break;
          }
          surveysCompletedThisRun++;
          setStats(prev => ({ ...prev, completed: prev.completed + 1 }));
          addLog('success', `Survey ${surveysCompletedThisRun}/${surveyGoal} completed!`);
          respondToTools(true, 'Survey completed.');

          if (surveysCompletedThisRun >= parseInt(surveyGoal)) {
            addLog('success', `Survey goal of ${surveyGoal} reached! Stopping agent.`);
            showSuccess(`Goal reached! Completed ${surveyGoal} surveys.`);
            break;
          }

          resetConversation();
          wsUrlRef.current = null;
          setWsUrl(null);
          webModeStartTime = null;
          await sleep(2000, signal);
          continue;
        }

        let actionFailed = false;
        let actionDetail = '';

        if (loopResult.loop) {
          loopStrikes++;
          actionFailed = true;
          actionDetail = `Loop detected: ${loopResult.reason}`;
          addLog('error', `Loop detected (${loopResult.reason}, strike ${loopStrikes}) for screen ${fingerprint}.`);
          if (loopStrikes >= 2) {
            respondToTools(false, actionDetail);
            await forceBackToList('Repeated loop detected — forcing back to the survey list.');
            continue;
          }
        } else {
          loopStrikes = 0;
        }

        if (!actionFailed) {
          if (action.action === 'evaluate' && action.script && mode === 'WEB') {
            addLog('info', 'Injecting script via WebSocket...');
            try {
              await executeCDP(wsUrlRef.current!, action.script, signal);
              consecutiveFailures = 0;
              webModeStartTime = null;
              actionDetail = 'Script executed.';
            } catch (error) {
              if (isAbortError(error)) throw error;
              addLog('error', `Script execution failed: ${error instanceof Error ? error.message : String(error)}`);
              actionFailed = true;
              actionDetail = 'Script execution failed.';
            }
          } else if (action.action === 'tap' && action.x !== undefined && action.y !== undefined && mode === 'NATIVE') {
            const tapPoint = { x: action.x, y: action.y };
            addLog('info', `Sending ADB Tap to ${tapPoint.x}, ${tapPoint.y}...`);
            try {
              await tap(tapPoint.x, tapPoint.y, signal);
              await sleep(500, signal);

              let nextNodes: UiNode[] = [];
              try {
                nextNodes = parseUiNodes(await dumpXml(signal));
              } catch (error) {
                if (isAbortError(error)) throw error;
              }
              const nextButton = findNextButton(nextNodes);

              if (nextButton && shouldAutoTapNext(tapPoint, nextButton)) {
                addLog('info', `Auto-clicking ${nextButton.text || nextButton.desc} at ${nextButton.centerX}, ${nextButton.centerY}`);
                await tap(nextButton.centerX, nextButton.centerY, signal);
                actionDetail = `Tapped and then pressed ${nextButton.text || nextButton.desc}.`;
              } else if (nextButton) {
                addLog('debug', 'Skipping auto-Next because the tap already targeted the Next control.');
                actionDetail = 'Tap already targeted the Next control; auto-tap guarded.';
              } else {
                actionDetail = 'Tap sent; no Next control found yet.';
              }

              consecutiveFailures = 0;
            } catch (error) {
              if (isAbortError(error)) throw error;
              addLog('error', `ADB Tap failed: ${error instanceof Error ? error.message : String(error)}`);
              actionFailed = true;
              actionDetail = 'ADB tap failed.';
            }
          } else if (action.action === 'type' && action.x !== undefined && action.y !== undefined && action.text && mode === 'NATIVE') {
            const fieldPoint = { x: action.x, y: action.y };
            addLog('info', `Focusing field at ${fieldPoint.x}, ${fieldPoint.y} and typing...`);
            try {
              await tap(fieldPoint.x, fieldPoint.y, signal);
              await sleep(600, signal);
              await typeText(action.text, signal);
              await sleep(500, signal);

              let nextNodes: UiNode[] = [];
              try {
                const nextXml = await dumpXml(signal);
                nextNodes = parseUiNodes(nextXml);
              } catch (error) {
                if (isAbortError(error)) throw error;
              }
              const nextButton = findNextButton(nextNodes);
              if (nextButton) {
                addLog('info', `Auto-clicking Next at ${nextButton.centerX}, ${nextButton.centerY} after typing.`);
                await tap(nextButton.centerX, nextButton.centerY, signal);
                actionDetail = `Typed "${action.text}" and pressed Next.`;
              } else {
                actionDetail = `Typed "${action.text}"; no Next control found yet.`;
              }
              consecutiveFailures = 0;
            } catch (error) {
              if (isAbortError(error)) throw error;
              addLog('error', `Typing failed: ${error instanceof Error ? error.message : String(error)}`);
              actionFailed = true;
              actionDetail = 'Typing failed.';
            }
          } else if (action.action === 'wait') {
            consecutiveFailures = 0;
            actionDetail = 'Waited for the UI to settle.';
          }
        }

        if (actionFailed) {
          respondToTools(false, actionDetail || 'Action failed.');
          consecutiveFailures++;
          if (consecutiveFailures >= 3) {
            addLog('error', 'Stuck on current survey (3 failures) — going back to survey list.');
            await exitSurvey('Stuck on the current survey — returning to the survey list.');
            continue;
          }
        } else {
          respondToTools(true, actionDetail || 'Action sent.');
        }

        const waitTime = mode === 'WEB' ? 5000 : 3000;
        addLog('info', `Waiting for UI to settle (${waitTime / 1000}s)...`);
        await sleep(waitTime, signal);
      }
    } catch (error) {
      if (isAbortError(error)) {
        addLog('info', 'Agent stopped.');
      } else {
        console.error(error);
        addLog('error', `Agent crashed: ${error instanceof Error ? error.message : String(error)}`);
        showError('Agent encountered an error. Check logs.');
      }
    } finally {
      if (totalInputTokens > 0 || totalOutputTokens > 0) {
        addLog('success', `Session complete! Tokens: ${totalInputTokens} in / ${totalOutputTokens} out — Cost: $${totalCostUsd.toFixed(4)}`);
      }
      setIsRunning(false);
      isRunningRef.current = false;
      if (abortControllerRef.current === controller) abortControllerRef.current = null;
    }
  };

  const stopAgent = () => {
    isRunningRef.current = false;
    abortControllerRef.current?.abort();
    addLog('info', 'Stop requested. Aborting in-flight work immediately...');
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
              <label className="text-sm font-semibold text-gray-700 dark:text-gray-300">AI Provider and Model</label>
              <div className="px-4 py-2.5 bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 rounded-xl text-sm font-medium">
                {openRouterModel}
              </div>
              <p className={`text-xs ${openRouterConfigured ? 'text-emerald-600' : 'text-red-500'}`}>
                {openRouterConfigured ? 'API key loaded from the local .env file' : 'Set OPENROUTER_API_KEY in .env and restart'}
              </p>
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
              <Smartphone size={16} className="text-orange-500" /> Android Device
            </label>
            <div className="flex flex-col sm:flex-row gap-2">
              <select
                value={selectedDevice}
                onChange={(e) => void selectAdbDevice(e.target.value)}
                className="flex-1 min-w-0 px-4 py-2.5 bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 rounded-xl outline-none focus:ring-2 focus:ring-orange-500/20 focus:border-orange-500 text-sm"
              >
                <option value="">Select connected device</option>
                {adbDevices.map(device => (
                  <option key={device.serial} value={device.serial} disabled={device.state !== 'device'}>
                    {device.serial} · {device.state}{device.details ? ` · ${device.details}` : ''}
                  </option>
                ))}
              </select>
              <button type="button" onClick={() => void refreshAdbDevices()} className="px-4 py-2.5 border border-gray-200 dark:border-gray-700 rounded-xl text-sm font-semibold">
                Refresh
              </button>
            </div>
            <div className="flex flex-col sm:flex-row gap-2">
              <input
                type="text"
                value={bluestacksAddress}
                onChange={(e) => setBluestacksAddress(e.target.value)}
                placeholder="127.0.0.1:5555"
                aria-label="BlueStacks ADB address"
                className="flex-1 min-w-0 px-4 py-2.5 bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 rounded-xl outline-none focus:ring-2 focus:ring-orange-500/20 focus:border-orange-500 font-mono text-sm"
              />
              <button type="button" onClick={() => void connectBlueStacks()} disabled={isConnecting} className="px-4 py-2.5 bg-orange-500 hover:bg-orange-600 disabled:bg-orange-300 text-white rounded-xl text-sm font-semibold">
                {isConnecting ? 'Connecting…' : 'Connect BlueStacks'}
              </button>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400">Enable Android Debug Bridge in BlueStacks settings and use the port shown there. {deviceStatus}</p>
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
