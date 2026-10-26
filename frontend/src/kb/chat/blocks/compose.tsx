import { Fragment } from 'react';
import type { KbAnswerBlockPart } from '../../../api/kb/types.gen';
import { AnswerBlock } from './AnswerBlock';
import { ArrowDown } from './glyphs';

/**
 * P1 decision 2: blocks of one answer composed — side by side (`beside`, up to 3 in a row) or under
 * each other with a labelled arrow (`link`). Only blocks that follow each other directly (nothing
 * but blank text between) are composed; anything else is drawn as before. The honest subset: an
 * arrow joins two stacked blocks (a row starts after it); a `link` inside a row is not drawn.
 */
export interface AnswerRun { kind: 'answers'; parts: KbAnswerBlockPart[] }

const MAX_BESIDE = 3;

type Composable = { kind: string; part?: unknown; pieces?: ReadonlyArray<string | number>; slots?: readonly unknown[] };

function blank(block: Composable): boolean {
  return block.kind === 'inline' && (block.slots?.length ?? 0) === 0
    && (block.pieces ?? []).every((piece) => typeof piece === 'string' && !piece.trim());
}

function answerOf(block: Composable): KbAnswerBlockPart | null {
  return block.kind === 'answer' ? (block.part as KbAnswerBlockPart) : null;
}

/** `blocks` with each composed run of answer blocks folded into one {@link AnswerRun}. */
export function composeBlocks<B extends Composable>(blocks: readonly B[]): Array<B | AnswerRun> {
  const out: Array<B | AnswerRun> = [];
  for (const block of blocks) {
    const part = answerOf(block);
    if (part && (part.beside || part.link)) {
      let at = out.length - 1;
      while (at >= 0 && blank(out[at] as Composable)) at -= 1;
      const before = at >= 0 ? out[at]! : null;
      const prev = before && before.kind === 'answers' ? (before as AnswerRun)
        : before && answerOf(before as Composable) ? { kind: 'answers' as const, parts: [answerOf(before as Composable)!] } : null;
      if (prev) {
        out.length = at; // the blank text between goes
        out.push({ kind: 'answers', parts: [...prev.parts, part] });
        continue;
      }
    }
    out.push(block);
  }
  return out;
}

/** The rows of a run: a `beside` block joins the row before it (up to 3), any other starts a row. */
export function blockRows(parts: readonly KbAnswerBlockPart[]): KbAnswerBlockPart[][] {
  const rows: KbAnswerBlockPart[][] = [];
  for (const part of parts) {
    const last = rows.at(-1);
    if (part.beside && last && last.length < MAX_BESIDE) last.push(part);
    else rows.push([part]);
  }
  return rows;
}

export function AnswerBlocks({ parts }: { parts: readonly KbAnswerBlockPart[] }) {
  return (
    <div className="kb-blk-run">
      {blockRows(parts).map((row, i) => (
        <Fragment key={row[0]!.id}>
          {i > 0 && row[0]!.link && (
            <div className="kb-blk-link" data-from={rowEnd(parts, row[0]!)} data-to={row[0]!.id}>
              <ArrowDown />{row[0]!.link}
            </div>
          )}
          {row.length === 1 ? <AnswerBlock part={row[0]!} /> : (
            <div className="kb-blk-row" data-count={row.length}>
              {row.map((part) => <AnswerBlock key={part.id} part={part} />)}
            </div>
          )}
        </Fragment>
      ))}
    </div>
  );
}

/** The block an arrow comes from: the one right before `part`. */
function rowEnd(parts: readonly KbAnswerBlockPart[], part: KbAnswerBlockPart): string | undefined {
  const at = parts.indexOf(part);
  return at > 0 ? parts[at - 1]!.id : undefined;
}
