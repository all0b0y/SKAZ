import { beforeAll, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { FLOW, openAnswer, steps, timeline } from './testing';
import { diagramId } from './model';
import { readFlowchart } from './mermaid';

// P2 step 1: picking items of answer blocks and of Mermaid flowcharts, by ids (never by position).

beforeAll(() => { vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null); });

const item = (root: HTMLElement, id: string) => root.querySelector<HTMLElement>(`[data-item-id="${id}"]`)!;
const picked = (root: HTMLElement) => Array.from(root.querySelectorAll('[data-selected="true"]')).map((el) => el.getAttribute('data-item-id'));

describe('P2: picking items of an answer block', () => {
  it('a click picks and unpicks items (accent, not the hover grey); the bar over the field says what; ✕ leaves', async () => {
    const { user, chat } = await openAnswer([steps]);
    const block = within(chat).getByRole('region', { name: 'Steps: Leader election' });
    expect(within(chat).queryByRole('group', { name: 'Selection' })).toBeNull();
    await user.click(within(block).getByText('Count the microstates'));
    expect(picked(block)).toEqual(['s1']);
    const bar = within(chat).getByRole('group', { name: 'Selection' });
    expect(within(bar).getByRole('status')).toHaveTextContent('“Count the microstates W” selected');
    expect(bar).toHaveTextContent('· Leader election');
    expect(within(chat).getByRole('textbox', { name: 'Message' })).toHaveAttribute('aria-placeholder', 'Ask about the selection…');
    await user.click(within(block).getByText('Multiply by k'));
    expect(picked(block)).toEqual(['s1', 's3']);
    expect(within(bar).getByRole('status')).toHaveTextContent('2 items selected');
    // A picked item is not merely the hover highlight: its own attribute, styled in the accent.
    expect(item(block, 's1')).not.toHaveClass('is-hl');
    await user.click(within(block).getByText('Count the microstates'));
    expect(picked(block)).toEqual(['s3']);
    await user.click(within(bar).getByRole('button', { name: 'Clear selection' }));
    expect(picked(block)).toEqual([]);
    expect(within(chat).queryByRole('group', { name: 'Selection' })).toBeNull();
  });

  it('keyboard: one Tab stop per block, arrows move, Space/Enter pick, Esc clears', async () => {
    const { user, chat } = await openAnswer([steps]);
    const block = within(chat).getByRole('region', { name: 'Steps: Leader election' });
    expect([...block.querySelectorAll('[data-item-id]')].map((el) => el.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
    item(block, 's1').focus();
    await user.keyboard('{ArrowDown}');
    expect(item(block, 's2')).toHaveFocus();
    await user.keyboard(' ');
    await user.keyboard('{ArrowDown}{Enter}');
    expect(picked(block)).toEqual(['s2', 's3']);
    expect(item(block, 's3')).toHaveAttribute('tabindex', '0');
    await user.keyboard('{Escape}');
    expect(picked(block)).toEqual([]);
  });

  it('a button inside an item keeps its own job; picking in another block starts over', async () => {
    const { user, chat } = await openAnswer([steps, timeline]);
    const tl = within(chat).getByRole('region', { name: 'Timeline' });
    const st = within(chat).getByRole('region', { name: 'Steps: Leader election' });
    await user.click(within(st).getByText('Take the logarithm'));
    await user.click(within(tl).getByRole('button', { name: /Open the recording at/ }));
    expect(picked(tl)).toEqual([]);
    expect(picked(st)).toEqual(['s2']);
    await user.click(within(tl).getByText('Why a logarithm'));
    expect(picked(tl)).toEqual(['e1']);
    expect(picked(st)).toEqual([]);
  });
});

describe('P2: picking nodes and edges of a Mermaid diagram (by the source ids)', () => {
  it('reads a flowchart: ids, labels, edges with their text; other diagram types are not read', () => {
    const chart = readFlowchart(`${FLOW}\n  A & B --> E\n  %% a comment\n  classDef x fill:#f00\n  F@{ shape: rect }`)!;
    expect([...chart.nodes.values()].map((n) => [n.id, n.label])).toEqual([
      ['A', 'Timeout'], ['B', 'Candidate'], ['C', 'Majority?'], ['D', 'Leader'], ['E', '']]);
    expect(chart.edges.map((e) => `${e.from}>${e.to}:${e.label}`)).toEqual([
      'A>B:', 'B>C:votes', 'C>D:yes', 'A>E:', 'B>E:']);
    expect(readFlowchart('sequenceDiagram\n  Alice->>Bob: Hi')).toBeNull();
  });

  it('nodes and unique edges are selectable in an answer; a click on one does not open the viewer', async () => {
    const source = `${FLOW}\n  A --> B`;
    const { user, chat } = await openAnswer([{ type: 'text', text: `See:\n\n\`\`\`mermaid\n${source}\n\`\`\`\n` }]);
    const figure = await within(chat).findByRole('figure', { name: 'Diagram' });
    await waitFor(() => expect(figure.querySelector('[data-item-id="node:A"]')).not.toBeNull());
    const ids = [...figure.querySelectorAll('[data-item-id]')].map((el) => el.getAttribute('data-item-id'));
    // A→B is drawn twice: which drawing is which can't be told, so neither is offered.
    expect(ids.sort()).toEqual(['edge:B->C', 'edge:C->D', 'node:A', 'node:B', 'node:C', 'node:D']);
    const node = figure.querySelector<SVGGElement>('[data-item-id="node:C"]')!;
    expect(node).toHaveAttribute('data-item-label', 'Majority?');
    expect(node).toHaveAttribute('role', 'button');
    await user.click(node.querySelector('text') ?? node);
    expect(node).toHaveAttribute('data-selected', 'true');
    expect(node).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByTestId('diagram-viewer')).toBeNull();
    const bar = within(chat).getByRole('group', { name: 'Selection' });
    expect(within(bar).getByRole('status')).toHaveTextContent('“Majority?” selected');
    // The edge's label stands for its edge.
    await user.click(figure.querySelector('[data-item-for="edge:B->C"]')!);
    expect(figure.querySelector('[data-item-id="edge:B->C"]')).toHaveAttribute('data-selected', 'true');
    expect(within(bar).getByRole('status')).toHaveTextContent('2 items selected');
  });

  it('a sequence diagram has nothing selectable; a wiki diagram is never selectable', async () => {
    const { chat } = await openAnswer([{ type: 'text', text: 'See:\n\n```mermaid\nsequenceDiagram\n  Alice->>Bob: Hi\n```\n' }]);
    const figure = await within(chat).findByRole('figure', { name: 'Diagram' });
    await waitFor(() => expect(figure.querySelector('svg.pele')).not.toBeNull());
    expect(figure.querySelector('[data-item-id]')).toBeNull();
  });

  it('the diagram id is the same the backend computes (FNV-1a of the trimmed lines)', () => {
    expect(diagramId('flowchart LR\n  A --> B\n')).toBe(diagramId('  flowchart LR\n\nA --> B'));
    expect(diagramId('flowchart LR\n  A --> B')).toBe('mmd-ffcb5ba0');
  });
});
