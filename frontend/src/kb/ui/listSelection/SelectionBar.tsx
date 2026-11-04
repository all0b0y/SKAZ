import { useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSelectionHeader } from './SelectionHeader';
import { SelectionFeedback } from './SelectionFeedback';
import { AnimatePresence, m } from 'motion/react';
import { Icon, type IconName } from '../Icon';
import { Menu, Popover } from '../Popover';
import { Tooltip } from '../Tooltip';
import { EXIT, SPRING_SMALL } from '../motion';
import type { RefObject } from 'react';
import type { ListSelection } from './useListSelection';

const hintUsesByKey = new Map<string, number>();

/**
 * The row's circle. Visual only (`aria-hidden`): the row itself carries `aria-selected`, and Space
 * toggles it from the keyboard. Checked shows a tick, not just a colour; a row that can't be
 * selected gets a dashed box with the reason as its title. The slot takes no room until the list
 * is selecting (F7-a); then it opens on every row of that list (styles/selection.css).
 */
export function SelectionCheckbox({ checked, reason = null, label }: { checked: boolean; reason?: string | null; label?: string }) {
  return (
    <span className="kb-selslot" data-sel-box="" aria-hidden="true" title={reason ?? label ?? (checked ? 'Deselect' : 'Select')}>
      <span className={`kb-selbox${checked ? ' is-on' : ''}${reason ? ' is-off-limits' : ''}`}>
        {checked && <Icon name="check" size={12} />}
      </span>
    </span>
  );
}

/** "Select all" in a table header: a real checkbox for assistive tech. */
export function SelectAllBox({ state, onChange }: { state: 'none' | 'some' | 'all'; onChange: (all: boolean) => void }) {
  return (
    <button type="button" role="checkbox" data-sel-keep="" aria-checked={state === 'all' ? true : state === 'some' ? 'mixed' : false}
      aria-label="Select all" className={`kb-selbox kb-selbox--all${state !== 'none' ? ' is-on' : ''}`}
      onClick={(e) => { e.stopPropagation(); onChange(state !== 'all'); }}>
      {state === 'all' && <Icon name="check" size={12} />}
      {state === 'some' && <span className="kb-selbox__dash" aria-hidden="true" />}
    </button>
  );
}

export interface SelectionAction {
  id: string;
  label: string;
  icon: IconName;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  /** Muted note after the label in ⋯ (why it is off, a count…). */
  note?: string;
  onSelect: () => void;
}

export interface SelectionSet {
  id: string;
  label: string;
  shortLabel?: string;
  ids: readonly string[];
}

/**
 * The bar of a selection (mockups lib-v1 variant A and lib-v2): "N selected", the actions, ⋯ for
 * the rest, ✕ clears (Esc too). `full` under a table — labelled buttons; `compact` in the narrow side
 * panel — icon buttons with the name and shortcut in a tooltip.
 */
