import { fnv1aHash, parseUiNodes } from './xml';
import type { UiNode } from './types';

export const MAX_DIFF_LABELS = 10;

function signatureFor(nodes: UiNode[]): string {
  const stable = nodes
    .map(node => [
      node.shortClass,
      node.text,
      node.desc,
      node.resourceId,
      node.clickable,
      node.checked,
      node.selected,
      node.enabled,
    ].join('|'))
    .join('\n');
  return fnv1aHash(stable);
}

function labelsFor(nodes: UiNode[]): Set<string> {
  const labels = new Set<string>();
  for (const node of nodes) {
    const label = `${node.text} ${node.desc}`.trim() || node.resourceId;
    if (label) labels.add(label);
  }
  return labels;
}

export interface ScreenDiff {
  changed: boolean;
  beforeSignature: string;
  afterSignature: string;
  addedLabels: string[];
  removedLabels: string[];
  nodeCountDelta: number;
}

export function interactiveSignature(rawXml: string): string {
  return signatureFor(parseUiNodes(rawXml));
}

export function diffScreen(beforeXml: string, afterXml: string, maxLabels = MAX_DIFF_LABELS): ScreenDiff {
  const beforeNodes = parseUiNodes(beforeXml);
  const afterNodes = parseUiNodes(afterXml);
  const beforeSignature = signatureFor(beforeNodes);
  const afterSignature = signatureFor(afterNodes);
  const beforeLabels = labelsFor(beforeNodes);
  const afterLabels = labelsFor(afterNodes);

  return {
    changed: beforeSignature !== afterSignature,
    beforeSignature,
    afterSignature,
    addedLabels: Array.from(afterLabels).filter(label => !beforeLabels.has(label)).slice(0, maxLabels),
    removedLabels: Array.from(beforeLabels).filter(label => !afterLabels.has(label)).slice(0, maxLabels),
    nodeCountDelta: afterNodes.length - beforeNodes.length,
  };
}
