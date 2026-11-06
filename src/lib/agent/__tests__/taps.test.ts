import { describe, expect, it } from 'vitest';
import { shouldAutoTapNext } from '@/lib/agent/taps';
import { parseUiNodes } from '@/lib/agent/xml';

const nextButton = parseUiNodes(
  '<node text="Next" bounds="[300,900][780,1000]" clickable="true" />',
)[0];

describe('shouldAutoTapNext', () => {
  it('does not double-tap when the model already tapped the Next control', () => {
    expect(shouldAutoTapNext({ x: 540, y: 950 }, nextButton)).toBe(false);
  });

  it('allows the helper tap when the model tapped somewhere else', () => {
    expect(shouldAutoTapNext({ x: 540, y: 300 }, nextButton)).toBe(true);
  });

  it('respects the tolerance boundary', () => {
    expect(shouldAutoTapNext({ x: 300, y: 900 }, nextButton, 4)).toBe(false);
    expect(shouldAutoTapNext({ x: 295, y: 900 }, nextButton, 4)).toBe(true);
  });

  it('never auto-taps when no Next control exists', () => {
    expect(shouldAutoTapNext({ x: 10, y: 10 }, null)).toBe(false);
  });
});
