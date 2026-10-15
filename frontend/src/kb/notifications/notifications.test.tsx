import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderKb } from '../test/renderKb';
import { chatWorld } from '../test/fixtures';
import { openTarget } from '../state/document';

const openFeed = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(await screen.findByRole('button', { name: /^Notifications/ }));
  return screen.findByRole('region', { name: 'Notifications' });
};

describe('Notification feed', () => {
  it('the bell counts unread; opening the feed reads it', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ world: chatWorld() });
    const bell = await screen.findByRole('button', { name: 'Notifications, 5 unread' });
    expect(bell).toHaveTextContent('5');
    await openFeed(user);
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({ method: 'POST', path: '/kb/notifications/read', body: { up_to_seq: 7 } })));
    await waitFor(() => expect(screen.getByRole('button', { name: /^Notifications/ })).toHaveAccessibleName('Notifications'));
  });

  it('by day; "Decide" shows only what waits for a decision; unknown kinds are ordinary items; nothing opens by itself', async () => {
    const user = userEvent.setup();
    renderKb({ world: chatWorld() });
    const feed = await openFeed(user);
    expect(await within(feed).findByRole('region', { name: 'Today' })).toBeInTheDocument();
    expect(within(feed).getByRole('region', { name: 'Yesterday' })).toHaveTextContent('Textbook added to the wiki');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(within(feed).getByRole('radio', { name: 'Decide, 4' }));
    await waitFor(() => expect(within(feed).queryByText('Notes ready')).not.toBeInTheDocument());
    expect(within(feed).getByText('Sources disagree in “Entropy”')).toBeInTheDocument();
  });

  it('dismiss removes an item; a quick action decides in place', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ world: chatWorld() });
    const feed = await openFeed(user);
    await user.click(await within(feed).findByRole('button', { name: 'Dismiss “Notes ready”' }));
    await waitFor(() => expect(within(feed).queryByText('Notes ready')).not.toBeInTheDocument());
    const row = within(feed).getByText('Couldn’t open a link').closest('li') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({ path: '/kb/notifications/n3/resolve', body: { action: 'retry', text: null } })));
    await waitFor(() => expect(within(row).getByText('Retry')).toBeInTheDocument());
  });

  it('a notification without a decision opens its subject on the right', async () => {
    const user = userEvent.setup();
    const { services } = renderKb({ world: chatWorld() });
    const feed = await openFeed(user);
    await user.click(await within(feed).findByRole('button', { name: /^New connection across 3 folders/ }));
    expect(openTarget(services.ui.getState())).toMatchObject({ type: 'page', id: 'p-entropy' });
  });
});

