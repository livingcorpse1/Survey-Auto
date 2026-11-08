import type { ScreenSize, UiNode } from './types';

export const DEFAULT_MAX_INTERACTIVE_NODES = 200;

const NEXT_LABEL = /^(next|submit|continue|suivant|weiter|siguiente|volgende|próximo|próxima|次へ|다음|dale)$/i;
const NEXT_LABEL_LOOSE = /(?:^|\b)(next|submit|continue|suivant|weiter|siguiente|volgende|próximo|próxima|次へ|다음)(?:\b|$)/i;

function decodeXmlEntities(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower === 'amp') return '&';
    if (lower === 'lt') return '<';
    if (lower === 'gt') return '>';
    if (lower === 'quot') return '"';
    if (lower === 'apos') return "'";
    if (lower.startsWith('#x')) return String.fromCodePoint(parseInt(lower.slice(2), 16));
    if (lower.startsWith('#')) return String.fromCodePoint(parseInt(lower.slice(1), 10));
    return match;
  });
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function parseAttributes(raw: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const matcher = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(raw)) !== null) {
    attributes[match[1]] = decodeXmlEntities(match[2]);
  }
  return attributes;
}

export function parseBounds(bounds: string): { x1: number; y1: number; x2: number; y2: number } | null {
  const match = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(bounds.trim());
  if (!match) return null;
  return {
    x1: Number(match[1]),
    y1: Number(match[2]),
    x2: Number(match[3]),
    y2: Number(match[4]),
  };
}

export function parseUiNodes(rawXml: string): UiNode[] {
  const nodes: UiNode[] = [];
  const nodeMatcher = /<node\b([^>]*)>/g;
  let match: RegExpExecArray | null;
  let index = 0;

  while ((match = nodeMatcher.exec(rawXml)) !== null) {
    const attrs = parseAttributes(match[1]);
    const bounds = attrs.bounds || '';
    const parsedBounds = parseBounds(bounds);
    if (!parsedBounds) continue;

    const className = attrs.class || '';
    const text = (attrs.text || '').trim();
    const desc = (attrs['content-desc'] || '').trim();
    const resourceId = attrs['resource-id'] || '';
    const centerX = Math.floor((parsedBounds.x1 + parsedBounds.x2) / 2);
    const centerY = Math.floor((parsedBounds.y1 + parsedBounds.y2) / 2);

    nodes.push({
      index: index++,
      className,
      shortClass: className.split('.').pop() || className,
      text,
      desc,
      resourceId,
      bounds,
      clickable: attrs.clickable === 'true',
      longClickable: attrs['long-clickable'] === 'true',
      scrollable: attrs.scrollable === 'true',
      checkable: attrs.checkable === 'true',
      checked: attrs.checked === 'true',
      selected: attrs.selected === 'true',
      enabled: attrs.enabled !== 'false',
      x1: parsedBounds.x1,
      y1: parsedBounds.y1,
      x2: parsedBounds.x2,
      y2: parsedBounds.y2,
      centerX,
      centerY,
    });
  }

  return nodes;
}

export function isActionableNode(node: UiNode): boolean {
  return node.clickable || node.longClickable || node.scrollable || node.checkable;
}

export function hasLabel(node: UiNode): boolean {
  return node.text.length > 0 || node.desc.length > 0;
}

export function isInteractiveNode(node: UiNode): boolean {
  return isActionableNode(node) || hasLabel(node);
}

export function formatNode(node: UiNode): string {
  const bits: string[] = [`<${node.shortClass} bounds="${node.bounds}"`];
  if (node.text) bits.push(`text="${escapeAttribute(node.text)}"`);
  if (node.desc) bits.push(`desc="${escapeAttribute(node.desc)}"`);
  if (node.resourceId) bits.push(`id="${escapeAttribute(node.resourceId)}"`);
  if (node.clickable) bits.push('clickable="true"');
  if (node.checked) bits.push('checked="true"');
  if (node.scrollable) bits.push('scrollable="true"');
  const center = ` center=(${node.centerX},${node.centerY})`;
  return `${bits.join(' ')}${center} />`;
}

