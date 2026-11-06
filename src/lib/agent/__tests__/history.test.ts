import { describe, expect, it } from 'vitest';
import {
  countSteps,
  DEFAULT_HISTORY_WINDOW_STEPS,
  pruneHistory,
  pushAssistant,
  pushToolResult,
  pushUser,
  toChatMessages,
} from '@/lib/agent/history';
import type { ChatMessage } from '@/lib/agent/types';

describe('conversation history', () => {
  it('keeps tool calls on assistant messages even when content is empty', () => {
    const history: ChatMessage[] = [];
    pushAssistant(history, {
      content: null,
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'submit_android_action', arguments: '{"action":"tap"}' },
        },
      ],
    });

    expect(history[0]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'submit_android_action', arguments: '{"action":"tap"}' },
        },
      ],
    });
    expect(toChatMessages(history)[0].tool_calls).toHaveLength(1);
  });

  it('turns whitespace-only content into null so providers accept it', () => {
    const history: ChatMessage[] = [];
    pushAssistant(history, { content: '   ' });
    expect(history[0].content).toBeNull();
  });

  it('links tool results back to the assistant tool call id', () => {
    const history: ChatMessage[] = [];
    pushAssistant(history, { content: 'thinking' });
    pushToolResult(history, 'call_1', '{"ok":true}');

    expect(history[1]).toEqual({
      role: 'tool',
      tool_call_id: 'call_1',
      content: '{"ok":true}',
    });
    expect(toChatMessages(history)[1].tool_call_id).toBe('call_1');
  });

  it('prunes on user-step boundaries so tool exchanges are never orphaned', () => {
    const history: ChatMessage[] = [];
    for (let step = 0; step < 12; step++) {
      pushUser(history, `screen ${step}`);
      pushAssistant(history, {
        content: null,
        tool_calls: [
          {
            id: `call_${step}`,
            type: 'function',
            function: { name: 'submit_android_action', arguments: '{"action":"wait"}' },
          },
        ],
      });
      pushToolResult(history, `call_${step}`, '{"ok":true}');
    }

    const pruned = pruneHistory(history, DEFAULT_HISTORY_WINDOW_STEPS);

    expect(countSteps(pruned)).toBe(DEFAULT_HISTORY_WINDOW_STEPS);
    expect(pruned[0]).toEqual({ role: 'user', content: 'screen 4' });
    expect(pruned.every(message => message.role !== 'tool' || message.tool_call_id)).toBe(true);
    expect(history).toHaveLength(36);
  });

  it('leaves history untouched when it already fits', () => {
    const history: ChatMessage[] = [{ role: 'user', content: 'one' }];
    expect(pruneHistory(history, 8)).toBe(history);
  });
});
