import { describe, expect, it } from 'vitest';
import { appendLogEntry, MAX_LOG_ENTRIES } from '@/lib/agent/logs';
import type { LogEntry } from '@/lib/agent/types';

function entry(index: number): LogEntry {
  return { id: String(index), time: '00:00:00', type: 'info', message: `line ${index}` };
}

describe('appendLogEntry', () => {
  it('caps retained log entries', () => {
    let logs: LogEntry[] = [];
    for (let index = 0; index < MAX_LOG_ENTRIES + 25; index++) {
      logs = appendLogEntry(logs, entry(index));
    }

    expect(logs).toHaveLength(MAX_LOG_ENTRIES);
    expect(logs[0].message).toBe('line 25');
    expect(logs[logs.length - 1].message).toBe(`line ${MAX_LOG_ENTRIES + 24}`);
  });

  it('does not cap below the requested maximum', () => {
    let logs: LogEntry[] = [];
    for (let index = 0; index < 10; index++) logs = appendLogEntry(logs, entry(index), 5);
    expect(logs.map(item => item.message)).toEqual(['line 5', 'line 6', 'line 7', 'line 8', 'line 9']);
  });
});
