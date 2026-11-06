import type { Point, ScreenSize, UiNode } from './types';
import { deriveScreenSize, findCloseButton, nodeContainsPoint } from './xml';

export function parseWmSize(output: string): ScreenSize {
  const override = /Override size:\s*(\d+)x(\d+)/i.exec(output);
  if (override) {
    return { width: Number(override[1]), height: Number(override[2]), source: 'override' };
  }

  const physical = /Physical size:\s*(\d+)x(\d+)/i.exec(output);
  if (physical) {
    return { width: Number(physical[1]), height: Number(physical[2]), source: 'physical' };
  }

  return { width: 0, height: 0, source: 'unknown' };
}

export interface ExitTap extends Point {
  derivedFrom: 'close-button' | 'screen-center';
  target: string;
}

export const EXIT_TAP_HEIGHT_RATIO = 0.54;

export function resolveExitTap(nodes: UiNode[], screen: ScreenSize): ExitTap {
  const effective = screen.width > 0 && screen.height > 0 ? screen : deriveScreenSize(nodes);
  const close = findCloseButton(nodes, effective);

  if (close) {
    return {
      x: close.centerX,
      y: close.centerY,
      derivedFrom: 'close-button',
      target: `${close.text || close.desc || close.resourceId || close.shortClass}`,
    };
  }

  if (effective.width > 0 && effective.height > 0) {
    return {
      x: Math.round(effective.width / 2),
      y: Math.round(effective.height * EXIT_TAP_HEIGHT_RATIO),
      derivedFrom: 'screen-center',
      target: `${effective.width}x${effective.height}`,
    };
  }

  return { x: 541, y: 1036, derivedFrom: 'screen-center', target: 'default' };
}

export function screenCenter(screen: ScreenSize): Point {
  return screen.width > 0 && screen.height > 0
    ? { x: Math.round(screen.width / 2), y: Math.round(screen.height / 2) }
    : { x: 0, y: 0 };
}

export { nodeContainsPoint };
