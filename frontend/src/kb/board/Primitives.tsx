import { useRef, useState, type ReactNode } from 'react';
import {
  Banner, Button, Chip, EmptyState, Icon, IconButton, Menu, Modal, Segmented, Spinner, Switch, TextField,
  type ButtonVariant, type ChipKind,
} from '../ui';
import { Toast, type ToastData } from '../ui/Toast';
import type { ForcedState } from './forceStates';
import { Section } from './Foundations';

/** Layer 2 of the design board: every primitive of `kb/ui` in every state, real components. */

type CellState = 'default' | ForcedState;

function Cell({ label, force, children }: { label: string; force?: CellState; children: ReactNode }) {
  return (
    <div className="kb-board__cell">
      <div className="kb-board__stage" data-force={force && force !== 'default' ? force : undefined}>{children}</div>
      <span className="kb-board__label">{label}</span>
    </div>
  );
}

function Row({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="kb-board__prow" data-board-row={title}>
      <h3 className="kb-board__h3">{title}</h3>
      <div className="kb-board__cells">{children}</div>
    </div>
  );
}

const FORCED: CellState[] = ['default', 'hover', 'focus', 'pressed'];
const VARIANTS: ButtonVariant[] = ['fill', 'outline', 'quiet', 'danger'];
const KINDS: ChipKind[] = ['recording', 'document', 'wiki', 'link', 'video'];
const noop = () => undefined;

