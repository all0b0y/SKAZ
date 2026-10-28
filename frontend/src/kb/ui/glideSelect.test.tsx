import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { Menu, Popover } from './Popover';
import { springEasing } from './ActiveTab';

/* GlideSelect (stage 6, B1): one highlight glides between menu rows under the pointer and the arrow keys. */

interface FakeAnimation { el: HTMLElement; frames: Keyframe[]; opts: KeyframeAnimationOptions; cancel: () => void }

function stubAnimate() {
  const played: FakeAnimation[] = [];
  (HTMLElement.prototype as unknown as { animate?: unknown }).animate = function animate(this: HTMLElement, frames: Keyframe[], opts: KeyframeAnimationOptions) {
    const a: FakeAnimation = { el: this, frames, opts, cancel: vi.fn() };
    played.push(a);
    return a;
  };
  return played;
}

const ROW_H = 34;
const LABELS = ['Rename', 'Move', 'Delete'];

beforeEach(() => {
  // jsdom has no layout: rows sit 34 px apart inside the popover at (0, 0).
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const i = LABELS.indexOf(this.textContent ?? '');
    const top = i >= 0 ? i * ROW_H : 0;
    const height = i >= 0 ? ROW_H : 0;
    return { left: 0, right: 200, top, bottom: top + height, width: 200, height, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate;
  delete document.documentElement.dataset.motion;
});

function Harness() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <button ref={ref} type="button" onClick={() => setOpen(true)}>Actions</button>
      <Menu open={open} onClose={() => setOpen(false)} anchorRef={ref} label="Folder"
        items={[
          { id: 'r', label: 'Rename', onSelect: vi.fn() },
          { id: 'm', label: 'Move', onSelect: vi.fn() },
          { id: 'd', label: 'Delete', disabled: true, onSelect: vi.fn() },
        ]} />
    </>
  );
}

async function openMenu() {
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
  const menu = await screen.findByRole('menu', { name: 'Folder' });
  const glide = menu.querySelector<HTMLElement>('.kb-glide')!;
  const row = (name: string) => within(menu).getByRole('menuitem', { name });
  return { menu, glide, row };
}

const glideAnims = (played: FakeAnimation[]) => played.filter((a) => a.el.classList.contains('kb-glide'));

