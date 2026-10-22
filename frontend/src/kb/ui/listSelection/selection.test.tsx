import { useState } from 'react';
import { createPortal } from 'react-dom';
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MotionProvider } from '../motion';
import { SelectionBar, SelectionCheckbox, ShortcutsPopover, useListSelection, type ListSelectionOptions } from './index';
import { ITEMS_MIME, readDragItems, startItemsDrag, endItemsDrag, currentDrag, markItemsDropped } from './dnd';
import { Toast } from '../Toast';

const ROWS = [
  { id: 'a', title: 'Alpha' },
  { id: 'b', title: 'Bravo' },
  { id: 'c', title: 'Charlie (recording)' },
  { id: 'd', title: 'Delta' },
];

type Handlers = Pick<ListSelectionOptions, 'onOpen' | 'onAttach' | 'onDelete' | 'onMove' | 'onExport'>;

/** A list the way the app wires it: a button per row that opens, the hook on top. */
function List(props: Handlers & { resetKey?: string; label?: string }) {
  const sel = useListSelection({
    ids: ROWS.map((r) => r.id),
    reasonNotSelectable: (id) => (id === 'c' ? 'Being recorded — can’t be selected yet' : null),
    resetKey: props.resetKey,
    ...props,
  });
  return (
    <MotionProvider>
      <div {...sel.listProps}>
        <ul {...sel.gridProps} aria-label={props.label ?? 'Things'}>
          {ROWS.map((r) => (
            <li key={r.id} {...sel.rowProps(r.id)}>
              <div role="gridcell">
                <button type="button" onClick={() => props.onOpen?.(r.id)}>
                  <SelectionCheckbox checked={sel.selected.has(r.id)} reason={sel.reasonOf(r.id)} />
                  {r.title}
                </button>
              </div>
            </li>
          ))}
        </ul>
        <SelectionBar count={sel.selected.size} variant="compact" onClear={sel.clear}
          actions={[{ id: 'move', label: 'Move to…', icon: 'folder', shortcut: '⌘⇧M', onSelect: () => props.onMove?.([...sel.selected]) }]}
          more={[{ id: 'export', label: 'Export .md', icon: 'export', shortcut: '⌘⇧E', onSelect: () => props.onExport?.([...sel.selected]) }]} />
        <ShortcutsPopover open={sel.shortcutsOpen} onClose={() => sel.setShortcutsOpen(false)} anchorRef={sel.listRef}
          has={{ move: true, attach: true, delete: true, export: true }} />
      </div>
    </MotionProvider>
  );
}

const row = (name: string): Element => screen.getByRole('button', { name: new RegExp(`^${name}`) }).closest('[role="row"]')!;
const selectedIds = () => screen.getAllByRole('row').filter((r) => r.getAttribute('aria-selected') === 'true').map((r) => r.getAttribute('data-sel-id'));

