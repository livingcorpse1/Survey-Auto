import type { Point, UiNode } from './types';
import { nodeContainsPoint } from './xml';

export function nodeCenter(node: UiNode): Point {
  return { x: node.centerX, y: node.centerY };
}

export function isTapOnNode(point: Point, node: UiNode | null, tolerance = 4): boolean {
  if (!node) return false;
  return nodeContainsPoint(node, point.x, point.y, tolerance);
}

export function shouldAutoTapNext(tapPoint: Point, nextButton: UiNode | null, tolerance = 4): boolean {
  if (!nextButton) return false;
  return !isTapOnNode(tapPoint, nextButton, tolerance);
}
