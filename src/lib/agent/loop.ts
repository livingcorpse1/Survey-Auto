import type { AgentAction } from './types';

export const LOOP_SCREEN_REPEAT_LIMIT = 3;
export const LOOP_HASH_OCCURRENCE_LIMIT = 3;
export const LOOP_ACTION_REPEAT_LIMIT = 2;
export const LOOP_HISTORY_WINDOW = 8;

export interface LoopState {
  lastScreenHash: string | null;
  screenRepeat: number;
  lastActionKey: string | null;
  actionRepeat: number;
  recentHashes: string[];
}

export interface LoopResult {
  state: LoopState;
  loop: boolean;
  reason: 'repeated-action' | 'unchanged-screen' | 'revisited-screen' | null;
}

export function createLoopState(): LoopState {
  return {
    lastScreenHash: null,
    screenRepeat: 0,
    lastActionKey: null,
    actionRepeat: 0,
    recentHashes: [],
  };
}

export function actionKey(action: Pick<AgentAction, 'action' | 'x' | 'y' | 'script' | 'text'>): string {
  if (action.action === 'tap') return `tap:${action.x},${action.y}`;
  if (action.action === 'type') return `type:${action.text ?? ''}`;
  if (action.action === 'evaluate') return `evaluate:${(action.script || '').replace(/\s+/g, ' ').trim()}`;
  return action.action;
}

export function updateLoopState(state: LoopState, screenHash: string, key: string): LoopResult {
  const screenRepeat = state.lastScreenHash === screenHash ? state.screenRepeat + 1 : 1;
  const actionRepeat = state.lastActionKey === key ? state.actionRepeat + 1 : 1;

  const recentHashes = [...state.recentHashes, screenHash].slice(-LOOP_HISTORY_WINDOW);
  const occurrences = recentHashes.filter(hash => hash === screenHash).length;

  let reason: LoopResult['reason'] = null;
  if (actionRepeat >= LOOP_ACTION_REPEAT_LIMIT) reason = 'repeated-action';
  else if (screenRepeat >= LOOP_SCREEN_REPEAT_LIMIT) reason = 'unchanged-screen';
  else if (occurrences >= LOOP_HASH_OCCURRENCE_LIMIT) reason = 'revisited-screen';

  return {
    state: {
      lastScreenHash: screenHash,
      screenRepeat,
      lastActionKey: key,
      actionRepeat,
      recentHashes,
    },
    loop: reason !== null,
    reason,
  };
}