describe('useListSelection (0.3.1 F2/F5)', () => {
  it('a plain click keeps opening; ⌘-click and the box select without opening; then a plain click toggles', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<List onOpen={onOpen} />);
    expect(screen.getByRole('grid', { name: 'Things' })).toHaveAttribute('aria-multiselectable', 'true');
    await user.click(screen.getByRole('button', { name: /^Alpha/ }));
    expect(onOpen).toHaveBeenCalledWith('a');
    expect(selectedIds()).toEqual([]);
    onOpen.mockClear();

    await user.keyboard('{Meta>}');
    await user.click(screen.getByRole('button', { name: /^Bravo/ }));
    await user.keyboard('{/Meta}');
    expect(selectedIds()).toEqual(['b']);
    // The box of another row adds it.
    await user.click(row('Delta').querySelector('[data-sel-box]')!);
    expect(selectedIds()).toEqual(['b', 'd']);
    // With a selection, a plain click toggles and opens nothing.
    await user.click(screen.getByRole('button', { name: /^Bravo/ }));
    expect(selectedIds()).toEqual(['d']);
    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.getByRole('toolbar', { name: '1 selected' })).toBeInTheDocument();
  });

  it('⇧-click selects a range and skips a row that can’t be selected; that row shows why', async () => {
    const user = userEvent.setup();
    render(<List />);
    await user.keyboard('{Meta>}');
    await user.click(screen.getByRole('button', { name: /^Alpha/ }));
    await user.keyboard('{/Meta}{Shift>}');
    await user.click(screen.getByRole('button', { name: /^Delta/ }));
    await user.keyboard('{/Shift}');
    expect(selectedIds()).toEqual(['a', 'b', 'd']);
    expect(row('Charlie').querySelector('[data-sel-box]')).toHaveAttribute('title', 'Being recorded — can’t be selected yet');
    // ⌘-click on it doesn't select it either.
    await user.keyboard('{Meta>}');
    await user.click(screen.getByRole('button', { name: /^Charlie/ }));
    await user.keyboard('{/Meta}');
    expect(selectedIds()).toEqual(['a', 'b', 'd']);
  });

  it('keyboard in the focused list: ↓ ⇧↓ Space ⌘A Esc ↩ ⌘↩ ⌘⇧M ⌘⌫ ⌘⇧E ⌘/', async () => {
    const user = userEvent.setup();
    const h = { onOpen: vi.fn(), onAttach: vi.fn(), onDelete: vi.fn(), onMove: vi.fn(), onExport: vi.fn() };
    render(<List {...h} />);
    screen.getByRole('button', { name: /^Alpha/ }).focus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('button', { name: /^Bravo/ })).toHaveFocus();
    await user.keyboard(' ');
    expect(selectedIds()).toEqual(['b']);
    expect(h.onOpen).not.toHaveBeenCalled();
    await user.keyboard('{Shift>}{ArrowDown}{ArrowDown}{/Shift}');
    expect(screen.getByRole('button', { name: /^Delta/ })).toHaveFocus();
    expect(selectedIds()).toEqual(['b', 'd']);
    await user.keyboard('{Escape}');
    expect(selectedIds()).toEqual([]);
    await user.keyboard('{Meta>}a{/Meta}');
    expect(selectedIds()).toEqual(['a', 'b', 'd']);
    await user.keyboard('{Meta>}{Enter}{/Meta}');
    expect(h.onAttach).toHaveBeenCalledWith(['a', 'b', 'd']);
    await user.keyboard('{Meta>}{Shift>}m{/Shift}{/Meta}');
    expect(h.onMove).toHaveBeenCalledWith(['a', 'b', 'd']);
    await user.keyboard('{Meta>}{Backspace}{/Meta}');
    expect(h.onDelete).toHaveBeenCalledWith(['a', 'b', 'd']);
    await user.keyboard('{Meta>}{Shift>}e{/Shift}{/Meta}');
    expect(h.onExport).toHaveBeenCalledWith(['a', 'b', 'd']);
    await user.keyboard('{Enter}');
    expect(h.onOpen).toHaveBeenCalledWith('d');
    await user.keyboard('{Meta>}/{/Meta}');
    const pop = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(pop).toHaveTextContent('Attach selection to the chat');
    expect(pop).toHaveTextContent('⌘⇧M');
  });

  it('nothing selected: an action takes the focused row; ⌘, and ⌘K are left to the app', async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    const onKey = vi.fn();
    window.addEventListener('keydown', onKey);
    render(<List onDelete={onDelete} />);
    screen.getByRole('button', { name: /^Bravo/ }).focus();
    await user.keyboard('{Meta>}{Backspace}{/Meta}');
    expect(onDelete).toHaveBeenCalledWith(['b']);
    await user.keyboard('{Meta>}k{/Meta}{Meta>},{/Meta}');
    const passed = onKey.mock.calls.map(([e]) => (e as KeyboardEvent)).filter((e) => e.metaKey && (e.key === 'k' || e.key === ','));
    expect(passed).toHaveLength(2);
    expect(passed.every((e) => !e.defaultPrevented)).toBe(true);
    window.removeEventListener('keydown', onKey);
  });

  it('keys typed in a text field inside the list are not taken', async () => {
    const user = userEvent.setup();
    function WithField() {
      const sel = useListSelection({ ids: ['a'] });
      return (
        <div {...sel.listProps}>
          <input aria-label="Name" />
          <ul {...sel.gridProps} aria-label="L"><li {...sel.rowProps('a')}><div role="gridcell"><button type="button">A</button></div></li></ul>
        </div>
      );
    }
    render(<WithField />);
    await user.click(screen.getByRole('textbox', { name: 'Name' }));
    await user.keyboard('hello{Meta>}a{/Meta}');
    expect(screen.getByRole('row')).toHaveAttribute('aria-selected', 'false');
  });

  it('clears when the list changes (folder, filter) and drops rows that left the list', async () => {
    const user = userEvent.setup();
    function Switching() {
      const [key, setKey] = useState('one');
      return <><button type="button" onClick={() => setKey('two')}>Other folder</button><List resetKey={key} /></>;
    }
    render(<Switching />);
    await user.keyboard('{Meta>}');
    await user.click(screen.getByRole('button', { name: /^Alpha/ }));
    await user.keyboard('{/Meta}');
    expect(selectedIds()).toEqual(['a']);
    await user.click(screen.getByRole('button', { name: 'Other folder' }));
    expect(selectedIds()).toEqual([]);
  });

  it('the compact bar names icon buttons, shows shortcuts in tooltips and in ⋯, ✕ clears', async () => {
    const user = userEvent.setup();
    const onExport = vi.fn();
    render(<List onExport={onExport} />);
    await user.click(row('Alpha').querySelector('[data-sel-box]')!);
    const bar = screen.getByRole('toolbar', { name: '1 selected' });
    await user.hover(within(bar).getByRole('button', { name: 'Move to…' }));
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Move to… ⌘⇧M');
    await user.click(within(bar).getByRole('button', { name: 'More actions' }));
    const item = await screen.findByRole('menuitem', { name: /Export \.md/ });
    expect(item).toHaveTextContent('⌘⇧E');
    await user.click(item);
    expect(onExport).toHaveBeenCalledWith(['a']);
    await user.click(within(bar).getByRole('button', { name: 'Clear selection' }));
    expect(selectedIds()).toEqual([]);
  });
});