describe('Decision window', () => {
  it('discrepancy: two quotes with sources, the explanation, four actions; ‹ › walks the queue; deciding moves on', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ world: chatWorld() });
    const feed = await openFeed(user);
    await user.click(await within(feed).findByRole('button', { name: 'Needs a decision: Sources disagree in “Entropy”' }));
    const dialog = await screen.findByRole('dialog', { name: 'Sources disagree in “Entropy”' });
    expect(within(dialog).getByText('1 of 4')).toBeInTheDocument();
    expect(within(dialog).getByText('“Entropy is a measure of the disorder of a system”')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Recording: Lecture 8 — entropy, 08:12' })).toBeInTheDocument();
    expect(within(dialog).getByText(/two sides of one concept/)).toBeInTheDocument();
    expect(within(dialog).getAllByRole('button').map((b) => b.textContent).filter((t) => /Keep both|Correct in|My own note/.test(t ?? ''))).toHaveLength(4);

    await user.click(within(dialog).getByRole('button', { name: 'Next decision' }));
    expect(await screen.findByRole('dialog', { name: '2 doubtful corrections' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Previous decision' }));
    const again = await screen.findByRole('dialog', { name: 'Sources disagree in “Entropy”' });
    await user.click(within(again).getByRole('button', { name: 'Keep both' }));
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({ path: '/kb/notifications/n1/resolve', body: { action: 'keep_both', text: null } })));
    expect(await screen.findByRole('dialog', { name: '2 doubtful corrections' })).toBeInTheDocument();
  });

  it('"My own note" asks for the text before deciding', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ world: chatWorld() });
    const feed = await openFeed(user);
    await user.click(await within(feed).findByRole('button', { name: 'Needs a decision: Sources disagree in “Entropy”' }));
    const dialog = await screen.findByRole('dialog', { name: 'Sources disagree in “Entropy”' });
    await user.click(within(dialog).getByRole('button', { name: 'My own note' }));
    await user.type(within(dialog).getByRole('textbox', { name: 'My own note' }), 'Both are right in their field.');
    await user.click(within(dialog).getByRole('button', { name: 'Save note' }));
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({
      path: '/kb/notifications/n1/resolve', body: { action: 'own_note', text: 'Both are right in their field.' },
    })));
  });

  it('doubtful corrections: was → becomes with confidence; accept or keep each; Open transcript navigates', async () => {
    const user = userEvent.setup();
    const { fake, services } = renderKb({ world: chatWorld() });
    const feed = await openFeed(user);
    await user.click(await within(feed).findByRole('button', { name: 'Needs a decision: 2 doubtful corrections' }));
    const dialog = await screen.findByRole('dialog', { name: '2 doubtful corrections' });
    expect(await within(dialog).findByText('confidence 54%')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('was: Boltzmann-Adar')).toBeInTheDocument();
    await user.click(within(dialog).getAllByRole('button', { name: 'Accept' })[0]!);
    await waitFor(() => expect(fake.calls.some((c) => c.path === '/kb/corrections/k1/accept')).toBe(true));
    expect(await within(dialog).findByText('Accepted')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Keep as it was' }));
    await waitFor(() => expect(fake.calls.some((c) => c.path === '/kb/corrections/k2/keep')).toBe(true));
    expect(within(dialog).getByRole('button', { name: 'Accept all' })).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Open transcript' }));
    expect(openTarget(services.ui.getState())).toMatchObject({ type: 'material', id: 'm1' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '2 doubtful corrections' })).not.toBeInTheDocument());
  });

  it('link failure: Fix address prefills the URL and sends the new one', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ world: chatWorld() });
    const feed = await openFeed(user);
    await user.click(await within(feed).findByRole('button', { name: 'Needs a decision: Couldn’t open a link' }));
    const dialog = await screen.findByRole('dialog', { name: 'Couldn’t open a link' });
    expect(within(dialog).getByText('https://habr.com/ru/articles/870112/')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Delete material' })).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Fix address' }));
    const field = within(dialog).getByLabelText('Correct address');
    expect(field).toHaveValue('https://habr.com/ru/articles/870112/');
    await user.clear(field);
    await user.type(field, 'https://habr.com/ru/articles/870113/');
    await user.click(within(dialog).getByRole('button', { name: 'Use this address' }));
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({
      path: '/kb/notifications/n3/resolve', body: { action: 'fix_url', text: 'https://habr.com/ru/articles/870113/' },
    })));
  });

  it('excluded instruction: the found text, where, and "Not an instruction, restore"', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ world: chatWorld() });
    const feed = await openFeed(user);
    await user.click(await within(feed).findByRole('button', { name: /Needs a decision: Instruction for AI found/ }));
    const dialog = await screen.findByRole('dialog', { name: /Instruction for AI found/ });
    expect(within(dialog).getByText('paragraph 4')).toBeInTheDocument();
    expect(within(dialog).getByText(/Ignore previous instructions/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Not an instruction, restore' }));
    await waitFor(() => expect(fake.calls.some((c) => c.method === 'POST' && c.path === '/kb/materials/m4/excluded/4/restore')).toBe(true));
    expect(await within(dialog).findByText(/Restored/)).toBeInTheDocument();
  });

  it('"Ask the agent about this" starts a new chat with the subject as a reference', async () => {
    const user = userEvent.setup();
    renderKb({ world: chatWorld() });
    const feed = await openFeed(user);
    await user.click(await within(feed).findByRole('button', { name: 'Needs a decision: Sources disagree in “Entropy”' }));
    const dialog = await screen.findByRole('dialog', { name: 'Sources disagree in “Entropy”' });
    await user.click(within(dialog).getByRole('button', { name: 'Ask the agent about this' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const input = screen.getByTestId('message-input');
    await waitFor(() => expect(input.querySelector('.kb-token--mention')).toHaveTextContent('Entropy'));
    expect(input).toHaveTextContent(/Sources disagree/);
  });
});
