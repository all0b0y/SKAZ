import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { chatWorld, docWorld } from '../../test/fixtures';
import { renderKb } from '../../test/renderKb';

const reader = () => within(screen.getByRole('complementary', { name: 'Document' }));
const chat = () => within(screen.getByRole('region', { name: 'Chat' }));
const conversation = () => chat().getByRole('log', { name: 'Conversation' });
const sourceName = 'Source 1: Lecture 5';

async function openFromChat(user: ReturnType<typeof userEvent.setup>, source: HTMLElement) {
  act(() => source.focus());
  await user.keyboard('{Enter}');
  const jump = await screen.findByRole('button', { name: /^Open at fragment/ });
  await waitFor(() => expect(jump).toHaveFocus());
  await user.keyboard('{Enter}');
  await reader().findByRole('heading', { name: 'Lecture 5 — classifiers' });
}

async function closeReader(user: ReturnType<typeof userEvent.setup>) {
  reader().getByRole('button', { name: 'Close document' }).focus();
  await user.keyboard('{Enter}');
  expect(screen.queryByRole('complementary', { name: 'Document' })).toBeNull();
}

it('returns keyboard focus to the original chat citation after closing the expanded reader', async () => {
  const user = userEvent.setup();
  renderKb({ world: chatWorld() });
  await user.click(await screen.findByRole('button', { name: /Why is there a logarithm/ }));
  const source = (await chat().findAllByRole('button', { name: sourceName }))[0]!;
  await openFromChat(user, source);
  await user.click(reader().getByRole('button', { name: 'Expand to the centre' }));
  await closeReader(user);
  expect(source).toBeVisible();
  expect(source).toHaveFocus();
  expect(source).toHaveAttribute('aria-expanded', 'false');
});

it('uses the active tab when the Sources-row trigger was unmounted', async () => {
  const user = userEvent.setup();
  renderKb({ world: chatWorld() });
  await user.click(await screen.findByRole('button', { name: /Why is there a logarithm/ }));
  const fold = await chat().findByRole('button', { name: /^Sources · / });
  await user.click(fold);
  const source = within(chat().getByRole('group', { name: 'Sources' })).getByRole('button', { name: sourceName });
  await openFromChat(user, source);
  await user.click(fold);
  expect(source).not.toBeInTheDocument();
  await closeReader(user);
  expect(chat().getByRole('tab', { selected: true })).toHaveFocus();
});

it('keeps the new active tab and its draft when closing a reader opened from another chat', async () => {
  const user = userEvent.setup();
  const { services } = renderKb({ world: chatWorld() });
  await user.click(await screen.findByRole('button', { name: /Why is there a logarithm/ }));
  const source = (await chat().findAllByRole('button', { name: sourceName }))[0]!;
  await openFromChat(user, source);
  await user.click(await screen.findByRole('button', { name: /Transformer paper review/ }));
  await chat().findByRole('tab', { name: /Transformer paper review/, selected: true });
  const draft = chat().getByRole('textbox', { name: 'Message' });
  await user.type(draft, 'Draft in the second chat');
  const activeChat = services.chats.getState().currentId;
  await closeReader(user);
  expect(services.chats.getState().currentId).toBe(activeChat);
  expect(chat().getByRole('tab', { name: /Transformer paper review/, selected: true })).toHaveFocus();
  expect(draft).toHaveTextContent('Draft in the second chat');
});

const lead = 'Open entropy from the index';
const alias = 'Another link to entropy';
const link = (label: string) => '[[Concepts/entropy|' + label + ']]';

it.each(['reordered', 'removed', 'focus moved'] as const)('returns from the Wiki index with its initiating link %s', async (scenario) => {
  const world = { ...docWorld(), chats: chatWorld().chats };
  world.wikiFiles = {
    index: {
      text: '# Index\n\n' + link(lead) + '\n\n' + link(alias),
      links: [{ target: 'Concepts/entropy', page: { id: 'p-entropy', title: 'Entropy', kind: 'concept' }, material_id: null }],
    },
  };
  const user = userEvent.setup();
  const { fake, services } = renderKb({ world });
  await user.click(await screen.findByRole('button', { name: /Why is there a logarithm/ }));
  await waitFor(() => expect(conversation()).toHaveAttribute('tabindex', '0'));
  act(() => services.ui.getState().openWikiFile('index'));
  const from = await reader().findByRole('button', { name: lead });
  from.focus();
  await user.keyboard('{Enter}');
  await reader().findByRole('heading', { name: 'Entropy' });

  fake.world.wikiFiles!.index!.text = '# Index\n\n' + link(alias) + (scenario === 'removed' ? '' : '\n\n' + link(lead));
  const reply = fake.requestMock.getMockImplementation()!;
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  fake.requestMock.mockImplementation(async (request) => {
    if (request.path === '/kb/wiki/files/index') await gate;
    return reply(request);
  });
  reader().getByRole('button', { name: 'Back' }).focus();
  await user.keyboard('{Enter}');
  expect(screen.getByRole('complementary', { name: 'Document' })).toHaveFocus();
  if (scenario === 'focus moved') act(() => conversation().focus());
  await act(async () => { finish(); });

  const heading = await reader().findByRole('heading', { name: 'Index' });
  expect(from).not.toBeInTheDocument();
  if (scenario === 'removed') expect(heading).toHaveFocus();
  else if (scenario === 'focus moved') expect(conversation()).toHaveFocus();
  else expect(reader().getByRole('button', { name: lead })).toHaveFocus();
});