/** Two lists side by side, a plain button and a text field outside them (0.3.1 F7). */
function TwoLists() {
  return (
    <>
      <button type="button">Outside</button>
      <input aria-label="Field" />
      <List label="Things" />
      <OtherList />
    </>
  );
}

function OtherList() {
  const sel = useListSelection({ ids: ['x', 'y'] });
  return (
    <div {...sel.listProps} data-testid="other">
      <ul {...sel.gridProps} aria-label="Others">
        {['x', 'y'].map((id) => (
          <li key={id} {...sel.rowProps(id)}>
            <div role="gridcell"><button type="button"><SelectionCheckbox checked={sel.selected.has(id)} />{id === 'x' ? 'Xray' : 'Yankee'}</button></div>
          </li>
        ))}
      </ul>
    </div>
  );
}

const selectedIn = (grid: string) => within(screen.getByRole('grid', { name: grid })).getAllByRole('row')
  .filter((r) => r.getAttribute('aria-selected') === 'true').map((r) => r.getAttribute('data-sel-id'));
const selectingList = (grid: string) => screen.getByRole('grid', { name: grid }).closest('[data-selecting]');

describe('Finder-like selection (0.3.1 F7, F7-a)', () => {
  it('⌘A over the list under the pointer selects all of it, even with the focus in another list', async () => {
    const user = userEvent.setup();
    render(<TwoLists />);
    // The keyboard is in "Others", the pointer rests over "Things".
    act(() => screen.getByRole('button', { name: /^Xray/ }).focus());
    await user.hover(screen.getByRole('button', { name: /^Bravo/ }));
    await user.keyboard('{Meta>}a{/Meta}');
    expect(selectedIn('Things')).toEqual(['a', 'b', 'd']);
    expect(selectedIn('Others')).toEqual([]);
    expect(selectingList('Things')).not.toBeNull();
    expect(screen.getByRole('button', { name: /^Xray/ })).toHaveFocus();
  });

  it('⌘A over a list with the focus on the page selects it; Esc then clears it', async () => {
    const user = userEvent.setup();
    render(<TwoLists />);
    await user.hover(screen.getByRole('button', { name: /^Yankee/ }));
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    await user.keyboard('{Meta>}a{/Meta}');
    expect(selectedIn('Others')).toEqual(['x', 'y']);
    await user.keyboard('{Escape}');
    expect(selectedIn('Others')).toEqual([]);
  });

  it('pointer outside every list: ⌘A stays with the focused list; in a text field it is the text’s', async () => {
    const user = userEvent.setup();
    render(<TwoLists />);
    await user.hover(screen.getByRole('button', { name: 'Outside' }));
    act(() => screen.getByRole('button', { name: /^Xray/ }).focus());
    await user.keyboard('{Meta>}a{/Meta}');
    expect(selectedIn('Others')).toEqual(['x', 'y']);
    expect(selectedIn('Things')).toEqual([]);
    await user.keyboard('{Escape}');
    // Typing in a field, even with the pointer resting over a list: the field keeps ⌘A.
    await user.click(screen.getByRole('textbox', { name: 'Field' }));
    await user.hover(screen.getByRole('button', { name: /^Alpha/ }));
    await user.keyboard('{Meta>}a{/Meta}');
    expect(selectedIn('Things')).toEqual([]);
  });

  it('a click on empty space of the list or anywhere outside clears it at once', async () => {
    const user = userEvent.setup();
    render(<TwoLists />);
    await user.keyboard('{Meta>}');
    await user.click(screen.getByRole('button', { name: /^Alpha/ }));
    await user.click(screen.getByRole('button', { name: /^Bravo/ }));
    await user.keyboard('{/Meta}');
    expect(selectedIn('Things')).toEqual(['a', 'b']);
    await user.click(screen.getByRole('button', { name: 'Outside' }));
    expect(selectedIn('Things')).toEqual([]);
    expect(selectingList('Things')).toBeNull();

    await user.click(row('Alpha').querySelector('[data-sel-box]')!);
    expect(selectedIn('Things')).toEqual(['a']);
    // Empty space inside the list (not a row): clears too.
    await user.click(screen.getByRole('grid', { name: 'Things' }));
    expect(selectedIn('Things')).toEqual([]);

    // A row of another list starts over there.
    await user.click(row('Alpha').querySelector('[data-sel-box]')!);
    await user.keyboard('{Meta>}');
    await user.click(screen.getByRole('button', { name: /^Xray/ }));
    await user.keyboard('{/Meta}');
    expect(selectedIn('Things')).toEqual([]);
    expect(selectedIn('Others')).toEqual(['x']);
  });

  it('clicks on the selection bar, its menu and a confirmation window do not count as outside', async () => {
    const user = userEvent.setup();
    const onExport = vi.fn();
    function WithDialog() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <List onExport={onExport} onMove={() => setOpen(true)} />
          {open && createPortal(<div role="dialog" aria-label="Move 2 things?"><button type="button" onClick={() => setOpen(false)}>Cancel</button></div>, document.body)}
        </>
      );
    }
    render(<WithDialog />);
    await user.click(row('Alpha').querySelector('[data-sel-box]')!);
    await user.click(row('Bravo').querySelector('[data-sel-box]')!);
    const bar = screen.getByRole('toolbar', { name: '2 selected' });
    await user.click(within(bar).getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: /Export \.md/ }));
    expect(onExport).toHaveBeenCalledWith(['a', 'b']);
    expect(selectedIds()).toEqual(['a', 'b']);
    await user.click(within(bar).getByRole('button', { name: 'Move to…' }));
    await user.click(within(screen.getByRole('dialog', { name: 'Move 2 things?' })).getByRole('button', { name: 'Cancel' }));
    expect(selectedIds()).toEqual(['a', 'b']);
  });

  it('the ⌘/ list names ⌘A over a list', async () => {
    const user = userEvent.setup();
    render(<List />);
    act(() => screen.getByRole('button', { name: /^Alpha/ }).focus());
    await user.keyboard('{Meta>}/{/Meta}');
    const pop = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(pop).toHaveTextContent('⌘A over a list — select all in it');
  });
});

