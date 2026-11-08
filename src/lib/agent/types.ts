export interface LogEntry {
  id: string;
  time: string;
  type: 'info' | 'action' | 'success' | 'error' | 'debug';
  message: string;
}

export interface AdbDevice {
  serial: string;
  state: string;
  details: string;
}

export type ActionType = 'tap' | 'type' | 'evaluate' | 'wait' | 'done';

export interface AgentAction {
  observation: string;
  action: ActionType;
  x?: number;
  y?: number;
  text?: string;
  script?: string;
  reason: string;
}

export interface UiNode {
  index: number;
  className: string;
  shortClass: string;
  text: string;
  desc: string;
  resourceId: string;
  bounds: string;
  clickable: boolean;
  longClickable: boolean;
  scrollable: boolean;
  checkable: boolean;
  checked: boolean;
  selected: boolean;
  enabled: boolean;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  centerX: number;
  centerY: number;
}

export interface ScreenSize {
  width: number;
  height: number;
  source: 'override' | 'physical' | 'xml' | 'unknown';
}

export interface Point {
  x: number;
  y: number;
}

export interface ChatToolCall {
  id: string;
  type: 'function' | string;
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  name?: string;
}
