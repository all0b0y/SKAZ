import { describe, expect, it } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderKb } from '../test/renderKb';
import { chatWorld } from '../test/fixtures';
import type { FakeWorld } from '../test/fakeKb';

type Call = { method: string; path: string; body?: unknown };
const sent = (calls: Call[]) => calls.filter((c) => c.method === 'POST' && /\/messages$/.test(c.path));
const GROUP = 'Quick questions about the recording';

async function setup(world: FakeWorld = chatWorld()) {
  const user = userEvent.setup();
  const r = renderKb({ world });
  await within(screen.getByRole('region', { name: 'Chats' })).findByRole('region', { name: 'Pinned' });
  const input = screen.getByTestId('message-input');
  const record = (phase: 'recording' | 'paused' | 'idle') => act(() => {
    r.services.recording.setState({ phase, materialId: phase === 'idle' ? null : 'm1', title: 'Lecture 8 — entropy' });
  });
  return { ...r, user, input, record };
}

describe('Quick questions while recording (v39 rec)', () => {
  it('three chips over the message field, only while a recording runs', async () => {
    const { record } = await setup();
    expect(screen.queryByRole('group', { name: GROUP })).not.toBeInTheDocument();
    record('recording');
    const group = await screen.findByRole('group', { name: GROUP });
    expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual(['What did I miss?', 'Explain a term', 'Summary so far']);
    // Over the field, not inside it.
    expect(screen.getByTestId('composer').contains(group)).toBe(false);
    expect(group.compareDocumentPosition(screen.getByTestId('composer')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    record('paused');
    expect(screen.queryByRole('group', { name: GROUP })).not.toBeInTheDocument();
    record('recording');
    await screen.findByRole('group', { name: GROUP });
    record('idle');
    expect(screen.queryByRole('group', { name: GROUP })).not.toBeInTheDocument();
  });

  it('"What did I miss?" goes to the chat at once with the recording attached — its id only, no live text', async () => {
    const world = chatWorld();
    const { user, record, fake, input } = await setup(world);
    record('recording');
    await user.click(within(await screen.findByRole('group', { name: GROUP })).getByRole('button', { name: 'What did I miss?' }));
    await waitFor(() => expect(sent(fake.calls)).toHaveLength(1));
    const body = sent(fake.calls)[0]!.body as Record<string, unknown>;
    expect(body).toMatchObject({ text: 'What did I miss?', mentions: [], quotes: [], attachments: ['m1'] });
    expect(Object.keys(body).sort()).toEqual(['attachments', 'context', 'mentions', 'quotes', 'text']);
    expect(input.textContent).toBe(''); // the field is left as it was
  });

  it('"Summary so far" asks for a summary with the recording attached; typed text stays in the field', async () => {
    const { user, record, fake, input } = await setup();
    await user.click(within(screen.getByRole('region', { name: 'Chats' })).getByRole('button', { name: /Why is there a logarithm/ }));
    record('recording');
    await user.click(input);
    await user.keyboard('my draft');
    await user.click(within(await screen.findByRole('group', { name: GROUP })).getByRole('button', { name: 'Summary so far' }));
    await waitFor(() => expect(sent(fake.calls)).toHaveLength(1));
    expect(sent(fake.calls)[0]).toMatchObject({ path: '/kb/chats/c1/messages', body: { text: 'Summarise the recording so far.', attachments: ['m1'] } });
    expect(input.textContent).toBe('my draft');
  });

  it('"Explain a term" puts "Explain the term: " in the focused field with the recording attached; nothing is sent', async () => {
    const { user, record, fake, input } = await setup();
    record('recording');
    await user.click(within(await screen.findByRole('group', { name: GROUP })).getByRole('button', { name: 'Explain a term' }));
    expect(input.textContent).toBe('Explain the term: ');
    expect(input).toHaveFocus();
    const chips = screen.getByRole('list', { name: 'Attachments' });
    expect(within(chips).getByText('Lecture 8 — entropy')).toBeInTheDocument();
    await user.keyboard('entropy{Enter}');
    await waitFor(() => expect(sent(fake.calls)).toHaveLength(1));
    expect(sent(fake.calls)[0]!.body).toMatchObject({ text: 'Explain the term: entropy', attachments: ['m1'] });
    // A second click does not attach the recording twice.
    await user.click(within(screen.getByRole('group', { name: GROUP })).getByRole('button', { name: 'Explain a term' }));
    await user.click(within(screen.getByRole('group', { name: GROUP })).getByRole('button', { name: 'Explain a term' }));
    expect(within(screen.getByRole('list', { name: 'Attachments' })).getAllByText('Lecture 8 — entropy')).toHaveLength(1);
  });

  it('an unavailable agent disables the chips with its reason; nothing goes to another agent', async () => {
    const world = chatWorld();
    const agent = world.agents.agents.find((a) => a.id === world.agents.default)!;
    agent.state = 'signed_out';
    agent.reason = 'Sign in again.';
    const { user, record, fake, input } = await setup(world);
    record('recording');
    const group = await screen.findByRole('group', { name: GROUP });
    const reason = `${agent.name} can’t answer now: Sign in again.`;
    for (const chip of within(group).getAllByRole('button')) {
      expect(chip).toHaveAttribute('aria-disabled', 'true');
      expect(chip).toHaveAccessibleDescription(reason);
    }
    const missed = within(group).getByRole('button', { name: 'What did I miss?' });
    await user.hover(missed);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(reason);
    await user.click(missed);
    await user.click(within(group).getByRole('button', { name: 'Explain a term' }));
    expect(sent(fake.calls)).toHaveLength(0);
    expect(fake.calls.some((c) => c.method === 'PATCH')).toBe(false);
    expect(input.textContent).toBe('');
  });
});
