import { useMemo, useRef, useState } from 'react';
import { copyToClipboard } from '../../../lib/clipboard';
import type { KbAnswerBlockPart } from '../../../api/kb/types.gen';
import { Button, Icon, IconButton, Tooltip, useCopied, useIconPlay } from '../../ui';
import { safeUrl } from '../../ui/markdown/Markdown';
import { citationRef, pageRef, useOpenDocument } from '../../state/document';
import { useBlockFix } from './blockFix';
import { BlockScopeProvider, type BlockHover } from './hover';
import { rendererOf } from './registry';
import { useSelectableBlock } from '../select/context';
import { AGENT_KEY, blockChips, type BlockChip, type BlockData, type BlockSource } from './sources';

/**
 * P1: a ready-made block of a chat answer, drawn by SKAZ from data the backend has checked (the
 * agent never supplies HTML). Look: `.dev/ui-blocks/answer-blocks-v3.html` (R1–R5). No type
 * caption (R1); one row of source chips under it (R2); the hidden-items badge only when something
 * is hidden; a block still streaming is a placeholder, a broken one says so (decision 6).
 */
export function AnswerBlock({ part }: { part: KbAnswerBlockPart }) {
  if (part.state === 'drawing') return <BlockPlaceholder id={part.id} />;
  if (part.state === 'broken' || !part.block) return <BrokenBlock part={part} />;
  return <ReadyBlock part={part} block={part.block} />;
}

function ReadyBlock({ part, block }: { part: KbAnswerBlockPart; block: BlockData }) {
  const [hover, setHover] = useState<BlockHover>(null);
  const renderer = rendererOf(block);
  const chips = useMemo(() => blockChips(part.sources, renderer.items(block)), [part.sources, renderer, block]);
  const scope = useMemo(() => ({ sources: part.sources, hover, setHover }), [part.sources, hover]);
  const { View } = renderer;
  const root = useRef<HTMLElement | null>(null);
  useSelectableBlock(root, part.id, block.title); // P2: its items can be picked (chat/select)
  const lit = (chip: BlockChip) => (hover?.from === 'item' ? hover.keys.includes(chip.key)
    : hover?.from === 'chip' && hover.key === chip.key);
  return (
    <section ref={root} className="kb-blk" aria-label={block.title ? `${renderer.name}: ${block.title}` : renderer.name}
      data-block-id={part.id} data-kind={block.kind}>
      <BlockScopeProvider value={scope}>
        {block.title && <div className="kb-blk__title">{block.title}</div>}
        <div className="kb-blk__body"><View block={block} /></div>
        <div className="kb-blk__foot" role="group" aria-label="Sources of this block">
          {chips.map((chip) => (
            <SourceChip key={chip.key} chip={chip} lit={lit(chip)}
              onHover={(on) => setHover(on ? { from: 'chip', key: chip.key } : null)} />
          ))}
          <span className="kb-blk__sp" />
          {part.hidden > 0 && <HiddenBadge count={part.hidden} />}
          {part.markdown && <CopyBlock markdown={part.markdown} />}
        </div>
      </BlockScopeProvider>
    </section>
  );
}

function SourceChip({ chip, lit, onHover }: { chip: BlockChip; lit: boolean; onHover: (on: boolean) => void }) {
  const open = useOpenDocument();
  const hover = {
    onMouseEnter: () => onHover(true), onMouseLeave: () => onHover(false),
    onFocus: () => onHover(true), onBlur: () => onHover(false),
  };
  const cls = (extra: string) => `kb-blk__chip${extra}${lit ? ' is-hl' : ''}`;
  if (chip.key === AGENT_KEY) {
    return (
      <Tooltip text="Not from your materials" placement="top">
        <span className={cls(' kb-blk__chip--agent')} role="note" tabIndex={0}
          aria-label="Agent’s knowledge: not from your materials" {...hover}>
          <Icon name="agent" size={12} /><span className="kb-blk__chip-label">{chip.label}</span>
        </span>
      </Tooltip>
    );
  }
  if (!chip.available || !chip.source) {
    return (
      <span className={cls(' is-gone')} role="note" tabIndex={0} aria-label={`${chip.label}: no longer available`} {...hover}>
        <Icon name="error" size={12} /><span className="kb-blk__chip-label">{chip.label}</span>
      </span>
    );
  }
  const source = chip.source;
  return (
    <button type="button" className={cls('')} aria-label={`Open source: ${chip.label}`}
      title={source.type === 'web' ? source.title || source.url : undefined}
      onClick={() => openSource(source, open)} {...hover}>
      <Icon name={chip.icon} size={12} /><span className="kb-blk__chip-label">{chip.label}</span>
    </button>
  );
}