export function Primitives() {
  return (
    <>
      <Section id="buttons" title="Buttons" note="hover / focus / pressed are forced copies of the real :hover / :focus-visible / :active rules.">
        {(['md', 'sm'] as const).map((size) => VARIANTS.map((variant) => (
          <Row key={`${variant}-${size}`} title={`Button ${variant} · ${size}`}>
            {FORCED.map((s) => <Cell key={s} label={s} force={s}><Button variant={variant} size={size} icon="plus">New chat</Button></Cell>)}
            <Cell label="disabled"><Button variant={variant} size={size} icon="plus" disabled>New chat</Button></Cell>
            <Cell label="busy"><Button variant={variant} size={size} busy>Saving</Button></Cell>
            <Cell label="label only"><Button variant={variant} size={size}>Continue</Button></Cell>
          </Row>
        )))}
        {(['sm', 'md', 'lg'] as const).map((size) => (
          <Row key={size} title={`IconButton · ${size}`}>
            {FORCED.map((s) => <Cell key={s} label={s} force={s}><IconButton icon="settings" label="Settings" size={size} tooltip={false} /></Cell>)}
            <Cell label="active"><IconButton icon="settings" label="Settings" size={size} tooltip={false} active /></Cell>
            <Cell label="disabled"><IconButton icon="settings" label="Settings" size={size} tooltip={false} disabled /></Cell>
          </Row>
        ))}
      </Section>

      <Section id="chips" title="Source chips" note="Shape marks a reference (accent = text colour).">
        {KINDS.map((kind) => (
          <Row key={kind} title={`Chip · ${kind}`}>
            <Cell label="static"><Chip kind={kind} label="Lecture 3 — Integrals" meta={kind === 'document' ? 'p. 31' : '08:12'} /></Cell>
            {(['default', 'hover', 'focus'] as const).map((s) => (
              <Cell key={s} label={`button · ${s}`} force={s}><Chip kind={kind} label="Lecture 3 — Integrals" meta="08:12" onClick={noop} /></Cell>
            ))}
            <Cell label="long name"><Chip kind={kind} label="A very long source name that has to be cut somewhere in the middle" onClick={noop} /></Cell>
          </Row>
        ))}
      </Section>

      <Section id="controls" title="Controls">
        {[false, true].map((on) => (
          <Row key={String(on)} title={`Switch · ${on ? 'on' : 'off'}`}>
            {(['default', 'hover', 'focus'] as const).map((s) => <Cell key={s} label={s} force={s}><Switch checked={on} onChange={noop} label="Switch" /></Cell>)}
            <Cell label="disabled"><Switch checked={on} onChange={noop} label="Switch" disabled /></Cell>
          </Row>
        ))}
        <SegmentedRow />
      </Section>

      <Section id="fields" title="Text fields">
        <Row title="TextField">
          <Cell label="empty"><TextField label="Folder name" placeholder="e.g. Calculus" /></Cell>
          <Cell label="focus" force="focus"><TextField label="Folder name" placeholder="e.g. Calculus" /></Cell>
          <Cell label="filled + hint"><TextField label="Folder name" defaultValue="Calculus" hint="Shown in the sidebar" /></Cell>
          <Cell label="error"><TextField label="Folder name" defaultValue="Calc/ulus" error="A name cannot contain “/”." /></Cell>
          <Cell label="search, hidden label"><TextField label="Search" hideLabel leading="search" placeholder="Search materials" /></Cell>
          <Cell label="disabled"><TextField label="Folder name" defaultValue="Calculus" disabled /></Cell>
        </Row>
      </Section>

      <Section id="status" title="Banners and status">
        <Row title="Banner">
          <Cell label="warning"><Banner tone="warning" title="Microphone is off.">Recording keeps working with computer sound.</Banner></Cell>
          <Cell label="progress 40 %"><Banner tone="progress" title="Downloading the model." progress={40}>You can keep working.</Banner></Cell>
          <Cell label="progress, unknown"><Banner tone="progress" title="Preparing the library.">You can keep working.</Banner></Cell>
          <Cell label="error + actions"><Banner tone="error" title="The agent stopped." actions={<Button size="sm">Try again</Button>}>Notes and search still work.</Banner></Cell>
        </Row>
        <Row title="Spinner, dots, empty states">
          <Cell label="spinner sm"><Spinner label="Loading" size="sm" /></Cell>
          <Cell label="spinner md"><Spinner label="Loading" /></Cell>
          <Cell label="dots"><span className="kb-board__inline"><span className="kb-dot kb-dot--error" /><span className="kb-dot kb-dot--warning" /><span className="kb-dot kb-dot--update" /></span></Cell>
          <Cell label="empty"><EmptyState icon="chats" title="No chats yet">Ask about a lecture or a document.</EmptyState></Cell>
          <Cell label="empty compact + field"><EmptyState icon="concept" title="No concepts" compact field>They appear after the first import.</EmptyState></Cell>
        </Row>
      </Section>

      <Section id="overlays" title="Overlays" note="Static copies use the real classes with position reset; the Live row opens the real components.">
        <Row title="Static">
          <Cell label="tooltip"><div className="kb-board__static"><div className="kb-tooltip" role="tooltip">Start recording (⌘R)</div></div></Cell>
          <Cell label="menu">
            <div className="kb-board__static">
              <div className="kb-popover kb-menu" role="menu" aria-label="Chat actions">
                <div className="kb-menu__list">
                  <button type="button" role="menuitem" className="kb-menu__item"><Icon name="pin" size={14} /><span className="kb-menu__label">Pin</span></button>
                  <div data-force="hover"><button type="button" role="menuitem" className="kb-menu__item"><Icon name="pencil" size={14} /><span className="kb-menu__label">Rename (hover)</span><span className="kb-menu__note">⌘E</span></button></div>
                  <button type="button" role="menuitem" aria-disabled="true" className="kb-menu__item"><Icon name="export" size={14} /><span className="kb-menu__label">Export</span><span className="kb-menu__note">Nothing to export</span></button>
                  <button type="button" role="menuitem" className="kb-menu__item is-danger"><Icon name="trash" size={14} /><span className="kb-menu__label">Delete</span></button>
                </div>
              </div>
            </div>
          </Cell>
          <Cell label="modal">
            <div className="kb-board__static">
              <div className="kb-modal kb-modal--narrow" role="dialog" aria-label="Rename folder">
                <header className="kb-modal__head"><h2 className="kb-modal__title">Rename folder</h2><IconButton icon="close" label="Close" tooltip={false} /></header>
                <div className="kb-modal__body"><TextField label="Name" defaultValue="Calculus" /></div>
                <div className="kb-modal__foot"><Button variant="quiet">Cancel</Button><Button variant="fill">Save</Button></div>
              </div>
            </div>
          </Cell>
          <Cell label="toasts">
            <div className="kb-board__static kb-board__stack">
              <div className="kb-toast" role="status"><Icon name="check" size={14} /><span className="kb-toast__text">Already pinned</span><button type="button" className="kb-toast__close" aria-label="Dismiss"><Icon name="close" size={12} /></button></div>
              <div className="kb-toast" role="status"><Icon name="check" size={14} /><span className="kb-toast__text">Chat deleted</span><button type="button" className="kb-toast__action">Undo</button><button type="button" className="kb-toast__close" aria-label="Dismiss"><Icon name="close" size={12} /></button></div>
              <div className="kb-toast kb-toast--problem" role="status"><Icon name="warning" size={14} /><span className="kb-toast__text">Couldn’t save the note</span><button type="button" className="kb-toast__close" aria-label="Dismiss"><Icon name="close" size={12} /></button></div>
            </div>
          </Cell>
        </Row>
        <LiveRow />
      </Section>
    </>
  );
}