describe('drag payload (application/x-skaz-items)', () => {
  it('writes [{type, id}] under the SKAZ MIME and reads it back; the current drag is known while it lasts', () => {
    const data = new Map<string, string>();
    const dt = {
      setData: (k: string, v: string) => data.set(k, v),
      getData: (k: string) => data.get(k) ?? '',
      get types() { return [...data.keys()]; },
      effectAllowed: 'all',
    } as unknown as DataTransfer;
    startItemsDrag(dt, { items: [{ type: 'material', id: 'm1' }, { type: 'material', id: 'm2' }], title: 'Lecture', blocked: null });
    expect(JSON.parse(data.get(ITEMS_MIME)!)).toEqual([{ type: 'material', id: 'm1' }, { type: 'material', id: 'm2' }]);
    expect(currentDrag()?.items).toHaveLength(2);
    expect(readDragItems(dt)).toEqual([{ type: 'material', id: 'm1' }, { type: 'material', id: 'm2' }]);
    endItemsDrag();
    expect(currentDrag()).toBeNull();
    data.set(ITEMS_MIME, '[{"type":"folder","id":"x"}]');
    expect(readDragItems(dt)).toBeNull();
  });
});

describe('Toast', () => {
  it('says what happened, offers Undo once and goes away by itself', async () => {
    vi.useFakeTimers();
    const undo = vi.fn();
    const onClose = vi.fn();
    render(<MotionProvider><Toast toast={{ id: 1, text: 'Moved 2 materials to «Physics»', action: { label: 'Undo', run: undo } }} onClose={onClose} /></MotionProvider>);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Moved 2 materials to «Physics»');
    fireEvent.click(within(status).getByRole('button', { name: 'Undo' }));
    expect(undo).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => { vi.advanceTimersByTime(10_000); });
    vi.useRealTimers();
  });

  it('closes on its own after a while', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(<MotionProvider><Toast toast={{ id: 2, text: 'Already in «Physics»' }} onClose={onClose} /></MotionProvider>);
    act(() => { vi.advanceTimersByTime(8000); });
    expect(onClose).toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe('drag end knows whether a target took the drop', () => {
  const dt = () => ({ setData: vi.fn(), types: [ITEMS_MIME] } as unknown as DataTransfer);
  it('true after a target in the window marked the drop, false when the drag was abandoned', () => {
    startItemsDrag(dt(), { items: [{ type: 'material', id: 'm1' }], title: 'A', blocked: null });
    markItemsDropped();
    expect(endItemsDrag()).toBe(true);
    expect(currentDrag()).toBeNull();
    startItemsDrag(dt(), { items: [{ type: 'material', id: 'm1' }], title: 'A', blocked: null });
    expect(endItemsDrag()).toBe(false);
  });
});
