import { clip, type SelectedItem, type SelectionTarget } from './model';
import { isSelected, type SelectionStore } from './store';

/**
 * P2 selection over the DOM of one block — generic: every selectable thing carries `data-item-id`
 * (P1's `BlockItem` sets it on every block's items; `mermaid.ts` sets it on mapped diagram nodes and
 * edges). No block type is special here. Click or Enter/Space picks an item, arrows move between
 * items (one Tab stop per block), Escape clears the selection. A click on a button or link inside an
 * item (a timecode, a source chip) keeps doing its own job; dragging to select text is not a pick.
 *
 * The attributes are set on the elements directly (React doesn't own `data-selected`/`tabindex` on
 * them, so its re-renders keep them): `data-selectable`, `data-selected`, a roving `tabindex`.
 */

const ITEM = '[data-item-id]';
/** An element that stands for an item (a diagram edge's label): picks that item, not focusable. */
const ALIAS = '[data-item-for]';
const INTERACTIVE = 'button, a, input, textarea, select, [contenteditable="true"]';
const FLASH_MS = 2400;

type El = HTMLElement | SVGElement;

function itemsOf(root: Element): El[] {
  return Array.from(root.querySelectorAll<El>(ITEM));
}

function itemById(root: Element, id: string): El | undefined {
  return itemsOf(root).find((el) => el.getAttribute('data-item-id') === id);
}

/** What the user sees in the item: its text without the hover source tag. */
function visibleText(el: El): string {
  const copy = el.cloneNode(true) as Element;
  copy.querySelectorAll('.kb-blk__tag, [aria-hidden="true"]').forEach((n) => n.remove());
  // Text by text node: a title and its detail in two elements stay two words apart.
  const walker = document.createTreeWalker(copy, NodeFilter.SHOW_TEXT);
  const words: string[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) words.push(node.textContent ?? '');
  return words.join(' ');
}

export function itemOf(el: El): SelectedItem {
  const id = el.getAttribute('data-item-id') ?? '';
  return { id, label: clip(el.getAttribute('data-item-label') ?? visibleText(el)) || id };
}

const isSvg = (el: El): el is SVGElement => el instanceof SVGElement;

export interface Attached {
  detach: () => void;
  /** Set the attributes again (after a re-render that may have added items). */
  sync: () => void;
}

export function attachSelection(root: El, target: SelectionTarget, store: SelectionStore): Attached {
  let stop: string | null = null;

  const sync = () => {
    const selection = store.getState().selection;
    const items = itemsOf(root);
    if (!items.some((el) => el.getAttribute('data-item-id') === stop)) stop = items[0]?.getAttribute('data-item-id') ?? null;
    for (const el of items) {
      const id = el.getAttribute('data-item-id') ?? '';
      const on = isSelected(selection, target, id);
      el.setAttribute('data-selectable', '');
      el.setAttribute('data-selected', String(on));
      el.setAttribute('tabindex', id === stop ? '0' : '-1');
      // A diagram node is drawing, not text: say what it is and whether it is picked.
      if (isSvg(el)) { el.setAttribute('role', 'button'); el.setAttribute('aria-pressed', String(on)); }
    }
    root.querySelectorAll<El>(ALIAS).forEach((el) => {
      el.setAttribute('data-selectable', '');
      el.setAttribute('data-selected', String(isSelected(selection, target, el.getAttribute('data-item-for') ?? '')));
    });
  };

  const toggle = (el: El) => store.getState().toggle(target, itemOf(el));

  const onClick = (event: Event) => {
    const from = event.target as Element | null;
    const hit = from?.closest?.(`${ITEM}, ${ALIAS}`);
    if (!hit || !root.contains(hit)) return;
    const control = from!.closest(INTERACTIVE);
    if (control && hit.contains(control)) return;
    if (!(window.getSelection()?.isCollapsed ?? true)) return;
    const el = hit.matches(ITEM) ? hit as El : itemById(root, hit.getAttribute('data-item-for') ?? '');
    if (!el) return;
    // A picked diagram node is not a click on the drawing (which opens the full-size viewer).
    event.stopPropagation();
    stop = el.getAttribute('data-item-id');
    toggle(el);
  };

  const onKey = (event: Event) => {
    const e = event as KeyboardEvent;
    const el = e.target as El | null;
    if (!el?.matches?.(ITEM) || !root.contains(el)) return;
    const items = itemsOf(root);
    const at = items.indexOf(el);
    let next: El | undefined;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle(el);
      return;
    }
    if (e.key === 'Escape') {
      if (!store.getState().selection) return;
      e.preventDefault();
      e.stopPropagation();
      store.getState().clear();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = items[Math.min(at + 1, items.length - 1)];
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = items[Math.max(at - 1, 0)];
    else if (e.key === 'Home') next = items[0];
    else if (e.key === 'End') next = items.at(-1);
    if (!next) return;
    e.preventDefault();
    stop = next.getAttribute('data-item-id');
    sync();
    next.focus({ preventScroll: false });
  };

  const onFocus = (event: Event) => {
    const el = event.target as El | null;
    if (el?.matches?.(ITEM) && root.contains(el) && el.getAttribute('data-item-id') !== stop) {
      stop = el.getAttribute('data-item-id');
      sync();
    }
  };

  root.addEventListener('click', onClick);
  root.addEventListener('keydown', onKey);
  root.addEventListener('focusin', onFocus);
  const unsubscribe = store.subscribe(sync);
  sync();
  return {
    sync,
    detach: () => {
      unsubscribe();
      root.removeEventListener('click', onClick);
      root.removeEventListener('keydown', onKey);
      root.removeEventListener('focusin', onFocus);
      for (const el of [...itemsOf(root), ...Array.from(root.querySelectorAll<El>(ALIAS))]) {
        for (const name of ['data-selectable', 'data-selected', 'tabindex', 'role', 'aria-pressed']) {
          if (name === 'role' || name === 'aria-pressed' ? isSvg(el) : true) el.removeAttribute(name);
        }
      }
    },
  };
}

/** The chip of an earlier question was clicked: light these items of the old answer for a moment. */
export function flashItems(root: Element, ids: readonly string[]): El[] {
  const lit = itemsOf(root).filter((el) => ids.includes(el.getAttribute('data-item-id') ?? ''));
  for (const el of lit) el.setAttribute('data-flash', 'true');
  window.setTimeout(() => lit.forEach((el) => el.removeAttribute('data-flash')), FLASH_MS);
  return lit;
}
