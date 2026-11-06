import type { LogEntry } from './types';

export const MAX_LOG_ENTRIES = 500;

export function appendLogEntry(previous: LogEntry[], entry: LogEntry, maxEntries: number = MAX_LOG_ENTRIES): LogEntry[] {
  if (maxEntries <= 0) return [];
  if (previous.length < maxEntries) return [...previous, entry];
  return [...previous.slice(previous.length - maxEntries + 1), entry];
}
