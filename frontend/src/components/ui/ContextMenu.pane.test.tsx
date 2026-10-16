import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContextMenu, ContextMenuItem } from './ContextMenu';

/**
 * A right-click menu belongs to the column it was raised in (PANES-SPEC §1):
 * raised near the right edge of the notes column it opens leftwards, never over
 * the chat next to it. jsdom has no layout, so the column and the menu get
 * explicit boxes.
 */

const box = (left: number, top: number, width: number, height: number) => ({
  left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}),
}) as DOMRect;

afterEach(() => vi.restoreAllMocks());

describe('ContextMenu inside a column', () => {
  it('stays inside the centre column at its right edge', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1400 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 820 });
    const original = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.dataset.pane === 'center') return box(250, 40, 790, 780);
      if (this.classList.contains('context-menu')) return box(0, 0, 220, 120);
      return original.call(this);
    });

    render(
      <section data-pane="center">
        <ContextMenu x={1030} y={300} label="Действия" onDismiss={() => undefined}>
          <ContextMenuItem onClick={() => undefined}>Копировать</ContextMenuItem>
        </ContextMenu>
      </section>,
    );

    const menu = screen.getByRole('menu', { name: 'Действия' });
    const left = parseFloat(menu.style.left);
    expect(left + 220).toBeLessThanOrEqual(1040);
    expect(left).toBe(1030 - 220);
    // Capped to the column, not to the window.
    expect(parseFloat(menu.style.maxWidth)).toBeLessThanOrEqual(790);
  });

  it('is bounded by the window when raised outside any column', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 });
    const original = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('context-menu')) return box(0, 0, 220, 120);
      return original.call(this);
    });
    render(
      <ContextMenu x={790} y={590} label="Окно" onDismiss={() => undefined}>
        <ContextMenuItem onClick={() => undefined}>Пункт</ContextMenuItem>
      </ContextMenu>,
    );
    const menu = screen.getByRole('menu', { name: 'Окно' });
    expect(parseFloat(menu.style.left) + 220).toBeLessThanOrEqual(800);
    expect(parseFloat(menu.style.top) + 120).toBeLessThanOrEqual(600);
  });
});