function SegmentedRow() {
  const [a, setA] = useState<'system' | 'light' | 'dark'>('system');
  const [b, setB] = useState<'s' | 'm' | 'l'>('m');
  return (
    <Row title="Segmented">
      <Cell label="md"><Segmented label="Theme" value={a} onChange={setA} options={[{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} /></Cell>
      <Cell label="sm"><Segmented label="Text size" size="sm" value={b} onChange={setB} options={[{ value: 's', label: 'S' }, { value: 'm', label: 'M' }, { value: 'l', label: 'L' }]} /></Cell>
      <Cell label="disabled"><Segmented label="Theme" value="light" onChange={noop} disabled options={[{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} /></Cell>
    </Row>
  );
}

function LiveRow() {
  const [modal, setModal] = useState(false);
  const [menu, setMenu] = useState(false);
  const [toast, setToast] = useState<ToastData | null>(null);
  const anchor = useRef<HTMLButtonElement | null>(null);
  return (
    <Row title="Live">
      <Cell label="Modal"><Button onClick={() => setModal(true)}>Open modal</Button></Cell>
      <Cell label="Menu"><Button ref={anchor} onClick={() => setMenu(true)}>Open menu</Button></Cell>
      <Cell label="Toast"><Button onClick={() => setToast({ id: Date.now(), text: 'Chat deleted', tone: 'done', action: { label: 'Undo', run: noop } })}>Show toast</Button></Cell>
      <Modal open={modal} onClose={() => setModal(false)} title="Rename folder" className="kb-modal--narrow">
        <div className="kb-modal__body"><TextField label="Name" defaultValue="Calculus" /></div>
        <div className="kb-modal__foot"><Button variant="quiet" onClick={() => setModal(false)}>Cancel</Button><Button variant="fill" onClick={() => setModal(false)}>Save</Button></div>
      </Modal>
      <Menu open={menu} onClose={() => setMenu(false)} anchorRef={anchor} label="Chat actions" items={[
        { id: 'pin', label: 'Pin', icon: 'pin', onSelect: noop },
        { id: 'rename', label: 'Rename', icon: 'pencil', onSelect: noop },
        { id: 'export', label: 'Export', icon: 'export', disabled: true, note: 'Nothing to export', onSelect: noop },
        { id: 'delete', label: 'Delete', icon: 'trash', danger: true, onSelect: noop },
      ]} />
      <Toast toast={toast} onClose={() => setToast(null)} />
    </Row>
  );
}
