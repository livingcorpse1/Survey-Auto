import { describe, expect, it } from 'vitest';
import { actionKey, createLoopState, updateLoopState } from '@/lib/agent/loop';

describe('loop detection', () => {
  it('keys tap and evaluate actions by their observable payload', () => {
    expect(actionKey({ action: 'tap', x: 10, y: 20 })).toBe('tap:10,20');
    expect(actionKey({ action: 'evaluate', script: '  a();\n b(); ' })).toBe('evaluate:a(); b();');
    expect(actionKey({ action: 'wait' })).toBe('wait');
  });

  it('flags the same tap twice even when the screen hash is unchanged', () => {
    let state = createLoopState();
    const first = updateLoopState(state, 'hash-a', actionKey({ action: 'tap', x: 10, y: 20 }));
    expect(first.loop).toBe(false);
    state = first.state;

    const second = updateLoopState(state, 'hash-b', actionKey({ action: 'tap', x: 10, y: 20 }));
    expect(second.loop).toBe(true);
    expect(second.reason).toBe('repeated-action');
  });

  it('flags a screen that stays identical for three observations', () => {
    let state = createLoopState();
    for (let index = 0; index < 2; index++) {
      const result = updateLoopState(state, 'same-screen', `wait-${index}`);
      expect(result.loop).toBe(false);
      state = result.state;
    }

    const third = updateLoopState(state, 'same-screen', 'wait-final');
    expect(third.loop).toBe(true);
    expect(third.reason).toBe('unchanged-screen');
  });

  it('flags a screen revisited inside the rolling window', () => {
    let state = createLoopState();
    const hashes = ['a', 'b', 'a', 'c', 'a'];

    let last = updateLoopState(state, hashes[0], 'wait-0');
    state = last.state;
    for (let index = 1; index < hashes.length; index++) {
      last = updateLoopState(state, hashes[index], `wait-${index}`);
      state = last.state;
      if (index < hashes.length - 1) expect(last.loop).toBe(false);
    }

    expect(last.loop).toBe(true);
    expect(last.reason).toBe('revisited-screen');
  });

  it('does not flag a genuinely progressing session', () => {
    let state = createLoopState();
    for (let index = 0; index < 10; index++) {
      const result = updateLoopState(state, `screen-${index}`, `tap-${index}`);
      expect(result.loop).toBe(false);
      state = result.state;
    }
  });
});
