/**
 * Shows hover / focus / pressed states side by side on the design board. CSS cannot force a
 * pseudo-class from script, so every rule that uses one is copied with the pseudo-class removed and
 * scoped to a board cell: `.kb-btn:hover` → `[data-force~="hover"] .kb-btn`. The copies live in one
 * extra <style> of the board page only; the app never loads this module.
 */

export type ForcedState = 'hover' | 'focus' | 'pressed';

const PSEUDO: Record<ForcedState, string[]> = {
  hover: [':hover'],
  focus: [':focus-visible', ':focus-within'],
  pressed: [':active'],
};
const STATES = Object.keys(PSEUDO) as ForcedState[];

/** Split a selector list at commas that are not inside parentheses. */
export function splitSelectorList(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i += 1) {
    const ch = list[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === ',' && depth === 0) {
      out.push(list.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(list.slice(start).trim());
  return out.filter(Boolean);
}

/** The pseudo-classes as whole tokens (`:focus` must not match `:focus-within`). */
function pseudoRe(state: ForcedState): RegExp {
  const alts = PSEUDO[state].map((p) => p.replace(/[-:]/g, (m) => `\\${m}`)).join('|');
  return new RegExp(`(?:${alts})(?![\\w-])`, 'g');
}

/** A leading compound that sits above the board cell: the tokens' `html`, `:root`, `:where(html…)`. */
const LEAD = /^((?:html|:root|:where\(html[^)]*\))[^\s>+~]*)\s*(.*)$/;

/** The scoped copy of `selectorText` for `state`, or null when no part of the list uses that state. */
export function forcedSelector(selectorText: string, state: ForcedState): string | null {
  const re = pseudoRe(state);
  const scope = `[data-force~="${state}"]`;
  const parts = splitSelectorList(selectorText)
    .filter((sel) => { re.lastIndex = 0; return re.test(sel); })
    .map((sel) => {
      // A pseudo-class standing alone (`html :focus-visible`, the global focus ring) means «the control
      // itself»: the cell's own button/input/link — not a wrapper such as a text field's label box.
      const bare = sel
        .replace(new RegExp(`(^|[\\s>+~])${re.source}`, 'g'), '$1\u0000')
        .replace(re, '')
        .replace(/\s+/g, ' ')
        .trim();
      const lead = LEAD.exec(bare);
      const [head, rest] = lead ? [lead[1]!, lead[2]!] : ['', bare];
      const tail = rest === '\u0000' ? `${scope} > :is(button, input, a)` : `${scope} ${rest.replace(/\u0000/g, '*')}`;
      return `${head} ${tail}`.trim();
    });
  return parts.length ? parts.join(', ') : null;
}

function collect(rules: CSSRuleList, wrap: (body: string) => string, out: string[]): void {
  for (const rule of Array.from(rules)) {
    if (rule instanceof CSSStyleRule) {
      for (const state of STATES) {
        const sel = forcedSelector(rule.selectorText, state);
        if (sel) out.push(wrap(`${sel} { ${rule.style.cssText} }`));
      }
    } else if (rule instanceof CSSMediaRule) {
      const cond = rule.conditionText;
      collect(rule.cssRules, (body) => wrap(`@media ${cond} { ${body} }`), out);
    } else if (rule instanceof CSSSupportsRule) {
      const cond = rule.conditionText;
      collect(rule.cssRules, (body) => wrap(`@supports ${cond} { ${body} }`), out);
    }
  }
}

const STYLE_ID = 'kb-board-forced-states';

/** (Re)build the forced-state copies from every stylesheet currently on the page. */
export function installForcedStates(doc: Document = document): number {
  const out: string[] = [];
  for (const sheet of Array.from(doc.styleSheets)) {
    if ((sheet.ownerNode as Element | null)?.id === STYLE_ID) continue;
    let rules: CSSRuleList;
    try { rules = sheet.cssRules; } catch { continue; }
    collect(rules, (body) => body, out);
  }
  let style = doc.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = doc.createElement('style');
    style.id = STYLE_ID;
    doc.head.appendChild(style);
  }
  style.textContent = out.join('\n');
  return out.length;
}
