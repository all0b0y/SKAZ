import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KbApiError } from '../api/client';
import { ExploreSection } from './ExploreSection';
import { ex2Kb, roots } from './test/fixtures';

afterEach(cleanup);
describe('EX2 topic editing', () => {
  it('creates a topic by name without exposing scientific ids', async () => {
    const kb = ex2Kb();
    render(<ExploreSection clients={kb} />);
    fireEvent.click(await screen.findByRole('button', { name: 'New topic' }));
    const dialog = await screen.findByRole('dialog', { name: 'New topic' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Topic name' }), { target: { value: 'Meetings' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(kb.areas.create).toHaveBeenCalledWith({ name: 'Meetings', parent_id: null }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('navigation', { name: 'Explore breadcrumbs' })).toHaveTextContent('Meetings'));
  });

  it('renames an own topic from its menu and updates the current path', async () => {
    const kb = ex2Kb();
    render(<ExploreSection clients={kb} />);
    fireEvent.click(await screen.findByRole('button', { name: /AI agents ·/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Topic actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename topic' }));
    const dialog = await screen.findByRole('dialog', { name: 'Rename topic' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Topic name' }), { target: { value: 'Agents at work' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(kb.areas.update).toHaveBeenCalledWith('ai', { name: 'Agents at work' }));
    await waitFor(() => expect(screen.getByRole('navigation', { name: 'Explore breadcrumbs' })).toHaveTextContent('Agents at work'));
  });

  it('pins a topic in the same menu for weekly checks', async () => {
    const kb = ex2Kb();
    render(<ExploreSection clients={kb} />);
    fireEvent.click(await screen.findByRole('button', { name: /AI agents ·/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Topic actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /^Pin topic/ }));
    await waitFor(() => expect(kb.areas.update).toHaveBeenCalledWith('ai', { pinned: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Topic actions' }));
    expect(await screen.findByRole('menuitem', { name: /^Unpin topic/ })).toBeInTheDocument();
  });

  it('merges into another topic, excludes itself and descendants, and opens the destination', async () => {
    const kb = ex2Kb();
    render(<ExploreSection clients={kb} />);
    fireEvent.click(await screen.findByRole('button', { name: /AI agents ·/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Topic actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Merge into another topic…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Merge topic' });
    await within(dialog).findByRole('option', { name: 'ML' });
    expect(within(dialog).queryByRole('option', { name: 'AI agents' })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('option', { name: /Agent harnesses/ })).not.toBeInTheDocument();
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Destination topic' }), { target: { value: 'ml' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Merge' }));
    await waitFor(() => expect(kb.topics.merge).toHaveBeenCalledWith('ai', 'ml'));
    await waitFor(() => expect(screen.getByRole('navigation', { name: 'Explore breadcrumbs' })).toHaveTextContent(roots[1]!.name));
    expect(screen.getByRole('navigation', { name: 'Explore breadcrumbs' })).not.toHaveTextContent('AI agents');
  });

  it('keeps a failed edit open, preserves the name and hides raw provider detail', async () => {
    const kb = ex2Kb();
    vi.spyOn(kb.areas, 'create').mockRejectedValue(new KbApiError(503, 'provider secret', 'not_ready'));
    render(<ExploreSection clients={kb} />);
    fireEvent.click(await screen.findByRole('button', { name: 'New topic' }));
    const dialog = await screen.findByRole('dialog', { name: 'New topic' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Topic name' }), { target: { value: 'Meetings' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('not ready');
    expect(within(dialog).getByRole('textbox')).toHaveValue('Meetings');
    expect(screen.queryByText('provider secret')).not.toBeInTheDocument();
  });
});
