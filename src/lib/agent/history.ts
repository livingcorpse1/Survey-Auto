import type { ChatMessage, ChatToolCall } from './types';
import { redactText } from './redact';

export const DEFAULT_HISTORY_WINDOW_STEPS = 8;

export function pushUser(history: ChatMessage[], content: string): void {
  history.push({ role: 'user', content: redactText(content) });
}

export function pushAssistant(
  history: ChatMessage[],
  message: { content?: string | null; tool_calls?: ChatToolCall[] },
): void {
  const content = typeof message.content === 'string' && message.content.trim() !== '' ? redactText(message.content) : null;
  const entry: ChatMessage = { role: 'assistant', content };
  if (message.tool_calls && message.tool_calls.length > 0) entry.tool_calls = message.tool_calls;
  history.push(entry);
}

export function pushToolResult(history: ChatMessage[], toolCallId: string, content: string): void {
  history.push({ role: 'tool', tool_call_id: toolCallId, content: redactText(content) });
}

export function countSteps(history: ChatMessage[]): number {
  return history.reduce((count, message) => count + (message.role === 'user' ? 1 : 0), 0);
}

export function pruneHistory(history: ChatMessage[], maxSteps: number = DEFAULT_HISTORY_WINDOW_STEPS): ChatMessage[] {
  if (maxSteps <= 0) return [];
  const userIndices: number[] = [];
  history.forEach((message, index) => {
    if (message.role === 'user') userIndices.push(index);
  });
  if (userIndices.length <= maxSteps) return history;
  const keepFrom = userIndices[userIndices.length - maxSteps];
  return history.slice(keepFrom);
}

export function toChatMessages(history: ChatMessage[]): ChatMessage[] {
  return history.map(message => {
    const mapped: ChatMessage = { role: message.role, content: message.content };
    if (message.tool_calls) mapped.tool_calls = message.tool_calls;
    if (message.tool_call_id) mapped.tool_call_id = message.tool_call_id;
    if (message.name) mapped.name = message.name;
    return mapped;
  });
}
