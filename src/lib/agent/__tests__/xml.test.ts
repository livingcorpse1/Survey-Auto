import { describe, expect, it } from 'vitest';
import {
  buildNativeContext,
  deriveScreenSize,
  findCloseButton,
  findNextButton,
  parseBounds,
  parseUiNodes,
  screenFingerprint,
  selectNodesForPrompt,
} from '@/lib/agent/xml';

function node(attributes: string): string {
  return `<node ${attributes} />`;
}

function labelledNode(text: string, bounds = '[0,0][10,10]', extra = ''): string {
  return node(`index="0" text="${text}" bounds="${bounds}" ${extra}`);
}

describe('parseBounds', () => {
  it('parses the UI Automator bounds format', () => {
    expect(parseBounds('[10,20][110,220]')).toEqual({ x1: 10, y1: 20, x2: 110, y2: 220 });
  });

  it('rejects malformed bounds', () => {
    expect(parseBounds('10,20,110,220')).toBeNull();
    expect(parseBounds('[10,20][110]')).toBeNull();
  });
});

describe('parseUiNodes', () => {
  it('extracts geometry, flags and decoded labels', () => {
    const nodes = parseUiNodes(
      node(
        'text="Tom &amp; Jerry &quot;quoted&quot;" content-desc="Open" resource-id="app:id/open" ' +
          'class="android.widget.Button" bounds="[100,200][300,400]" clickable="true" ' +
          'scrollable="true" checked="true" enabled="true"',
      ),
    );

    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      text: 'Tom & Jerry "quoted"',
      desc: 'Open',
      resourceId: 'app:id/open',
      shortClass: 'Button',
      clickable: true,
      scrollable: true,
      checked: true,
      centerX: 200,
      centerY: 300,
    });
  });

  it('skips nodes without usable bounds', () => {
    expect(parseUiNodes(node('text="No bounds" class="android.widget.TextView"'))).toHaveLength(0);
  });
});

describe('selectNodesForPrompt', () => {
  it('prefers actionable nodes and preserves document order', () => {
    const nodes = parseUiNodes(
      [
        node('text="Heading" bounds="[0,0][100,50]"'),
        node('text="Muted" bounds="[0,50][100,100]"'),
        node('text="Continue" bounds="[0,100][100,150]" clickable="true"'),
        node('text="Other" bounds="[0,150][100,200]" clickable="true"'),
      ].join(''),
    );

    const selected = selectNodesForPrompt(nodes, 2);
    expect(selected.map(item => item.text)).toEqual(['Continue', 'Other']);
  });

  it('caps the prompt at the requested count', () => {
    const nodes = parseUiNodes(
      Array.from({ length: 40 }, (_, index) =>
        node(`text="Action ${index}" bounds="[0,${index}][100,${index + 1}]" clickable="true"`),
      ).join(''),
    );

    expect(selectNodesForPrompt(nodes, 10)).toHaveLength(10);
  });
});

describe('buildNativeContext', () => {
  it('returns every node count instead of slicing the XML at 2000 characters', () => {
    const xml = Array.from({ length: 250 }, (_, index) =>
      node(
        `text="Long interactive label ${index} ${'x'.repeat(40)}" ` +
          `bounds="[0,${index * 10}][1000,${index * 10 + 10}]" clickable="true"`,
      ),
    ).join('');

    const context = buildNativeContext(xml);

    expect(context.totalCount).toBe(250);
    expect(context.shownCount).toBe(200);
    expect(context.text.length).toBeGreaterThan(2000);
    expect(context.text).toContain('Long interactive label 0');
    expect(context.screen).toEqual({ width: 1000, height: 2500, source: 'xml' });
  });

  it('is deterministic for the same screen and changes when state changes', () => {
    const a = node('text="A" bounds="[0,0][10,10]" clickable="true"');
    const b = node('text="B" bounds="[0,0][10,10]" clickable="true"');
    const checked = node('text="B" bounds="[0,0][10,10]" clickable="true" checked="true"');

    expect(screenFingerprint(parseUiNodes(a + b))).toBe(screenFingerprint(parseUiNodes(a + b)));
    expect(screenFingerprint(parseUiNodes(a + b))).not.toBe(screenFingerprint(parseUiNodes(a + checked)));
  });
});

describe('deriveScreenSize', () => {
  it('uses the greatest node extent', () => {
    const nodes = parseUiNodes(
      node('text="One" bounds="[0,0][1080,100]"') + node('text="Two" bounds="[0,0][500,2400]"'),
    );
    expect(deriveScreenSize(nodes)).toEqual({ width: 1080, height: 2400, source: 'xml' });
  });

  it('reports unknown when nothing is measurable', () => {
    expect(deriveScreenSize([])).toEqual({ width: 0, height: 0, source: 'unknown' });
  });
});

describe('findNextButton', () => {
  it('picks the lowest enabled Next/Submit control', () => {
    const nodes = parseUiNodes(
      [
        node('text="Next" bounds="[0,0][100,50]" clickable="true"'),
        node('text="Submit" bounds="[0,900][100,950]" clickable="true"'),
        node('text="Next" bounds="[0,950][100,1000]" clickable="true" enabled="false"'),
      ].join(''),
    );

    expect(findNextButton(nodes)?.text).toBe('Submit');
  });

  it('returns null when no control matches', () => {
    expect(findNextButton(parseUiNodes(labelledNode('Back')))).toBeNull();
  });
});

describe('findCloseButton', () => {
  it('prefers a close control in the top-right region', () => {
    const nodes = parseUiNodes(
      [
        node('text="Cancel" bounds="[0,1800][200,1900]" clickable="true"'),
        node('content-desc="Close" bounds="[900,50][1000,150]" clickable="true"'),
      ].join(''),
    );

    expect(findCloseButton(nodes, { width: 1000, height: 2000, source: 'override' })?.desc).toBe('Close');
  });
});