function openSource(source: BlockSource, open: ReturnType<typeof useOpenDocument>): void {
  if (source.type === 'cite') open(citationRef(source.citation));
  else if (source.type === 'page') open(pageRef(source.page, source.block_id));
  else {
    // The main process hands window.open to the OS browser for http(s) only.
    const url = safeUrl(source.url);
    if (url) window.open(url, '_blank', 'noopener');
  }
}

/** R1, decisions 11–12: Copy as Markdown, bottom right, shown on hover/focus of the block. */
function CopyBlock({ markdown }: { markdown: string }) {
  const [copied, setCopied] = useCopied();
  const [play, replay] = useIconPlay();
  return (
    <IconButton className="kb-blk__copy" icon={copied ? 'check' : 'copy'} iconPlay={play} size="sm"
      label={copied ? 'Copied' : 'Copy as Markdown'} tooltipPlacement="top"
      onClick={async () => {
        const ok = await copyToClipboard(markdown);
        setCopied(ok);
        if (ok) replay();
      }} />
  );
}

function HiddenBadge({ count }: { count: number }) {
  const text = `${count} ${count === 1 ? 'item' : 'items'} hidden: invalid data, or the source wasn’t found`;
  return (
    <Tooltip text={text} placement="top">
      <span className="kb-blk__hidden" role="note" tabIndex={0} aria-label={text}>
        <Icon name="hidden" size={13} />{count}
      </span>
    </Tooltip>
  );
}

function BlockPlaceholder({ id }: { id: string }) {
  return (
    <div className="kb-blk-ghost" role="status" aria-label="Drawing a block" data-block-id={id}>
      <div className="kb-blk-ghost__cap"><Icon name="clock" size={13} />Drawing a block…</div>
      <div className="kb-blk-ghost__line" style={{ width: '72%' }} />
      <div className="kb-blk-ghost__line" style={{ width: '54%' }} />
      <div className="kb-blk-ghost__line" style={{ width: '63%' }} />
    </div>
  );
}

type FixState = { status: 'idle' | 'sending' | 'sent' } | { status: 'failed'; error: string };

function BrokenBlock({ part }: { part: KbAnswerBlockPart }) {
  const fix = useBlockFix();
  const [shown, setShown] = useState(false);
  const [asked, setAsked] = useState<FixState>({ status: 'idle' });
  const error = part.error ?? 'The block data is invalid.';
  const ask = async () => {
    if (!part.raw || asked.status === 'sending' || asked.status === 'sent') return;
    setAsked({ status: 'sending' });
    const failed = await fix(part.raw, error);
    setAsked(failed ? { status: 'failed', error: failed } : { status: 'sent' });
  };
  return (
    <div className="kb-blk-broken" role="group" aria-label="Block that couldn’t be drawn" data-block-id={part.id}>
      <div className="kb-blk-broken__row">
        <Icon name="warning" size={16} />
        <span>This block couldn’t be drawn</span>
        <span className="kb-blk__sp" />
        <IconButton icon="table" size="sm" label={shown ? 'Hide the data' : 'Show the data'} aria-expanded={shown}
          onClick={() => setShown((v) => !v)} />
        {part.raw && (
          <Button size="sm" busy={asked.status === 'sending'} disabled={asked.status === 'sent'} onClick={() => void ask()}>
            {asked.status === 'sent' ? 'Asked the agent' : 'Ask the agent to fix'}
          </Button>
        )}
      </div>
      {asked.status === 'failed' && <p className="kb-inline-error kb-inline-error--flat" role="alert">{asked.error}</p>}
      {shown && (
        <div className="kb-blk-broken__data">
          <p className="kb-blk-broken__why">{error}</p>
          {part.raw && <pre className="kb-blk-broken__raw" aria-label="Block data"><code>{part.raw}</code></pre>}
        </div>
      )}
    </div>
  );
}