describe('GlideSelect (B1)', () => {
  it('a menu has one decorative highlight that sits on the hovered row and fades in from nowhere', async () => {
    const played = stubAnimate();
    const { menu, glide, row } = await openMenu();
    expect(menu.querySelectorAll('.kb-glide')).toHaveLength(1);
    expect(glide).toHaveAttribute('aria-hidden', 'true');
    expect(glide.style.opacity).not.toBe('1');
    fireEvent.pointerOver(row('Rename'));
    expect(glide.style.opacity).toBe('1');
    expect(glide.style.transform).toBe('translate(0px, 0px)');
    expect(glide.style.height).toBe(`${ROW_H}px`);
    const first = glideAnims(played);
    expect(first).toHaveLength(1);
    expect(first[0]!.frames).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect(first[0]!.opts.duration).toBe(100);
  });

  it('full: moving to the next row glides there on the small spring; leaving the menu fades it out in 120 ms', async () => {
    const played = stubAnimate();
    const { menu, glide, row } = await openMenu();
    fireEvent.pointerOver(row('Rename'));
    fireEvent.pointerOver(row('Move'));
    expect(glide.style.transform).toBe(`translate(0px, ${ROW_H}px)`);
    const move = glideAnims(played).at(-1)!;
    expect(move.frames[0]).toMatchObject({ transform: 'translate(0px, 0px)' });
    expect(move.frames[1]).toMatchObject({ transform: `translate(0px, ${ROW_H}px)` });
    const spring = springEasing(0.26, 0);
    expect(move.opts).toMatchObject({ duration: spring.duration, easing: spring.easing });
    fireEvent.pointerLeave(menu);
    expect(glide.style.opacity).toBe('0');
    const out = glideAnims(played).at(-1)!;
    expect(out.frames).toEqual([{ opacity: 1 }, { opacity: 0 }]);
    expect(out.opts.duration).toBe(120);
  });

  it('a disabled row does not take the highlight (as before: no hover tint on it)', async () => {
    stubAnimate();
    const { glide, row } = await openMenu();
    fireEvent.pointerOver(row('Move'));
    fireEvent.pointerOver(row('Delete'));
    expect(glide.style.opacity).toBe('0');
  });

  it('arrow keys move REAL focus and the highlight follows it', async () => {
    stubAnimate();
    const user = userEvent.setup();
    render(<Harness />);
    screen.getByRole('button', { name: 'Actions' }).focus();
    await user.keyboard('{Enter}');
    const menu = await screen.findByRole('menu', { name: 'Folder' });
    const glide = menu.querySelector<HTMLElement>('.kb-glide')!;
    await waitFor(() => expect(within(menu).getByRole('menuitem', { name: 'Rename' })).toHaveFocus());
    await user.keyboard('{ArrowDown}');
    expect(within(menu).getByRole('menuitem', { name: 'Move' })).toHaveFocus();
    expect(glide.style.opacity).toBe('1');
    expect(glide.style.transform).toBe(`translate(0px, ${ROW_H}px)`);
  });

  it('calm: no glide — the highlight re-fades at the new row in 100 ms', async () => {
    document.documentElement.dataset.motion = 'calm';
    const played = stubAnimate();
    const { glide, row } = await openMenu();
    fireEvent.pointerOver(row('Rename'));
    fireEvent.pointerOver(row('Move'));
    expect(glide.style.transform).toBe(`translate(0px, ${ROW_H}px)`);
    const anims = glideAnims(played);
    expect(anims.some((a) => a.frames.some((f) => 'transform' in f))).toBe(false);
    expect(anims.at(-1)!.frames).toEqual([{ opacity: 0.2 }, { opacity: 1 }]);
    expect(anims.at(-1)!.opts.duration).toBe(100);
  });

  it('off: the highlight jumps — nothing animates', async () => {
    document.documentElement.dataset.motion = 'off';
    const played = stubAnimate();
    const { menu, glide, row } = await openMenu();
    fireEvent.pointerOver(row('Rename'));
    fireEvent.pointerOver(row('Move'));
    expect(glide.style.transform).toBe(`translate(0px, ${ROW_H}px)`);
    fireEvent.pointerLeave(menu);
    expect(glide.style.opacity).toBe('0');
    expect(glideAnims(played)).toHaveLength(0);
  });

  describe('rows that change while the menu is open (FIX2 C-M1)', () => {
    /* Rows sit where they are in the DOM: a removed row moves the ones after it up. */
    const byDomOrder = () => vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const rows = this.classList.contains('kb-menu__item') && this.parentElement
        ? Array.from(this.parentElement.querySelectorAll('.kb-menu__item')) : [];
      const i = rows.indexOf(this);
      const top = i >= 0 ? i * ROW_H : 0;
      const height = i >= 0 ? ROW_H : 0;
      return { left: 0, right: 200, top, bottom: top + height, width: 200, height, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
    });

    function Rows({ rows }: { rows: string[] }) {
      return (
        <div className="kb-menu__list">
          {rows.map((r) => <button key={r} type="button" role="menuitem" tabIndex={-1} className="kb-menu__item">{r}</button>)}
        </div>
      );
    }
    function Inner({ next }: { next: string[] }) {
      const [mine, setMine] = useState(['Rename', 'Move', 'Delete']);
      return <><Rows rows={mine} /><button type="button" onClick={() => setMine(next)}>change</button></>;
    }
    /** `own`: the rows' state lives under Popover (Popover itself does not re-render), as a picker's
     *  inner component; otherwise in Popover's parent (the model-picker search re-renders Popover). */
    function Live({ own, next }: { own: boolean; next: string[] }) {
      const ref = useRef<HTMLButtonElement | null>(null);
      const [rows, setRows] = useState(['Rename', 'Move', 'Delete']);
      return (
        <>
          <button ref={ref} type="button">Anchor</button>
          {!own && <button type="button" onClick={() => setRows(next)}>change</button>}
          <Popover open onClose={() => undefined} anchorRef={ref} label="Live" role="menu" autoFocus={false}>
            {own ? <Inner next={next} /> : <Rows rows={rows} />}
          </Popover>
        </>
      );
    }
    const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

    for (const own of [false, true]) {
      const where = own ? 'below Popover' : 'in Popover’s parent (Popover re-renders)';
      it(`a removed row takes the highlight with it — rows state ${where}`, async () => {
        stubAnimate();
        render(<Live own={own} next={['Rename', 'Delete']} />);
        const menu = await screen.findByRole('menu', { name: 'Live' });
        await act(async () => undefined);
        const glide = menu.querySelector<HTMLElement>('.kb-glide')!;
        fireEvent.pointerOver(within(menu).getByRole('menuitem', { name: 'Move' }));
        expect(glide.style.opacity).toBe('1');
        fireEvent.click(screen.getByRole('button', { name: 'change' }));
        await settle();
        expect(within(menu).queryByRole('menuitem', { name: 'Move' })).toBeNull();
        expect(glide.style.opacity).toBe('0');
      });

      it(`the highlight follows its row to its new place — rows state ${where}`, async () => {
        stubAnimate();
        byDomOrder();
        render(<Live own={own} next={['Move', 'Delete']} />);
        const menu = await screen.findByRole('menu', { name: 'Live' });
        await act(async () => undefined);
        const glide = menu.querySelector<HTMLElement>('.kb-glide')!;
        fireEvent.pointerOver(within(menu).getByRole('menuitem', { name: 'Delete' }));
        expect(glide.style.transform).toBe(`translate(0px, ${2 * ROW_H}px)`);
        fireEvent.click(screen.getByRole('button', { name: 'change' }));
        await settle();
        expect(glide.style.opacity).toBe('1');
        expect(glide.style.transform).toBe(`translate(0px, ${ROW_H}px)`);
      });
    }

    it('a hovered row that turns disabled loses the highlight', async () => {
      stubAnimate();
      function Flip() {
        const ref = useRef<HTMLButtonElement | null>(null);
        const [off, setOff] = useState(false);
        return (
          <>
            <button ref={ref} type="button" onClick={() => setOff(true)}>disable</button>
            <Popover open onClose={() => undefined} anchorRef={ref} label="Flip" role="menu" autoFocus={false}>
              <div className="kb-menu__list">
                <button type="button" role="menuitem" tabIndex={-1} className="kb-menu__item">Rename</button>
                <button type="button" role="menuitem" tabIndex={-1} aria-disabled={off || undefined} className="kb-menu__item">Move</button>
              </div>
            </Popover>
          </>
        );
      }
      render(<Flip />);
      const menu = await screen.findByRole('menu', { name: 'Flip' });
      await act(async () => undefined);
      const glide = menu.querySelector<HTMLElement>('.kb-glide')!;
      fireEvent.pointerOver(within(menu).getByRole('menuitem', { name: 'Move' }));
      expect(glide.style.opacity).toBe('1');
      fireEvent.click(screen.getByRole('button', { name: 'disable' }));
      await settle();
      expect(glide.style.opacity).toBe('0');
    });
  });

  describe('one current row: focus and highlight never part (FIX2 C-M2)', () => {
    function Spied({ picks }: { picks: Record<string, () => void> }) {
      const [open, setOpen] = useState(false);
      const ref = useRef<HTMLButtonElement | null>(null);
      return (
        <>
          <button ref={ref} type="button" onClick={() => setOpen(true)}>Actions</button>
          <Menu open={open} onClose={() => setOpen(false)} anchorRef={ref} label="Folder"
            items={[
              { id: 'r', label: 'Rename', onSelect: picks.Rename! },
              { id: 'm', label: 'Move', onSelect: picks.Move! },
              { id: 'd', label: 'Delete', disabled: true, onSelect: picks.Delete! },
            ]} />
        </>
      );
    }
    async function openByKeyboard() {
      const picks = { Rename: vi.fn(), Move: vi.fn(), Delete: vi.fn() };
      const user = userEvent.setup();
      render(<Spied picks={picks} />);
      screen.getByRole('button', { name: 'Actions' }).focus();
      await user.keyboard('{Enter}');
      const menu = await screen.findByRole('menu', { name: 'Folder' });
      const row = (name: string) => within(menu).getByRole('menuitem', { name });
      await waitFor(() => expect(row('Rename')).toHaveFocus());
      return { user, picks, menu, row, glide: menu.querySelector<HTMLElement>('.kb-glide')! };
    }

    it('hovering a row moves real focus to it, so Enter chooses the highlighted row', async () => {
      stubAnimate();
      const { user, picks, row, glide } = await openByKeyboard();
      await user.hover(row('Move'));
      expect(row('Move')).toHaveFocus();
      expect(glide.style.transform).toBe(`translate(0px, ${ROW_H}px)`);
      await user.keyboard('{Enter}');
      expect(picks.Move).toHaveBeenCalledTimes(1);
      expect(picks.Rename).not.toHaveBeenCalled();
    });

    it('hovering a disabled row takes focus off the previous row: nothing is current, Enter chooses nothing', async () => {
      stubAnimate();
      const { user, picks, menu, row, glide } = await openByKeyboard();
      await user.keyboard('{ArrowDown}');
      expect(row('Move')).toHaveFocus();
      expect(glide.style.opacity).toBe('1');
      await user.hover(row('Delete'));
      expect(menu).toHaveFocus();
      expect(glide.style.opacity).toBe('0');
      await user.keyboard('{Enter}');
      expect(picks.Move).not.toHaveBeenCalled();
      expect(picks.Rename).not.toHaveBeenCalled();
      expect(picks.Delete).not.toHaveBeenCalled();
      await user.keyboard('{ArrowDown}');
      expect(row('Rename')).toHaveFocus(); // the arrows start again from the top
    });

    it('the pointer leaving the menu takes the focus it gave back to the menu (the highlight fades with it)', async () => {
      stubAnimate();
      const { user, picks, menu, row, glide } = await openByKeyboard();
      await user.hover(row('Move'));
      fireEvent.pointerLeave(menu);
      expect(menu).toHaveFocus();
      expect(glide.style.opacity).toBe('0');
      await user.keyboard('{Enter}');
      expect(picks.Move).not.toHaveBeenCalled();
    });

    it('a row the keyboard reached after the hover keeps focus and highlight when the pointer leaves', async () => {
      stubAnimate();
      const { user, menu, row, glide } = await openByKeyboard();
      await user.hover(row('Rename'));
      await user.keyboard('{ArrowDown}');
      fireEvent.pointerLeave(menu);
      expect(row('Move')).toHaveFocus();
      expect(glide.style.opacity).toBe('1');
      expect(glide.style.transform).toBe(`translate(0px, ${ROW_H}px)`);
    });

    it('a disabled row that has keyboard focus keeps a visible highlight', async () => {
      stubAnimate();
      const { menu, row, glide } = await openByKeyboard();
      fireEvent.keyDown(menu, { key: 'Shift' });
      act(() => { row('Delete').focus(); });
      expect(row('Delete')).toHaveFocus();
      expect(glide.style.opacity).toBe('1');
      expect(glide.style.transform).toBe(`translate(0px, ${2 * ROW_H}px)`);
    });

    it('hovering never pulls focus out of a text field in the menu (the model-picker search)', async () => {
      stubAnimate();
      const user = userEvent.setup();
      function Search() {
        const ref = useRef<HTMLButtonElement | null>(null);
        return (
          <>
            <button ref={ref} type="button">Anchor</button>
            <Popover open onClose={() => undefined} anchorRef={ref} label="Models" role="menu">
              <input type="search" aria-label="Search models" />
              <div className="kb-menu__list">
                <button type="button" role="menuitem" tabIndex={-1} className="kb-menu__item">Rename</button>
                <button type="button" role="menuitem" tabIndex={-1} className="kb-menu__item">Move</button>
              </div>
            </Popover>
          </>
        );
      }
      render(<Search />);
      const menu = await screen.findByRole('menu', { name: 'Models' });
      const field = within(menu).getByRole('searchbox', { name: 'Search models' });
      await waitFor(() => expect(field).toHaveFocus());
      await user.hover(within(menu).getByRole('menuitem', { name: 'Move' }));
      expect(field).toHaveFocus();
      await user.keyboard('gpt');
      expect(field).toHaveValue('gpt');
    });

    it('a focused row that is removed hands focus to the menu, not to the page', async () => {
      stubAnimate();
      const user = userEvent.setup();
      function Drop() {
        const ref = useRef<HTMLButtonElement | null>(null);
        const [rows, setRows] = useState(['Rename', 'Move']);
        return (
          <>
            <button ref={ref} type="button" onClick={() => setRows(['Rename'])}>drop</button>
            <Popover open onClose={() => undefined} anchorRef={ref} label="Drop" role="menu" autoFocus={false}>
              <div className="kb-menu__list">
                {rows.map((r) => <button key={r} type="button" role="menuitem" tabIndex={-1} className="kb-menu__item">{r}</button>)}
              </div>
            </Popover>
          </>
        );
      }
      render(<Drop />);
      const menu = await screen.findByRole('menu', { name: 'Drop' });
      await user.hover(within(menu).getByRole('menuitem', { name: 'Move' }));
      expect(within(menu).getByRole('menuitem', { name: 'Move' })).toHaveFocus();
      fireEvent.click(screen.getByRole('button', { name: 'drop' })); // a click without moving focus
      await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
      expect(menu).toHaveFocus();
    });
  });

  it('only menus glide: a dialog popover has no highlight', async () => {
    function Dialog() {
      const ref = useRef<HTMLButtonElement | null>(null);
      return (
        <>
          <button ref={ref} type="button">Anchor</button>
          <Popover open onClose={() => undefined} anchorRef={ref} label="Info"><p>Text</p></Popover>
        </>
      );
    }
    render(<Dialog />);
    const dialog = await screen.findByRole('dialog', { name: 'Info' });
    await act(async () => undefined);
    expect(dialog.querySelector('.kb-glide')).toBeNull();
  });
});
