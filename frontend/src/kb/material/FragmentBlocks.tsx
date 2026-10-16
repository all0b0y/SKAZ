import type { ReactNode } from 'react';
import type { KbFragment } from '../../api/kb/types.gen';
import './fragmentRoles.css';

/** A list item whose text already starts with a bullet glyph (PDFs) or its number (`1.` in Markdown)
 * shows that instead of the list's own bullet. */
const BULLET_GLYPH = /^(?:[•●▪◦‣■□►➢✓✔○◆◇]|\d{1,9}[.)]\s)/;

/** Cells of one pipe-table row (`| a | b |`); escaped pipes stay in the cell. */
export function tableCells(row: string): string[] {
  const inner = row.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  return inner.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

const SEPARATOR_ROW = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/;

/** A Markdown table (QA B3): header, then rows; the text stays the fragment's own (quotes match it). */
function TableBlock({ text, attrs }: { text: string; attrs: FragmentAttrs }) {
  const { className, ...rest } = attrs;
  const rows = text.split('\n').filter((row) => !SEPARATOR_ROW.test(row.trim()));
  const [head, ...body] = rows.map(tableCells);
  return (
    <div {...rest} className={`${className} kb-mtext__table`}>
      <table>
        {head && <thead><tr>{head.map((cell, i) => <th key={i} scope="col">{cell}</th>)}</tr></thead>}
        <tbody>{body.map((cells, r) => <tr key={r}>{cells.map((cell, i) => <td key={i}>{cell}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

/** Attributes of the element holding one fragment: class, seg, quote source, target key. */
export type FragmentAttrs = { className: string } & Record<string, string | number | undefined>;

interface Props {
  fragments: readonly KbFragment[];
  attrs: (fragment: KbFragment) => FragmentAttrs;
  children: (fragment: KbFragment) => ReactNode;
}

/** The material title is the panel's h2: an article heading of level n is shown one step below it. */
function headingTag(level: number | null): 'h3' | 'h4' | 'h5' | 'h6' {
  const depth = Math.min(6, Math.max(3, (level ?? 3) + 2));
  return `h${depth}` as 'h3' | 'h4' | 'h5' | 'h6';
}

function Block({ fragment, attrs, children }: { fragment: KbFragment; attrs: FragmentAttrs; children: ReactNode }) {
  const { className, ...rest } = attrs;
  switch (fragment.role) {
    case 'heading': {
      const Tag = headingTag(fragment.level);
      return <Tag {...rest} className={`${className} kb-mtext__h kb-mtext__h--${Math.min(fragment.level ?? 3, 3)}`}>{children}</Tag>;
    }
    case 'quote':
      return <blockquote {...rest} className={`${className} kb-mtext__quote`}>{children}</blockquote>;
    case 'code':
      return <pre {...rest} className={`${className} kb-mtext__code`}><code>{children}</code></pre>;
    case 'table':
      return <TableBlock text={fragment.text} attrs={attrs} />;
    default:
      return <p {...rest} className={className}>{children}</p>;
  }
}

/**
 * Fragments shown by their role (user bug 1016-5): headings, bulleted lists (consecutive list items
 * share one list), quotes and code; the rest as paragraphs. The text is the fragment's text as is —
 * the role only chooses the element, so quoting and corrections work the same everywhere.
 */
export function FragmentBlocks({ fragments, attrs, children }: Props) {
  const out: ReactNode[] = [];
  for (let i = 0; i < fragments.length; ) {
    const fragment = fragments[i]!;
    if (fragment.role === 'list_item') {
      const items: KbFragment[] = [];
      while (i < fragments.length && fragments[i]!.role === 'list_item') items.push(fragments[i++]!);
      out.push(
        <ul key={`list-${fragment.id}`} className="kb-mtext__list">
          {items.map((item) => {
            const { className, ...rest } = attrs(item);
            const glyph = BULLET_GLYPH.test(item.text) ? ' kb-mtext__li--glyph' : '';
            return <li key={item.id} {...rest} className={`${className} kb-mtext__li${glyph}`}>{children(item)}</li>;
          })}
        </ul>,
      );
      continue;
    }
    out.push(<Block key={fragment.id} fragment={fragment} attrs={attrs(fragment)}>{children(fragment)}</Block>);
    i += 1;
  }
  return <>{out}</>;
}