export function selectNodesForPrompt(nodes: UiNode[], maxNodes: number = DEFAULT_MAX_INTERACTIVE_NODES): UiNode[] {
  if (maxNodes <= 0) return [];
  const actionable: UiNode[] = [];
  const labelled: UiNode[] = [];

  for (const node of nodes) {
    if (isActionableNode(node)) actionable.push(node);
    else if (hasLabel(node)) labelled.push(node);
  }

  if (actionable.length >= maxNodes) return actionable.slice(0, maxNodes);

  const remaining = maxNodes - actionable.length;
  return [...actionable, ...labelled.slice(0, remaining)].sort((a, b) => a.index - b.index);
}

export function deriveScreenSize(nodes: UiNode[]): ScreenSize {
  let width = 0;
  let height = 0;
  for (const node of nodes) {
    if (node.x2 > width) width = node.x2;
    if (node.y2 > height) height = node.y2;
  }
  return width > 0 && height > 0
    ? { width, height, source: 'xml' }
    : { width: 0, height: 0, source: 'unknown' };
}

export function formatNodesForPrompt(nodes: UiNode[]): string {
  return nodes.map(formatNode).join('\n');
}

export interface NativeContext {
  text: string;
  totalCount: number;
  shownCount: number;
  screen: ScreenSize;
  fingerprint: string;
}

export function buildNativeContext(rawXml: string, options: { maxNodes?: number } = {}): NativeContext {
  const nodes = parseUiNodes(rawXml);
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_INTERACTIVE_NODES;
  const selected = selectNodesForPrompt(nodes, maxNodes);
  return {
    text: formatNodesForPrompt(selected),
    totalCount: nodes.length,
    shownCount: selected.length,
    screen: deriveScreenSize(nodes),
    fingerprint: screenFingerprint(nodes),
  };
}

export function isNextLabel(value: string): boolean {
  return NEXT_LABEL.test(value.trim()) || NEXT_LABEL_LOOSE.test(value.trim());
}

export function findNextButton(nodes: UiNode[]): UiNode | null {
  const candidates = nodes.filter(node => {
    if (!isNextLabel(`${node.text} ${node.desc}`.trim())) return false;
    return node.enabled;
  });
  if (candidates.length === 0) return null;
  return candidates.reduce((best, node) => {
    if (node.centerX <= 0 || node.centerY <= 0) return best;
    return node.centerY > best.centerY ? node : best;
  }, candidates[0]);
}

const CLOSE_LABEL = /^(close|dismiss|cancel|exit|no,?\s*thanks|not\s*now|x|×|✕|✖)$/i;
const CLOSE_RESOURCE = /(close|dismiss|cancel|exit)/i;

export function findCloseButton(nodes: UiNode[], screen?: ScreenSize): UiNode | null {
  const matches = nodes.filter(node => {
    if (!node.clickable) return false;
    const label = `${node.text} ${node.desc}`.trim();
    return CLOSE_LABEL.test(label) || CLOSE_RESOURCE.test(node.resourceId);
  });

  if (matches.length === 0) return null;

  if (screen && screen.width > 0 && screen.height > 0) {
    const topRight = matches.filter(node => node.centerX > screen.width * 0.55 && node.centerY < screen.height * 0.4);
    if (topRight.length > 0) {
      return topRight.reduce((best, node) => (node.centerX > best.centerX ? node : best), topRight[0]);
    }
  }

  return matches[0];
}

export function nodeContainsPoint(node: UiNode, x: number, y: number, tolerance = 0): boolean {
  return x >= node.x1 - tolerance && x <= node.x2 + tolerance && y >= node.y1 - tolerance && y <= node.y2 + tolerance;
}

export function fnv1aHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function screenFingerprint(nodes: UiNode[]): string {
  const stable = nodes
    .filter(isInteractiveNode)
    .map(node => [node.shortClass, node.text, node.desc, node.resourceId, node.checked, node.selected].join('|'))
    .join('\n');
  return fnv1aHash(stable);
}
