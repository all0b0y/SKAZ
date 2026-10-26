import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderKb } from '../test/renderKb';
import { chatWorld } from '../test/fixtures';
import { freshMe, writeMe } from '../test/fakeMe';
import type { FakeWorld } from '../test/fakeKb';
import { ME_STORAGE_NOTE } from './MeSection';

const openMe = async (user: ReturnType<typeof userEvent.setup>) => {
  await screen.findByRole('navigation', { name: 'Sections' });
  fireEvent.keyDown(window, { key: ',', metaKey: true });
  const dialog = await screen.findByRole('dialog', { name: 'Settings' });
  await user.click(within(dialog).getByRole('button', { name: 'Me' }));
  await within(dialog).findByRole('heading', { name: 'Me', level: 3 });
  return dialog;
};
const skill = (dialog: HTMLElement, title: string) => within(within(dialog).getByRole('region', { name: 'Skills of Me' })).getByRole('group', { name: title });

/** A world whose «Я» already holds a profile and a skill of the user's own. */
function meWorld(): FakeWorld {
  const w = chatWorld();
  w.me = freshMe();
  writeMe(w, 'profile', 'Name: Anna. Studies physics at MSU.', 'user', 'Created by you');
  writeMe(w, 'profile', 'Name: Anna. Studies physics at MSU. Exam in January.', 'agent', '+ exam in January', 'c1');
  w.me.skills.push({
    id: 'sources', kind: 'skill', builtin: false, title: 'Favourite sources', description: 'Where Anna reads first', enabled: true,
    always_on: false, limit: null, versions: [],
  });
  writeMe(w, 'sources', 'Feynman lectures, then Wikipedia.', 'user', 'Created by you');
  return w;
}

