import { describe, expect, it } from 'vitest';
import { EXIT_TAP_HEIGHT_RATIO, parseWmSize, resolveExitTap } from '@/lib/agent/screen';
import { parseUiNodes } from '@/lib/agent/xml';

describe('parseWmSize', () => {
  it('prefers the override size when the device reports one', () => {
    const output = 'Physical size: 1080x2400\nOverride size: 720x1600\n';
    expect(parseWmSize(output)).toEqual({ width: 720, height: 1600, source: 'override' });
  });

  it('falls back to the physical size', () => {
    expect(parseWmSize('Physical size: 1440x3120\n')).toEqual({
      width: 1440,
      height: 3120,
      source: 'physical',
    });
  });

  it('reports unknown instead of guessing', () => {
    expect(parseWmSize('adb: device offline')).toEqual({ width: 0, height: 0, source: 'unknown' });
  });
});

describe('resolveExitTap', () => {
  it('taps the XML close control when one is present', () => {
    const nodes = parseUiNodes(
      '<node text="Close" bounds="[900,100][1000,200]" clickable="true" />',
    );

    const tap = resolveExitTap(nodes, { width: 1080, height: 2400, source: 'override' });

    expect(tap).toMatchObject({ x: 950, y: 150, derivedFrom: 'close-button', target: 'Close' });
  });

  it('derives the fallback tap from the real screen size instead of fixed pixels', () => {
    const screen = { width: 1080, height: 2400, source: 'override' as const };
    const tap = resolveExitTap([], screen);

    expect(tap).toEqual({
      x: 540,
      y: Math.round(2400 * EXIT_TAP_HEIGHT_RATIO),
      derivedFrom: 'screen-center',
      target: '1080x2400',
    });
    expect(tap.y).not.toBe(1036);
  });

  it('derives the screen size from XML when wm size is unavailable', () => {
    const nodes = parseUiNodes('<node text="Root" bounds="[0,0][720,1600]" />');
    const tap = resolveExitTap(nodes, { width: 0, height: 0, source: 'unknown' });

    expect(tap.derivedFrom).toBe('screen-center');
    expect(tap).toMatchObject({ x: 360, y: Math.round(1600 * EXIT_TAP_HEIGHT_RATIO) });
  });

  it('keeps a documented last-resort default', () => {
    expect(resolveExitTap([], { width: 0, height: 0, source: 'unknown' })).toMatchObject({
      x: 541,
      y: 1036,
      target: 'default',
    });
  });
});
