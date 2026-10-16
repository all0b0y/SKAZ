/**
 * Geometry audit for PANES-SPEC §2/§7, run inside the page (Playwright
 * `page.evaluate(auditPanes)`): every visible element of a column lies inside
 * that column horizontally, and nothing scrolls sideways except the rows and
 * blocks that are meant to (tab rows, code, tables).
 *
 * "Visible" means: the part of the element left after every clipping ancestor
 * BELOW the column has cut it. If only the column's own `overflow: hidden` hides
 * a piece of it, that piece spills — exactly the case the user reported.
 *
 * Self-contained on purpose: Playwright serialises the function into the page.
 */
export interface PaneViolation {
  pane: string;
  kind: 'spill' | 'sideways-scroll' | 'cut' | 'squashed';
  selector: string;
  box: { left: number; right: number };
  pane_box: { left: number; right: number };
}

export function auditPanes(): PaneViolation[] {
  const ALLOWED_SCROLLERS = '.scroll-row, .md__table, .md__code, pre, .cm-scroller, .cm-md-table-wrap, table';
  const TOL = 1;
  const describe = (el: Element) => {
    const cls = typeof el.className === 'string' && el.className.trim()
      ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : '';
    const label = el.getAttribute('aria-label');
    return `${el.tagName.toLowerCase()}${cls}${label ? `[aria-label="${label.slice(0, 30)}"]` : ''}`;
  };
  const out: PaneViolation[] = [];
  for (const pane of Array.from(document.querySelectorAll<HTMLElement>('[data-pane]'))) {
    const state = pane.getAttribute('data-state');
    if (state === 'closed') continue;
    const p = pane.getBoundingClientRect();
    if (p.width < 2) continue;
    const paneBox = { left: p.left, right: p.right };
    for (const el of Array.from(pane.querySelectorAll<HTMLElement>('*'))) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || el.closest('[hidden]')) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      // Clip by every scrolling/clipping ancestor below the column.
      let left = r.left;
      let right = r.right;
      let top = r.top;
      let bottom = r.bottom;
      for (let a = el.parentElement; a && a !== pane; a = a.parentElement) {
        const acs = getComputedStyle(a);
        const ar = a.getBoundingClientRect();
        if (acs.overflowX !== 'visible') { left = Math.max(left, ar.left); right = Math.min(right, ar.right); }
        if (acs.overflowY !== 'visible') { top = Math.max(top, ar.top); bottom = Math.min(bottom, ar.bottom); }
      }
      if (right - left <= 0 || bottom - top <= 0) continue;
      if (left < p.left - TOL || right > p.right + TOL) {
        out.push({ pane: pane.dataset.pane!, kind: 'spill', selector: describe(el), box: { left, right }, pane_box: paneBox });
      }
      // Text cut away by a box that cannot scroll it back into view: past the
      // left edge (never reachable by scrolling) or past the right edge of a
      // box that does not scroll. Ellipsis is a deliberate cut and is allowed.
      const ownText = Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim());
      if (ownText && r.width > 2 && cs.textOverflow !== 'ellipsis' && !el.closest(ALLOWED_SCROLLERS)) {
        for (let a = el.parentElement; a && a !== pane; a = a.parentElement) {
          const acs = getComputedStyle(a);
          if (acs.overflowX === 'visible') continue;
          if (acs.textOverflow === 'ellipsis') break;
          const ar = a.getBoundingClientRect();
          const scrolls = acs.overflowX === 'auto' || acs.overflowX === 'scroll';
          if (r.left < ar.left - TOL || (!scrolls && r.right > ar.right + TOL)) {
            out.push({ pane: pane.dataset.pane!, kind: 'cut', selector: describe(el), box: { left: r.left, right: r.right }, pane_box: { left: ar.left, right: ar.right } });
            break;
          }
        }
      }
      if ((cs.overflowX === 'auto' || cs.overflowX === 'scroll') && el.scrollWidth > el.clientWidth + TOL
        && !el.matches(ALLOWED_SCROLLERS)) {
        out.push({ pane: pane.dataset.pane!, kind: 'sideways-scroll', selector: describe(el), box: { left: r.left, right: r.right }, pane_box: paneBox });
      }
      // A table squeezed into its column one letter per line: a wide table must
      // keep readable cells and scroll inside its own wrapper instead (§3).
      // Squashed = a word of the cell had to be broken inside a letter run.
      if (el.tagName === 'TD' || el.tagName === 'TH') {
        const range = document.createRange();
        range.selectNodeContents(el);
        const lines = new Set(Array.from(range.getClientRects()).map((line) => Math.round(line.top)));
        const words = (el.textContent ?? '').trim().split(/\s+/).filter(Boolean).length;
        if (lines.size > words + 1) {
          out.push({ pane: pane.dataset.pane!, kind: 'squashed', selector: describe(el.closest('table') ?? el), box: { left: r.left, right: r.right }, pane_box: paneBox });
        }
      }
    }
  }
  // One entry per selector keeps the report readable.
  const seen = new Set<string>();
  return out.filter((v) => {
    const key = `${v.pane}|${v.kind}|${v.selector}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
