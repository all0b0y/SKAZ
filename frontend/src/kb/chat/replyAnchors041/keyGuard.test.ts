import { describe, expect, it } from 'vitest';

import { anchorNavigationDirection, isEditableTarget, navigationDirection } from './keyGuard';

// B1 — SKAZ 0.4.1, decision 04 §5: ↑/↓ navigate answers only when the focus is not in an input
// field. The guard mirrors QuestionBlock's option-key guard, so edit-in-place fields inside the
// log keep their arrows.

describe('navigationDirection', () => {
  it('bare ↑/↓ only: modifiers and other keys belong to the browser and the OS', () => {
    expect(navigationDirection({ key: 'ArrowUp' })).toBe('previous');
    expect(navigationDirection({ key: 'ArrowDown' })).toBe('next');
    expect(navigationDirection({ key: 'ArrowLeft' })).toBeNull();
    expect(navigationDirection({ key: 'PageUp' })).toBeNull();
    expect(navigationDirection({ key: 'Enter' })).toBeNull();
    expect(navigationDirection({ key: 'ArrowUp', metaKey: true })).toBeNull();
    expect(navigationDirection({ key: 'ArrowDown', ctrlKey: true })).toBeNull();
    expect(navigationDirection({ key: 'ArrowUp', altKey: true })).toBeNull();
  });

  it('R1: Shift+Arrow is never ours — native selection keeps working, nothing is prevented', () => {
    expect(navigationDirection({ key: 'ArrowDown', shiftKey: true })).toBeNull();
    expect(navigationDirection({ key: 'ArrowUp', shiftKey: true })).toBeNull();
    expect(anchorNavigationDirection({ key: 'ArrowDown', shiftKey: true }, document.createElement('div'))).toBeNull();
    expect(anchorNavigationDirection({ key: 'ArrowUp', shiftKey: true }, document.createElement('article'))).toBeNull();
  });

  it('R1: an event another handler already consumed is never handled again', () => {
    expect(navigationDirection({ key: 'ArrowDown', defaultPrevented: true })).toBeNull();
    expect(navigationDirection({ key: 'ArrowUp', defaultPrevented: true })).toBeNull();
    expect(anchorNavigationDirection({ key: 'ArrowDown', defaultPrevented: true }, document.createElement('div'))).toBeNull();
  });
});

describe('isEditableTarget', () => {
  it('fields are guarded; plain content is not', () => {
    for (const tag of ['input', 'textarea', 'select']) {
      expect(isEditableTarget(document.createElement(tag))).toBe(true);
    }
    expect(isEditableTarget(document.createElement('button'))).toBe(false);
    expect(isEditableTarget(document.createElement('article'))).toBe(false);
    expect(isEditableTarget(document.createElement('div'))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget({} as EventTarget)).toBe(false);
  });

  it('contenteditable is guarded — the element itself and anything typed inside it', () => {
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    expect(isEditableTarget(editable)).toBe(true);
    const caret = document.createElement('span');
    editable.appendChild(caret);
    expect(isEditableTarget(caret)).toBe(true);
    const off = document.createElement('div');
    off.setAttribute('contenteditable', 'false');
    expect(isEditableTarget(off)).toBe(false);
  });
});

describe('anchorNavigationDirection', () => {
  it('↑/↓ act outside editables and never inside them or with modifiers', () => {
    expect(anchorNavigationDirection({ key: 'ArrowDown' }, document.createElement('div'))).toBe('next');
    expect(anchorNavigationDirection({ key: 'ArrowUp' }, document.createElement('article'))).toBe('previous');
    const field = document.createElement('input');
    expect(anchorNavigationDirection({ key: 'ArrowDown' }, field)).toBeNull();
    expect(anchorNavigationDirection({ key: 'ArrowUp' }, field)).toBeNull();
    expect(anchorNavigationDirection({ key: 'ArrowDown', metaKey: true }, document.createElement('div'))).toBeNull();
    expect(anchorNavigationDirection({ key: 'ArrowDown' }, null)).toBe('next');
  });
});
