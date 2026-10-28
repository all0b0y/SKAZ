import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { act, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderKb } from '../test/renderKb';
import { docWorld } from '../test/fakeBridge';
import type { MotionLevel } from '../ui/motionLevel';
import { SPOT_LIT, spotAt, spotEnter, spotLeave, spotMode } from './spotlight';

/*
 * SpotlightCard (stage 6, B9): the light follows a mouse over card surfaces only, at «full»; calm and
 * off keep a flat hover tint (CSS); touch and pen light nothing. The paint is CSS (Chromium shots in
 * motion6/build-shots/10-*); these tests pin which elements are cards and where the light is put.
 */

function card(left = 100, top = 40) {
  const host = document.createElement('ul');
  const li = document.createElement('li');
  const c = document.createElement('button');
  c.className = 'kb-spot';
  const inner = document.createElement('span');
  c.append(inner);
  li.append(c);
  host.append(li);
  document.body.append(host);
  c.getBoundingClientRect = () => ({ left, top, width: 200, height: 100, right: left + 200, bottom: top + 100, x: left, y: top, toJSON: () => ({}) });
  return { host, c, inner };
}

describe('spotAt', () => {
  it('a mouse over a card (or anything inside it) puts the light at the pointer, in the card’s px', () => {
    const { host, c, inner } = card();
    expect(spotAt(host, inner, 160, 70, 'mouse', 'follow')).toBe(c);
    expect(c.style.getPropertyValue('--kb-spot-x')).toBe('60px');
    expect(c.style.getPropertyValue('--kb-spot-y')).toBe('30px');
  });
  it('touch and pen never move it; nor calm / off (flat tint)', () => {
    const { host, c } = card();
    expect(spotAt(host, c, 160, 70, 'touch', 'follow')).toBeNull();
    expect(spotAt(host, c, 160, 70, 'pen', 'follow')).toBeNull();
    expect(spotAt(host, c, 160, 70, 'mouse', 'flat')).toBeNull();
    expect(c.style.getPropertyValue('--kb-spot-x')).toBe('');
  });
  it('only cards of this container: a plain row or a card elsewhere is ignored', () => {
    const { host } = card();
    const row = document.createElement('button');
    row.className = 'kb-row';
    host.append(row);
    expect(spotAt(host, row, 10, 10, 'mouse', 'follow')).toBeNull();
    const other = card();
    expect(spotAt(host, other.c, 10, 10, 'mouse', 'follow')).toBeNull();
  });
  it('full follows; calm and off are flat', () => {
    expect(spotMode('full')).toBe('follow');
    expect(spotMode('calm')).toBe('flat');
    expect(spotMode('off')).toBe('flat');
  });
});

async function allMaterialsCards(motion: MotionLevel) {
  const user = userEvent.setup();
  const r = renderKb({ world: docWorld(), prefs: { motion } });
  await screen.findByRole('navigation', { name: 'Sections' });
  act(() => r.services.ui.getState().showCenter('materials'));
  const all = await screen.findByRole('region', { name: 'All materials' });
  await within(all).findByRole('grid', { name: 'Materials' });
  return { ...r, user, all };
}

// FIX2 C-L7: a card lights only for a mouse — never for the sticky «hover» a pen or a touch leaves.
describe('spotEnter / spotLeave: the lit card', () => {
  it('a mouse entering a card (or anything inside it) lights it; leaving it for outside puts it out', () => {
    const { host, c, inner } = card();
    expect(spotEnter(host, inner, 'mouse')).toBe(c);
    expect(c).toHaveAttribute(SPOT_LIT);
    spotLeave(host, inner, c); // into the card itself: still lit
    expect(c).toHaveAttribute(SPOT_LIT);
    spotLeave(host, c, host);
    expect(c).not.toHaveAttribute(SPOT_LIT);
  });
  it('touch and pen never light a card, at any level', () => {
    const { host, c } = card();
    expect(spotEnter(host, c, 'touch')).toBeNull();
    expect(spotEnter(host, c, 'pen')).toBeNull();
    expect(c).not.toHaveAttribute(SPOT_LIT);
  });
  it('a row or a card of another container is never lit', () => {
    const { host } = card();
    const row = document.createElement('button');
    row.className = 'kb-row';
    host.append(row);
    expect(spotEnter(host, row, 'mouse')).toBeNull();
    const other = card();
    expect(spotEnter(host, other.c, 'mouse')).toBeNull();
    expect(other.c).not.toHaveAttribute(SPOT_LIT);
  });
  it('the CSS lights a card by that attribute only, not by :hover (sticky after a tap)', () => {
    const css = readFileSync(resolve(__dirname, '../styles/materials.css'), 'utf8');
    expect(css).not.toMatch(/\.kb-spot:hover/);
    expect(css).toContain(`.kb-spot[${SPOT_LIT}]::before`);
  });
});

describe('All materials: the cards are spotlight cards, the table rows are not', () => {
  it.each([['full', 'follow'], ['calm', 'flat'], ['off', 'flat']] as const)('%s → %s', async (motion, mode) => {
    const { user, all } = await allMaterialsCards(motion);
    expect(all.querySelectorAll('.kb-spot')).toHaveLength(0); // table: rows only
    await user.click(within(all).getByRole('radio', { name: 'Cards' }));
    const grid = within(all).getByRole('list', { name: 'Materials' });
    expect(grid).toHaveAttribute('data-spotlight', mode);
    const cards = grid.querySelectorAll('.kb-amc');
    expect(cards.length).toBeGreaterThan(0);
    cards.forEach((c) => expect(c).toHaveClass('kb-spot'));
  });

  it('in the grid a mouse lights the card under it; a touch or a pen does not', async () => {
    const { user, all } = await allMaterialsCards('calm');
    await user.click(within(all).getByRole('radio', { name: 'Cards' }));
    const [first, second] = [...within(all).getByRole('list', { name: 'Materials' }).querySelectorAll<HTMLElement>('.kb-amc')];
    fireEvent.pointerOver(first!, { pointerType: 'touch' });
    fireEvent.pointerOver(second!, { pointerType: 'pen' });
    expect(first).not.toHaveAttribute(SPOT_LIT);
    expect(second).not.toHaveAttribute(SPOT_LIT);
    fireEvent.pointerOver(first!, { pointerType: 'mouse' });
    expect(first).toHaveAttribute(SPOT_LIT);
    fireEvent.pointerOut(first!, { pointerType: 'mouse', relatedTarget: second! });
    expect(first).not.toHaveAttribute(SPOT_LIT);
  });

  it('side-panel list rows never carry the light', async () => {
    await allMaterialsCards('full');
    expect(document.querySelectorAll('.kb-row.kb-spot, [data-pane="side"] .kb-spot')).toHaveLength(0);
  });
});
