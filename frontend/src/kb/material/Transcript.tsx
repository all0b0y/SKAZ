import { useRef, useState } from 'react';
import type { KbCorrection, KbCorrectionChange, KbFragment, KbMaterial } from '../../api/kb/types.gen';
import { errorText } from '../api/client';
import { Button, Icon, Popover } from '../ui';
import { formatTime } from '../library/materialMeta';
import { plural } from '../document/text';
import { useServices } from '../state/context';
import { byPage, monologues, segmentText, speakerTone, translationBySeg, type TextPiece } from './segments';
import { quoteAttrs } from '../ui/Selection';

export type TranscriptView = 'original' | 'translation' | 'both';

const STATE_TEXT: Record<KbCorrection['state'], string> = {
  applied: 'Fixed',
  doubtful: 'Possible recognition error',
  reverted: 'Fix reverted',
  kept: 'Kept as recognised',
};

/** Was → became, confidence, and the actions this state allows (§2.1). */
/** One literal per action, so the routes the interface calls can be listed (IPC policy test). */
const CORRECTION_ROUTE = {
  revert: 'POST /kb/corrections/{correction_id}/revert',
  accept: 'POST /kb/corrections/{correction_id}/accept',
  keep: 'POST /kb/corrections/{correction_id}/keep',
  reapply: 'POST /kb/corrections/{correction_id}/reapply',
} as const;