describe('Settings → Me («Я», N6)', () => {
  it('lists the built-ins first with a fill bar, then the user’s skills; master switch; the honest storage line', async () => {
    const user = userEvent.setup();
    renderKb({ world: meWorld() });
    const dialog = await openMe(user);
    const list = within(dialog).getByRole('region', { name: 'Skills of Me' });
    await within(list).findByRole('group', { name: 'Profile' });
    expect(within(list).getAllByRole('group').map((g) => g.getAttribute('data-skill')))
      .toEqual(['profile', 'how-to-work', 'search', 'sources']);
    const meter = within(skill(dialog, 'Profile')).getByRole('meter', { name: 'Profile: filled' });
    expect(meter).toHaveAttribute('aria-valuetext', '52 of 1,400 characters');
    expect(skill(dialog, 'Profile')).toHaveTextContent('52 / 1,400');
    expect(within(skill(dialog, 'How to work with me')).getByRole('meter')).toHaveAttribute('aria-valuemax', '2200');
    expect(within(skill(dialog, 'Search')).queryByRole('meter')).not.toBeInTheDocument();
    expect(within(skill(dialog, 'Favourite sources')).queryByRole('meter')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('switch', { name: 'Use Me in chats' })).toBeChecked();
    expect(dialog).toHaveTextContent(ME_STORAGE_NOTE);
    expect(ME_STORAGE_NOTE).toBe('Stored encrypted on this Mac. Other apps can’t read it through SKAZ; a program that targets SKAZ under your macOS user could.');
  });

  it('the master switch and a skill’s switch are sent at once', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ world: meWorld() });
    const dialog = await openMe(user);
    const master = await within(dialog).findByRole('switch', { name: 'Use Me in chats' });
    await user.click(master);
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({ method: 'PUT', path: '/kb/me', body: { enabled: false } })));
    await waitFor(() => expect(master).not.toBeChecked());
    const profile = within(skill(dialog, 'Profile')).getByRole('switch', { name: 'Profile' });
    await user.click(profile);
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({
      method: 'PUT', path: '/kb/me/skills/profile', body: { enabled: false },
    })));
    await waitFor(() => expect(profile).not.toBeChecked());
  });

  it('opens a skill: edit the text and Save makes a version; Restore brings an older one back', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ world: meWorld() });
    const dialog = await openMe(user);
    await user.click(await within(dialog).findByRole('button', { name: 'Open Profile' }));
    const editor = await within(dialog).findByRole('region', { name: 'Profile' });
    const text = await within(editor).findByRole('textbox', { name: 'Text' });
    expect(text).toHaveValue('Name: Anna. Studies physics at MSU. Exam in January.');
    // Built-ins keep their name: no name field.
    expect(within(editor).queryByRole('textbox', { name: 'Name' })).not.toBeInTheDocument();
    const versions = within(editor).getByRole('region', { name: 'Versions' });
    await within(versions).findByRole('listitem', { name: 'Version 2' });
    expect(within(versions).getAllByRole('listitem').map((li) => li.getAttribute('aria-label'))).toEqual(['Version 2', 'Version 1']);
    expect(within(versions).getByRole('listitem', { name: 'Version 2' })).toHaveTextContent('By the agent');
    expect(within(versions).getByRole('listitem', { name: 'Version 2' })).toHaveTextContent('+ exam in January');
    expect(within(versions).getByRole('listitem', { name: 'Version 2' })).toHaveTextContent('Current');

    expect(within(editor).getByRole('button', { name: 'Save' })).toBeDisabled();
    await user.clear(text);
    await user.type(text, 'Name: Anna.');
    await user.click(within(editor).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({
      method: 'PUT', path: '/kb/me/skills/profile', body: { text: 'Name: Anna.' },
    })));
    await within(versions).findByRole('listitem', { name: 'Version 3' });
    expect(within(versions).getByRole('listitem', { name: 'Version 3' })).toHaveTextContent('By you');

    await user.click(within(versions).getByRole('button', { name: 'Restore version 1' }));
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({
      method: 'POST', path: '/kb/me/skills/profile/versions/1/restore',
    })));
    await waitFor(() => expect(text).toHaveValue('Name: Anna. Studies physics at MSU.'));
    expect(within(versions).getByRole('listitem', { name: 'Version 4' })).toHaveTextContent('Restored');

    // Back to the list: the fill bar follows the restored text.
    await user.click(within(editor).getByRole('button', { name: 'Me' }));
    expect(within(skill(dialog, 'Profile')).getByRole('meter')).toHaveAttribute('aria-valuenow', '35');
  });

  it('a text over the limit is counted and cannot be saved; the backend’s refusal is shown as is', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ world: meWorld() });
    const dialog = await openMe(user);
    await user.click(await within(dialog).findByRole('button', { name: 'Open Profile' }));
    const editor = await within(dialog).findByRole('region', { name: 'Profile' });
    const text = await within(editor).findByRole('textbox', { name: 'Text' });
    fireEvent.change(text, { target: { value: 'x'.repeat(1_405) } });
    expect(within(editor).getByRole('alert')).toHaveTextContent('1,405 / 1,400 · 5 over the limit');
    expect(within(editor).getByRole('button', { name: 'Save' })).toBeDisabled();

    fireEvent.change(text, { target: { value: 'Name: Anna, physics.' } });
    fake.world.failures['PUT /kb/me/skills/profile'] = { status: 422, detail: 'Profile is limited to 1,400 characters. Shorten it first.' };
    await user.click(within(editor).getByRole('button', { name: 'Save' }));
    expect(await within(editor).findByText('Profile is limited to 1,400 characters. Shorten it first.')).toBeInTheDocument();
    expect(fake.calls.filter((c) => c.method === 'PUT' && c.path === '/kb/me/skills/profile')).toHaveLength(1);
  });

  it('New skill: name, one line and text; it opens after Create and can be deleted (built-ins can’t)', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ world: meWorld() });
    const dialog = await openMe(user);
    await user.click(await within(dialog).findByRole('button', { name: 'New skill' }));
    const form = within(dialog).getByRole('region', { name: 'New skill' });
    expect(within(form).getByRole('button', { name: 'Create' })).toBeDisabled();
    await user.type(within(form).getByRole('textbox', { name: 'Name' }), 'Exam style');
    await user.type(within(form).getByRole('textbox', { name: /One-line description/ }), 'How Anna’s exams ask questions');
    await user.type(within(form).getByRole('textbox', { name: 'Text' }), 'Oral, one problem and two theory questions.');
    await user.click(within(form).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({
      method: 'POST', path: '/kb/me/skills',
      body: { title: 'Exam style', description: 'How Anna’s exams ask questions', text: 'Oral, one problem and two theory questions.' },
    })));
    const editor = await within(dialog).findByRole('region', { name: 'Exam style' });
    expect(within(editor).getByRole('textbox', { name: 'Name' })).toHaveValue('Exam style');

    await user.click(within(editor).getByRole('button', { name: 'Delete…' }));
    const confirm = within(editor).getByRole('group', { name: 'Delete this skill?' });
    await user.click(within(confirm).getByRole('button', { name: 'Delete skill' }));
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({ method: 'DELETE', path: '/kb/me/skills/exam-style' })));
    const list = await within(dialog).findByRole('region', { name: 'Skills of Me' });
    await waitFor(() => expect(within(list).queryByRole('group', { name: 'Exam style' })).not.toBeInTheDocument());

    await user.click(within(dialog).getByRole('button', { name: 'Open Search' }));
    const search = await within(dialog).findByRole('region', { name: 'Search' });
    await within(search).findByRole('textbox', { name: 'Text' });
    expect(within(search).queryByRole('button', { name: 'Delete…' })).not.toBeInTheDocument();
  });

  it('Settings search finds Me by memory, profile and how to work with me; Privacy says how long agent sessions live', async () => {
    const user = userEvent.setup();
    renderKb({ world: meWorld() });
    const dialog = await openMe(user);
    const find = within(dialog).getByRole('searchbox', { name: 'Find a setting' });
    for (const query of ['memory', 'profile', 'how to work with me', 'remembered']) {
      await user.clear(find);
      await user.type(find, query);
      expect(within(dialog).getByRole('group', { name: 'Use Me in chats' }), query).toBeInTheDocument();
    }
    await user.clear(find);
    await user.click(within(dialog).getByRole('button', { name: 'Privacy' }));
    const row = await within(dialog).findByRole('group', { name: 'Agent conversations' });
    expect(row).toHaveTextContent('Each agent keeps a copy of a chat’s conversation in SKAZ’s folder while the chat exists; deleting the chat deletes it.');
    expect(within(row).queryByText('Not connected yet')).not.toBeInTheDocument();
  });

  it('a backend without «Я» yet says it couldn’t read, with Try again — no dummy list', async () => {
    const user = userEvent.setup();
    renderKb({ world: { ...meWorld(), missing: ['/kb/me'] } });
    const dialog = await openMe(user);
    const list = within(dialog).getByRole('region', { name: 'Skills of Me' });
    expect(await within(list).findByRole('alert')).toHaveTextContent('Couldn’t read: Not Found');
    expect(within(list).queryByRole('group')).not.toBeInTheDocument();
  });
});
