import { afterEach, describe, expect, it } from 'vitest';
import { auditPanes } from '../../../../scripts/paneAudit';

/**
 * The pane audit (scripts/paneAudit.ts, PANES-SPEC §2/§7) is what the Electron smoke runs on every
 * screen. FIX1 S1 made the side pane own its gutter instead of loosening the audit; this keeps a
 * check that the audit still flags a real spill out of the side pane — with jsdom boxes stubbed
 * from `data-box="left,right"` (jsdom has no layout).
 */
const realRect = Element.prototype.getBoundingClientRect;

function stubBoxes() {
  Element.prototype.getBoundingClientRect = function rect(this: Element) {
    const box = this.getAttribute('data-box');
    if (!box) return realRect.call(this);
    const [left, right] = box.split(',').map(Number) as [number, number];
    return { left, right, top: 0, bottom: 30, width: right - left, height: 30, x: left, y: 0, toJSON() {} } as DOMRect;
  };
}

function mount(html: string) {
  document.body.innerHTML = html;
  stubBoxes();
}

afterEach(() => {
  Element.prototype.getBoundingClientRect = realRect;
  document.body.innerHTML = '';
});

describe('pane audit still catches a spill out of the side pane', () => {
  it('flags the stage-5 geometry: a scroll box and a bridge 8 px past a side pane that ends at its column', () => {
    mount(`
      <section data-pane="side" data-box="52,300" style="overflow: clip">
        <div class="kb-side__scroll kb-tabhost" data-box="52,308" style="overflow-x: hidden; overflow-y: auto">
          <div class="kb-tab kb-tab--bridge" data-box="60,308"></div>
          <button class="kb-row" data-box="60,292" style="overflow: hidden"></button>
        </div>
      </section>`);
    const spills = auditPanes().filter((v) => v.kind === 'spill').map((v) => v.selector);
    expect(spills).toEqual(['div.kb-side__scroll.kb-tabhost', 'div.kb-tab.kb-tab--bridge']);
  });

  it('passes the same boxes once the pane spans its gutter, and still flags anything past it', () => {
    mount(`
      <section data-pane="side" data-box="52,308" style="overflow: clip">
        <div class="kb-side__scroll kb-tabhost" data-box="52,308" style="overflow-x: hidden; overflow-y: auto">
          <div class="kb-tab kb-tab--bridge" data-box="60,308"></div>
          <button class="kb-row" data-box="60,292" style="overflow: hidden"></button>
        </div>
        <div class="probe-spill" data-box="52,316"></div>
        <div data-overlay="" data-box="52,420"><span class="kb-rail__label" data-box="52,420"></span></div>
      </section>`);
    const out = auditPanes();
    expect(out.map((v) => [v.kind, v.selector])).toEqual([['spill', 'div.probe-spill']]);
    expect(out[0]!.pane_box).toEqual({ left: 52, right: 308 });
  });
});
