import { describe, expect, it } from 'vitest';
import { diffScreen, interactiveSignature } from '@/lib/agent/verify';

function node(attrs: string) {
  return `<node ${attrs} />`;
}

const FIRST_SCREEN = [
  node('class="android.widget.TextView" text="Survey question" bounds="[0,0][100,50]"'),
  node('class="android.widget.Button" text="Next" clickable="true" bounds="[0,100][100,150]"'),
].join('');

const SAME_SCREEN = [
  node('class="android.widget.TextView" text="Survey question" bounds="[0,0][100,50]"'),
  node('class="android.widget.Button" text="Next" clickable="true" bounds="[0,100][100,150]"'),
].join('');

const NEXT_SCREEN = [
  node('class="android.widget.TextView" text="Survey question" bounds="[0,0][100,50]"'),
  node('class="android.widget.Button" text="Next" clickable="true" bounds="[0,100][100,150]"'),
  node('class="android.widget.TextView" text="How often do you shop?" bounds="[0,200][100,260]"'),
].join('');

describe('screen verification helpers', () => {
  it('produces the same signature for identical screens', () => {
    expect(interactiveSignature(FIRST_SCREEN)).toBe(interactiveSignature(SAME_SCREEN));
  });

  it('reports no change for identical XML', () => {
    const diff = diffScreen(FIRST_SCREEN, SAME_SCREEN);
    expect(diff.changed).toBe(false);
    expect(diff.addedLabels).toEqual([]);
    expect(diff.removedLabels).toEqual([]);
    expect(diff.nodeCountDelta).toBe(0);
  });

  it('detects new labels and node counts', () => {
    const diff = diffScreen(FIRST_SCREEN, NEXT_SCREEN);
    expect(diff.changed).toBe(true);
    expect(diff.addedLabels).toEqual(['How often do you shop?']);
    expect(diff.removedLabels).toEqual([]);
    expect(diff.nodeCountDelta).toBe(1);
  });

  it('detects checkbox and selection changes without new labels', () => {
    const unchecked = node('class="android.widget.CheckBox" text="Yes" checkable="true" checked="false" bounds="[0,0][100,50]"');
    const checked = node('class="android.widget.CheckBox" text="Yes" checkable="true" checked="true" bounds="[0,0][100,50]"');
    expect(diffScreen(unchecked, checked).changed).toBe(true);
    expect(diffScreen(unchecked, checked).addedLabels).toEqual([]);
  });

  it('detects removed labels when leaving a screen', () => {
    const diff = diffScreen(NEXT_SCREEN, FIRST_SCREEN);
    expect(diff.changed).toBe(true);
    expect(diff.removedLabels).toEqual(['How often do you shop?']);
    expect(diff.nodeCountDelta).toBe(-1);
  });

  it('treats empty or malformed XML as an empty screen', () => {
    expect(diffScreen('', '').changed).toBe(false);
    expect(diffScreen('', FIRST_SCREEN).changed).toBe(true);
    expect(diffScreen('<hierarchy></hierarchy>', FIRST_SCREEN).changed).toBe(true);
  });

  it('caps the returned label lists', () => {
    const before = node('class="android.widget.TextView" text="A" bounds="[0,0][10,10]"');
    const after = Array.from({ length: 30 }, (_, i) =>
      node(`class="android.widget.TextView" text="item-${i}" bounds="[0,${i}][10,${i + 10}]"`)).join('');
    expect(diffScreen(before, after, 5).addedLabels).toHaveLength(5);
  });
});
