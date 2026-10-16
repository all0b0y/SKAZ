import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderKb } from '../test/renderKb';
import { docWorld } from '../test/fakeBridge';

describe('Graph of connections (v4/v5)', () => {
  it('opens wide on the right from the side panel, with counts, legend and the selected node card', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ world: docWorld(), prefs: { section: 'graph' } });
    await user.click(await screen.findByRole('button', { name: 'Open the graph' }));
    const panel = await screen.findByRole('complementary', { name: 'Graph of connections' });
    expect(panel).toHaveAttribute('data-view', 'graph');
    expect(await within(panel).findByText('22 concepts · 4 folders')).toBeInTheDocument();
    const canvas = within(panel).getByRole('img', { name: /Graph of 22 pages and 29 links/ });
    expect(within(panel).getByText(/rings — concept in several folders/)).toBeInTheDocument();
    expect(within(panel).getByText(/dashed — link across folders/)).toBeInTheDocument();
    // The busiest hub is selected first; the card shows its folders and sources.
    expect(within(panel).getByText('Entropy', { selector: 'b' })).toBeInTheDocument();
    expect(within(panel).getByText('10 connections')).toBeInTheDocument();
    expect(await within(panel).findByRole('button', { name: 'Recording: Lecture 8 — entropy, 08:12' })).toBeInTheDocument();
    // Keyboard: arrows choose, Enter opens the page.
    fireEvent.keyDown(canvas, { key: 'ArrowRight' });
    await waitFor(() => expect(within(panel).queryByText('Entropy', { selector: 'b' })).not.toBeInTheDocument());
    fireEvent.keyDown(canvas, { key: 'ArrowLeft' });
    expect(await within(panel).findByText('Entropy', { selector: 'b' })).toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: 'Open page' }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Entropy' })).toBeInTheDocument();
    expect(fake.calls.filter((c) => c.path === '/kb/graph')).toHaveLength(1);
  });

  it('filters by folder and says so when there is nothing yet', async () => {
    const user = userEvent.setup();
    const { services, fake } = renderKb({ world: docWorld() });
    await screen.findByRole('navigation', { name: 'Sections' });
    services.ui.getState().openGraph();
    const panel = await screen.findByRole('complementary', { name: 'Graph of connections' });
    await within(panel).findByText('22 concepts · 4 folders');
    await user.selectOptions(within(panel).getByRole('combobox', { name: 'Folder' }), 'math');
    expect(await within(panel).findByText('4 concepts · 1 folder')).toBeInTheDocument();
    fake.world.graph = { nodes: [], edges: [] };
    await user.selectOptions(within(panel).getByRole('combobox', { name: 'Folder' }), '');
    expect(await within(panel).findByText('No connections yet')).toBeInTheDocument();
  });

  it('"Show the graph" from a page selects that page; the count names every kind of node drawn (QA C22, C6)', async () => {
    const world = docWorld();
    world.graph.nodes.push({ id: 'p-note8', kind: 'note', title: 'Notes: Lecture 8 — entropy', folder_ids: ['phys'], degree: 0, hub: false });
    const { services } = renderKb({ world });
    await screen.findByRole('navigation', { name: 'Sections' });
    services.ui.getState().openGraph('g-second');
    const panel = await screen.findByRole('complementary', { name: 'Graph of connections' });
    expect(await within(panel).findByText('Second law', { selector: 'b' })).toBeInTheDocument();
    expect(within(panel).getByText('22 concepts · 1 other page · 4 folders')).toBeInTheDocument();
    services.ui.getState().openGraph('g-temp');
    expect(await within(panel).findByText('Temperature', { selector: 'b' })).toBeInTheDocument();
  });
});