export function SelectionBar({ count, selection, sets = [], hintKey, variant = 'full', actions, more = [], onClear }: {
  selection?: ListSelection;
  sets?: readonly SelectionSet[];
  /** Shared app-session hint budget; standalone examples keep their own budget. */
  hintKey?: string;
  count: number;
  variant?: 'full' | 'compact';
  actions: ReadonlyArray<SelectionAction>;
  more?: ReadonlyArray<SelectionAction>;
  onClear: () => void;
}) {
  const moreBtn = useRef<HTMLButtonElement | null>(null);
  const chooseBtn = useRef<HTMLButtonElement | null>(null);
  const [chooseMenu, setChooseMenu] = useState(false);
  const [menu, setMenu] = useState(false);
  const header = useSelectionHeader();
  const owner = useId();
  const active = count > 0 || Boolean(selection?.selecting);
  const wasActive = useRef(false);
  const localHintUses = useRef(0);
  const [hintUse, setHintUse] = useState(0);
  useLayoutEffect(() => {
    if (active && !wasActive.current) {
      const uses = (hintKey ? hintUsesByKey.get(hintKey) ?? 0 : localHintUses.current) + 1;
      if (hintKey) hintUsesByKey.set(hintKey, Math.min(4, uses));
      else localHintUses.current = Math.min(4, uses);
      setHintUse(uses <= 3 ? uses : 0);
    }
    wasActive.current = active;
  }, [active, hintKey]);
  const register = header?.setActive;
  useLayoutEffect(() => {
    register?.(owner, active);
    return () => register?.(owner, false);
  }, [register, owner, active]);
  const plain = actions.filter((a) => !a.danger);
  const danger = actions.filter((a) => a.danger);
  const available = new Set(selection?.available ?? []);
  const choices = sets.map((s) => ({ ...s, ids: [...new Set(s.ids)].filter((id) => available.has(id)) }));
  const button = (a: SelectionAction) => {
    const tip = a.shortcut ? `${a.label} ${a.shortcut}` : a.label;
    const el = (
      <button key={a.id} type="button" data-action={a.id} className={`kb-selbar__btn${a.danger ? ' is-danger' : ''}`}
        aria-label={variant === 'compact' ? a.label : undefined} aria-keyshortcuts={a.shortcut ? keyshortcuts(a.shortcut) : undefined}
        disabled={count === 0 || a.disabled} onClick={a.onSelect}>
        <Icon name={a.icon} size={14} />
        {variant === 'full' && <span>{a.label}</span>}
      </button>
    );
    return variant === 'compact' || a.shortcut ? <Tooltip key={a.id} text={tip} placement="top">{el}</Tooltip> : el;
  };
  const controls = (
    <div className="kb-selection-controls" data-active={active ? 'true' : undefined} data-sel-keep="">
      {selection && !selection.selecting && (
        <div className="kb-selection-entry" data-sel-keep="">
          <button ref={chooseBtn} type="button" aria-label="Select items" aria-haspopup="menu" aria-expanded={chooseMenu}
            onClick={() => setChooseMenu((v) => !v)}><Icon name="more" size={14} />Select</button>
          <Menu open={chooseMenu} onClose={() => setChooseMenu(false)} anchorRef={chooseBtn} label="Select items"
            items={[{ id: 'choose', label: 'Choose…', onSelect: () => selection.choose() },
              ...choices.map((s) => ({ id: s.id, label: s.label, note: String(s.ids.length), disabled: s.ids.length === 0,
                onSelect: () => selection.choose(s.ids) }))]} />
        </div>
      )}
    <div className="kb-selection-barhost" aria-hidden={!active || undefined} {...(active ? {} : { inert: '' })}>
    <AnimatePresence>
      {active && (
        <m.div key="bar" ref={selection?.controlsRef} role="toolbar" aria-label={count ? `${count} selected` : 'Choose items'}
          aria-describedby={hintUse ? `${owner}-hint` : undefined} data-sel-bar=""
          onKeyDown={(event) => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); onClear(); } }}
          className={`kb-selbar kb-selbar--${variant}`}
          initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0, transition: SPRING_SMALL }} exit={{ opacity: 0, transition: EXIT }}>
          <b className="kb-selbar__count" aria-live="polite">{count ? `${count} selected` : 'Choose items'}</b>
          {plain.map(button)}
          {more.length > 0 && (
            <>
              <Tooltip text="More actions" placement="top">
                <button ref={moreBtn} type="button" className="kb-selbar__btn" aria-label="More actions" aria-haspopup="menu"
                  aria-expanded={menu} disabled={count === 0} onClick={() => setMenu((v) => !v)}>
                  <Icon name="more" size={14} />
                </button>
              </Tooltip>
              <Menu open={menu} onClose={() => setMenu(false)} anchorRef={moreBtn} label="More actions" placement="top-end"
                items={more.map((a) => ({ id: a.id, label: a.label, icon: a.icon, danger: a.danger, disabled: a.disabled,
                  note: a.note ?? a.shortcut, onSelect: a.onSelect }))} />
            </>
          )}
          {danger.map(button)}
          <Tooltip text="Clear selection Esc" placement="top">
            <button type="button" className="kb-selbar__btn kb-selbar__btn--clear" aria-label="Clear selection" aria-keyshortcuts="Escape" onClick={onClear}>
              <Icon name="close" size={14} />
            </button>
          </Tooltip>
          {hintUse > 0 && <span id={`${owner}-hint`} className="kb-selbar__hint" data-last-use={hintUse === 3 ? 'true' : undefined}>
            <kbd aria-label="Shift">⇧</kbd> range · <kbd aria-label="Command">⌘</kbd> add · <kbd>Esc</kbd> done
          </span>}
          {selection && choices.length > 0 && (
            <div className="kb-selbar__sets" aria-label="Selection sets">
              {choices.map((s) => (
                <button key={s.id} type="button" className="kb-selset" aria-label={s.label}
                  aria-pressed={s.ids.length > 0 && s.ids.every((id) => selection.selected.has(id))}
                  disabled={s.ids.length === 0} onClick={() => selection.toggleSet(s.ids)}>
                  {s.shortLabel ?? s.label}<b>{s.ids.length}</b>
                </button>
              ))}
            </div>
          )}
        </m.div>
      )}
    </AnimatePresence>
    </div>
    </div>
  );
  return <>
    <SelectionFeedback feedback={selection?.feedback ?? null} />
    {header ? (header.host ? createPortal(controls, header.host) : null) : controls}
  </>;
}