function CorrectionCard({ fix, onChanged, close }: {
  fix: KbCorrection;
  onChanged: (change: KbCorrectionChange) => void;
  close: () => void;
}) {
  const { client } = useServices();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const act = async (action: 'revert' | 'accept' | 'keep' | 'reapply') => {
    setBusy(action);
    setError(null);
    try {
      onChanged(await client.call(CORRECTION_ROUTE[action], { path: { correction_id: fix.id } }));
      close();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };
  const confidence = fix.confidence !== null ? ` · confidence ${Math.round(fix.confidence * 100)}%` : '';
  return (
    <div className="kb-fixcard">
      <p className="kb-fixcard__head">{fix.auto && fix.state === 'applied' ? 'Fixed automatically' : STATE_TEXT[fix.state]}{confidence}</p>
      <p className="kb-fixcard__diff"><del>{fix.before}</del><span aria-hidden="true"> → </span><span className="kb-visually-hidden"> became </span><ins>{fix.after}</ins></p>
      {fix.reason && <p className="kb-fixcard__reason">{fix.reason}</p>}
      <div className="kb-fixcard__actions">
        {fix.state === 'applied' && (
          <>
            <Button size="sm" variant="outline" icon="check" onClick={close}>Keep</Button>
            <Button size="sm" variant="quiet" icon="retry" busy={busy === 'revert'} onClick={() => void act('revert')}>Revert</Button>
          </>
        )}
        {fix.state === 'doubtful' && (
          <>
            <Button size="sm" variant="fill" icon="check" busy={busy === 'accept'} onClick={() => void act('accept')}>Accept fix</Button>
            <Button size="sm" variant="quiet" busy={busy === 'keep'} onClick={() => void act('keep')}>Keep as recognised</Button>
          </>
        )}
        {fix.state === 'reverted' && (
          <Button size="sm" variant="outline" icon="retry" busy={busy === 'reapply'} onClick={() => void act('reapply')}>Apply the fix again</Button>
        )}
      </div>
      {error && <p className="kb-inline-error" role="alert">{error}</p>}
    </div>
  );
}

function FixMark({ piece, onChanged }: { piece: TextPiece & { fix: KbCorrection }; onChanged: (c: KbCorrectionChange) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement | null>(null);
  const tone = piece.fix.state === 'doubtful' ? 'doubtful' : piece.fix.state === 'reverted' ? 'reverted' : 'auto';
  return (
    <>
      <button ref={ref} type="button" className={`kb-fix kb-fix--${tone}${piece.quote ? ' is-quote' : ''}${open ? ' is-open' : ''}`}
        data-fix={piece.fix.id} aria-haspopup="dialog" aria-expanded={open}
        aria-label={`${piece.text} — ${STATE_TEXT[piece.fix.state].toLowerCase()}: ${piece.fix.before} → ${piece.fix.after}`}
        onClick={() => setOpen((v) => !v)}>
        {piece.text}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={ref} label="Recognition fix" width={280}>
        <CorrectionCard fix={piece.fix} onChanged={onChanged} close={() => setOpen(false)} />
      </Popover>
    </>
  );
}

function Pieces({ pieces, onChanged }: { pieces: TextPiece[]; onChanged: (c: KbCorrectionChange) => void }) {
  return (
    <>
      {pieces.map((p, i) => {
        if (p.fix) return <FixMark key={i} piece={p as TextPiece & { fix: KbCorrection }} onChanged={onChanged} />;
        if (p.quote) return <mark key={i} className="kb-quote">{p.text}</mark>;
        return <span key={i}>{p.text}</span>;
      })}
    </>
  );
}

export interface TranscriptProps {
  material: KbMaterial;
  corrections: KbCorrection[];
  view: TranscriptView;
  /** Both side by side (only in the expanded panel). */
  sideBySide: boolean;
  target: { seg: number | null; quote: string | null };
  onCorrectionChanged: (change: KbCorrectionChange) => void;
  /** Segments the guard left out as instructions to an AI (decision 41): shown in place, marked. */
  excluded?: ReadonlySet<number>;
  /**
   * Live panel: speech after the fragments — final words of monologues not in the material yet
   * (stable, but not quotable: they have no fragment yet) and the words still being recognised (grey).
   */
  live?: LiveSpeech;
}

export interface LiveSpeech {
  monologues: ReadonlyArray<{ speaker: string | null; start_ms: number; text: string }>;
  partial: { speaker: string | null; text: string } | null;
}

interface LiveBlock { key: string; speaker: string | null; startMs: number | null; final: string[]; partial: string }

/**
 * Live speech laid out like the material lays out fragments (`monologues`): words of the speaker of
 * the last block continue that block, another speaker starts a new one. So when the open monologue
 * closes and becomes a fragment, nothing on screen moves. Undiarised speech (no speaker) always
 * starts a block of its own, as undiarised fragments do; grey words without a speaker yet continue
 * the last block.
 */
function liveBlocks(live: LiveSpeech | undefined, lastSpeaker: string | null | undefined): { last: LiveBlock; blocks: LiveBlock[] } {
  const last: LiveBlock = { key: 'last', speaker: lastSpeaker ?? null, startMs: null, final: [], partial: '' };
  const blocks: LiveBlock[] = [];
  if (!live) return { last, blocks };
  const current = () => blocks[blocks.length - 1] ?? (lastSpeaker !== undefined ? last : null);
  for (const m of live.monologues) {
    const block = current();
    if (block && m.speaker !== null && block.speaker === m.speaker) block.final.push(m.text);
    else blocks.push({ key: `live-${m.start_ms}`, speaker: m.speaker, startMs: m.start_ms, final: [m.text], partial: '' });
  }
  if (live.partial) {
    const block = current();
    if (block && (live.partial.speaker === null || block.speaker === live.partial.speaker)) block.partial = live.partial.text;
    else blocks.push({ key: 'live-partial', speaker: live.partial.speaker, startMs: null, final: [], partial: live.partial.text });
  }
  return { last, blocks };
}

function LiveWords({ block }: { block: LiveBlock }) {
  return (
    <>
      {block.final.map((text, i) => <span key={i} className="kb-live-final">{text} </span>)}
      {block.partial && <span className="kb-tail">{block.partial}</span>}
    </>
  );
}

/**
 * The mark of an excluded fragment: it stays where it was in the text, quiet and labelled, so the
 * reader sees what the wiki left out. Not offered for quoting into a chat (it is an instruction).
 */
function ExcludedTag() {
  return (
    <span className="kb-xtag">
      <Icon name="privacy" size={12} />
      <span>Excluded · instruction to an AI</span>
    </span>
  );
}

const isExcluded = (props: TranscriptProps, seg: number) => props.excluded?.has(seg) ?? false;

/** Original fragment text with fixes underlined and the target quote marked. */
function FragmentText({ fragment, props }: { fragment: KbFragment; props: TranscriptProps }) {
  const fixes = props.corrections.filter((c) => fragment.corrections.includes(c.id) || c.seg === fragment.seg);
  const quote = props.target.seg === fragment.seg ? props.target.quote : null;
  return <Pieces pieces={segmentText(fragment.text, quote, fixes)} onChanged={props.onCorrectionChanged} />;
}

function FragmentSpan({ fragment, props, translation }: { fragment: KbFragment; props: TranscriptProps; translation: Map<number, string> | null }) {
  const translated = translation?.get(fragment.seg);
  const showOriginal = props.view !== 'translation' || !translation;
  const showTranslation = props.view !== 'original' && translation !== null;
  const targeted = props.target.seg === fragment.seg;
  if (isExcluded(props, fragment.seg)) {
    return (
      <span className={`kb-seg-frag kb-excluded${targeted ? ' is-target' : ''}`} data-seg={fragment.seg} data-target-key={`seg-${fragment.seg}`} data-excluded="">
        <ExcludedTag />
        {showOriginal ? <FragmentText fragment={fragment} props={props} /> : (translated ?? fragment.text)}{' '}
      </span>
    );
  }
  return (
    <span className={`kb-seg-frag${targeted ? ' is-target' : ''}`} data-seg={fragment.seg} data-target-key={`seg-${fragment.seg}`}>
      {showOriginal && (
        <span className="kb-seg-frag__orig" {...quoteAttrs({ source: 'material', id: props.material.id, seg: fragment.seg })}>
          <FragmentText fragment={fragment} props={props} />{' '}
        </span>
      )}
      {showTranslation && !showOriginal && <span className="kb-seg-frag__tr">{translated ?? fragment.text} </span>}
    </span>
  );
}

/** Speech: monologues "Speaker N · time"; translation by fragment or as paragraphs. */
function SpeechText(props: TranscriptProps) {
  const { material, view, sideBySide } = props;
  const translation = translationBySeg(material.translation);
  const paragraphs = material.translation && !translation ? material.translation.fragments : null;
  const groups = monologues(material.fragments);
  const paragraphMode = paragraphs !== null && view !== 'original';
  const live = liveBlocks(props.live, groups.length ? groups[groups.length - 1]!.speaker : undefined);

  const originalColumn = (
    <div className="kb-spk-list">
      {groups.map((g, index) => (
        <div key={g.key} className="kb-spk">
          <div className="kb-spk__head">
            {g.speaker && <span className="kb-spk__speaker" style={{ color: speakerTone(g.speaker) }}>{g.speaker}</span>}
            {g.startMs !== null && <span className="kb-spk__time">{formatTime(g.startMs)}</span>}
          </div>
          <p className="kb-spk__text">
            {g.fragments.map((f) => (
              <FragmentSpan key={f.id} fragment={f} props={{ ...props, view: paragraphMode ? 'original' : view === 'both' && sideBySide ? 'original' : view }}
                translation={paragraphMode ? null : translation} />
            ))}
            {index === groups.length - 1 && <LiveWords block={live.last} />}
          </p>
          {view === 'both' && !sideBySide && translation && (
            <p className="kb-spk__text kb-spk__text--tr">
              {g.fragments.map((f) => translation.get(f.seg)).filter(Boolean).join(' ')}
            </p>
          )}
        </div>
      ))}
      {live.blocks.map((b) => (
        <div key={b.key} className="kb-spk kb-spk--live">
          {(b.speaker || b.startMs !== null) && (
            <div className="kb-spk__head">
              {b.speaker && <span className="kb-spk__speaker" style={{ color: speakerTone(b.speaker) }}>{b.speaker}</span>}
              {b.startMs !== null && <span className="kb-spk__time">{formatTime(b.startMs)}</span>}
            </div>
          )}
          <p className="kb-spk__text"><LiveWords block={b} /></p>
        </div>
      ))}
    </div>
  );

  if (paragraphMode) {
    const translated = (
      <div className="kb-tr-paras" lang={material.translation!.language ?? undefined}>
        {paragraphs.map((p, i) => <p key={i} className="kb-spk__text">{p.text}</p>)}
      </div>
    );
    if (view === 'translation') return translated;
    return (
      <div className={sideBySide ? 'kb-two' : 'kb-stack'}>
        <div><h3 className="kb-colhead">Original</h3>{originalColumn}</div>
        <div><h3 className="kb-colhead">Translation</h3>{translated}</div>
      </div>
    );
  }
  if (view === 'both' && sideBySide && translation) {
    return (
      <div className="kb-spk-list">
        {groups.map((g) => (
          <div key={g.key} className="kb-spk">
            <div className="kb-spk__head">
              {g.speaker && <span className="kb-spk__speaker" style={{ color: speakerTone(g.speaker) }}>{g.speaker}</span>}
              {g.startMs !== null && <span className="kb-spk__time">{formatTime(g.startMs)}</span>}
            </div>
            <div className="kb-two">
              <p className="kb-spk__text">
                {g.fragments.map((f) => <FragmentSpan key={f.id} fragment={f} props={{ ...props, view: 'original' }} translation={translation} />)}
              </p>
              <p className="kb-spk__text kb-spk__text--tr">{g.fragments.map((f) => translation.get(f.seg)).filter(Boolean).join(' ')}</p>
            </div>
          </div>
        ))}
      </div>
    );
  }
  return originalColumn;
}

/** One paragraph of a text or a PDF page; an excluded one keeps its place, marked. */
function Paragraph({ fragment: f, props }: { fragment: KbFragment; props: TranscriptProps }) {
  const target = props.target.seg === f.seg ? ' is-target' : '';
  if (isExcluded(props, f.seg)) {
    return (
      <p className={`kb-mtext__p kb-excluded${target}`} data-seg={f.seg} data-target-key={`seg-${f.seg}`} data-excluded="">
        <ExcludedTag />
        <FragmentText fragment={f} props={props} />
      </p>
    );
  }
  return (
    <p className={`kb-mtext__p${target}`} data-seg={f.seg} data-target-key={`seg-${f.seg}`}
      {...quoteAttrs({ source: 'material', id: props.material.id, seg: f.seg })}>
      <FragmentText fragment={f} props={props} />
    </p>
  );
}

function PlainText(props: TranscriptProps) {
  return (
    <div className="kb-mtext">
      {props.material.fragments.map((f) => <Paragraph key={f.id} fragment={f} props={props} />)}
    </div>
  );
}

function PdfPages(props: TranscriptProps) {
  return (
    <div className="kb-pdf">
      {byPage(props.material.fragments).map((page, i) => (
        <section key={`${page.page}-${i}`} className="kb-pdfpage" aria-label={page.page !== null ? `Page ${page.page}` : 'Page'}>
          {page.page !== null && <span className="kb-pdfpage__n">p. {page.page}</span>}
          {page.fragments.map((f) => <Paragraph key={f.id} fragment={f} props={props} />)}
        </section>
      ))}
    </div>
  );
}

const SPEECH = new Set(['recording', 'audio', 'video', 'video_link']);

export function Transcript(props: TranscriptProps) {
  if (SPEECH.has(props.material.kind)) return <SpeechText {...props} />;
  if (props.material.kind === 'pdf' || props.material.kind === 'book') return <PdfPages {...props} />;
  return <PlainText {...props} />;
}

export function changeNote(change: KbCorrectionChange): string {
  if (change.affected_blocks === 0) return 'Saved. No wiki statement relied on these words.';
  return `Saved. ${plural(change.affected_blocks, 'wiki statement')} updated${change.job ? '; the rest is being refreshed' : ''}.`;
}
