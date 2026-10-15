import { describe, expect, it } from 'vitest';
import { createUiStore } from './ui';

describe('Document navigator (openDocument)', () => {
  it('opens a material at a fragment with the exact quote, and a page at a block', () => {
    const ui = createUiStore();
    ui.getState().openDocument({ type: 'material', id: 'm1', seg: 4, quote: 'the same entropy' });
    const first = ui.getState().right;
    expect(first).toMatchObject({ kind: 'doc', target: { type: 'material', id: 'm1', seg: 4, quote: 'the same entropy' } });
    expect(ui.getState().docMaterialId).toBe('m1');

    ui.getState().openDocument({ type: 'page', id: 'p1', block_id: 'b5', seg: null, quote: '  ' });
    expect(ui.getState().right).toMatchObject({ kind: 'doc', target: { type: 'page', id: 'p1', block_id: 'b5' } });
    // Empty optional parts are dropped, so targets compare cleanly.
    expect(ui.getState().right).not.toHaveProperty('target.quote');
    expect(ui.getState().docMaterialId).toBeNull();
  });

  it('re-opening the same target gives a new nonce (scroll and highlight run again)', () => {
    const ui = createUiStore();
    ui.getState().openDocument({ type: 'page', id: 'p1' });
    const a = ui.getState().right;
    ui.getState().openDocument({ type: 'page', id: 'p1' });
    const b = ui.getState().right;
    expect(a?.kind === 'doc' && b?.kind === 'doc' && b.nonce > a.nonce).toBe(true);
  });

  it('keeps ⤢ within the same kind of panel and resets it for another kind; ✕ closes anything', () => {
    const ui = createUiStore();
    ui.getState().openDoc('m1');
    ui.getState().toggleDocExpanded();
    ui.getState().openDocument({ type: 'page', id: 'p1' });
    expect(ui.getState().docExpanded).toBe(true);
    ui.getState().openGraph();
    expect(ui.getState().docExpanded).toBe(false);
    expect(ui.getState().right).toEqual({ kind: 'graph' });
    ui.getState().closeDoc();
    expect(ui.getState().right).toBeNull();
    ui.getState().toggleDocExpanded();
    expect(ui.getState().docExpanded).toBe(false);
  });

  it('remembers recently opened wiki pages, newest first, without duplicates', () => {
    const ui = createUiStore();
    for (const id of ['a', 'b', 'a', 'c']) ui.getState().openDocument({ type: 'page', id });
    ui.getState().openDoc('m1');
    expect(ui.getState().recentPages).toEqual(['c', 'a', 'b']);
  });

  it('"All materials" takes the centre and gives it back', () => {
    const ui = createUiStore();
    expect(ui.getState().center).toBe('chat');
    ui.getState().showCenter('materials');
    expect(ui.getState().center).toBe('materials');
  });
});