/** "⌘⇧M" → "Meta+Shift+M" for aria-keyshortcuts. */
function keyshortcuts(s: string): string {
  const map: Record<string, string> = { '⌘': 'Meta', '⇧': 'Shift', '⌫': 'Backspace', '↩': 'Enter' };
  const parts = [...s].map((ch) => map[ch] ?? ch.toUpperCase());
  return parts.join('+');
}

const SHORTCUTS: ReadonlyArray<{ text: string; keys: string[]; needs?: 'move' | 'attach' | 'delete' | 'export' }> = [
  { text: 'Move focus', keys: ['↑', '↓'] },
  { text: 'Extend selection', keys: ['⇧↑', '⇧↓'] },
  { text: 'Select a range', keys: ['⇧ Click'] },
  { text: 'Add or remove one', keys: ['⌘ Click', 'Space'] },
  { text: 'Select all in this list', keys: ['⌘A'] },
  { text: 'Clear selection', keys: ['Esc'] },
  { text: 'Open the focused item', keys: ['↩'] },
  { text: 'Attach selection to the chat', keys: ['⌘↩'], needs: 'attach' },
  { text: 'Move to…', keys: ['⌘⇧M'], needs: 'move' },
  { text: 'Export .md', keys: ['⌘⇧E'], needs: 'export' },
  { text: 'Delete… (asks first)', keys: ['⌘⌫'], needs: 'delete' },
  { text: 'Show these shortcuts', keys: ['⌘/'] },
];

/** ⌘/ — the keys of the focused list (mockup lib-v2 «Keyboard»). */
export function ShortcutsPopover({ open, onClose, anchorRef, has }: {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  has: { move?: boolean; attach?: boolean; delete?: boolean; export?: boolean };
}) {
  return (
    <Popover open={open} onClose={onClose} anchorRef={anchorRef} label="Keyboard shortcuts" placement="bottom-start" width={330} className="kb-shortcuts">
      <h4 className="kb-shortcuts__head">Selecting with the keyboard <kbd className="kb-kbd">⌘/</kbd></h4>
      <dl className="kb-shortcuts__list">
        {SHORTCUTS.filter((s) => !s.needs || has[s.needs]).map((s) => (
          <div key={s.text} className="kb-shortcuts__row">
            <dt>{s.text}</dt>
            <dd>{s.keys.map((k) => <kbd key={k} className="kb-kbd">{k}</kbd>)}</dd>
          </div>
        ))}
      </dl>
      <p className="kb-shortcuts__note">⌘A over a list — select all in it.</p>
      <p className="kb-shortcuts__note">Other keys work in the focused list. In a text field ⌘A and ⌘⌫ keep their usual meaning.</p>
    </Popover>
  );
}
