import { expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderKb } from '../test/renderKb';
import { accountsWorld } from '../test/fixtures';

it('Install opens one progress window; background/Details/Escape do not cancel or restart it', async () => {
  const user = userEvent.setup();
  const world = accountsWorld();
  Object.assign(world.agents.agents.find((a) => a.id === 'codex')!, {
    installed: false, signed_in: false, state: 'not_installed', action: 'install', version: null,
  });
  const { fake, services } = renderKb({ world });
  await screen.findByRole('navigation', { name: 'Sections' });
  fireEvent.keyDown(window, { key: ',', metaKey: true });
  const settings = await screen.findByRole('dialog', { name: 'Settings' });
  await user.click(within(settings).getByRole('button', { name: /^Accounts & keys/ }));
  const codex = await within(settings).findByRole('group', { name: 'Codex' });
  await user.click(within(codex).getByRole('button', { name: 'Install' }));
  let progress = await screen.findByRole('dialog', { name: 'Install Codex' });
  expect(progress.querySelector('[data-stipple-globe]')).not.toBeNull();
  expect(within(progress).queryByLabelText('Install log')).toBeNull();
  expect(within(progress).getByRole('button', { name: 'Show output' })).toHaveTextContent(/^Show output · 1 line$/);
  await user.click(within(progress).getByRole('button', { name: 'Show output' }));
  expect(within(progress).getByLabelText('Install log')).toHaveTextContent('Downloading Codex');
  const id = services.agents.getState().installs.codex!.task.id;
  await user.click(within(progress).getByRole('button', { name: 'Run in background' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Install Codex' })).toBeNull());
  await user.click(within(codex).getByRole('button', { name: 'Details' }));
  progress = await screen.findByRole('dialog', { name: 'Install Codex' });
  expect(services.agents.getState().installs.codex?.task.id).toBe(id);
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Install Codex' })).toBeNull());
  expect(fake.calls.filter((c) => c.method === 'POST' && c.path === '/kb/agents/codex/install')).toHaveLength(1);
  expect(fake.calls.filter((c) => c.path.endsWith('/cancel'))).toHaveLength(0);
  await user.click(within(codex).getByRole('button', { name: 'Details' }));
  progress = await screen.findByRole('dialog', { name: 'Install Codex' });
  await user.click(within(progress).getByRole('button', { name: 'Cancel installation' }));
  await waitFor(() => expect(within(progress).getByRole('status')).toHaveTextContent('Cancelled'));
  expect(fake.calls.filter((c) => c.path === `/kb/agents/install/${id}/cancel`)).toHaveLength(1);
  act(() => services.agents.getState().closeInstallDialog());
});

it('an unresolved failed step shows documentation, not a generic installer as its actual command', async () => {
  const world = accountsWorld();
  Object.assign(world.agents.agents.find((a) => a.id === 'codex')!, {
    installed: false, signed_in: false, state: 'not_installed', action: 'install', version: null,
  });
  const { fake, services } = renderKb({ world });
  await screen.findByRole('navigation', { name: 'Sections' });
  await act(async () => { await services.agents.getState().install('codex'); });
  const id = services.agents.getState().installs.codex!.task.id;
  const task = fake.world.installTasks[id]!;
  task.state = 'failed';
  task.reason = 'The executable folder was not found.';
  task.manual_command = null;
  act(() => {
    services.agents.getState().followInstall('codex', id)();
    services.agents.setState((s) => ({ installs: { ...s.installs, codex: { task: structuredClone(task), lines: task.lines } } }));
  });
  const progress = await screen.findByRole('dialog', { name: 'Install Codex' });
  expect(within(progress).getByRole('alert')).toHaveTextContent(task.reason);
  expect(within(progress).queryByRole('button', { name: 'Copy command' })).toBeNull();
  expect(within(progress).queryByText('Run it yourself in Terminal:')).toBeNull();
  expect(within(progress).getByRole('link', { name: 'instructions' })).toHaveAttribute('href', task.install.docs_url);
});

it('a failed task keeps its exact command and output; Try again starts a new task in the same window', async () => {
  const user = userEvent.setup();
  const world = accountsWorld();
  Object.assign(world.agents.agents.find((a) => a.id === 'codex')!, {
    installed: false, signed_in: false, state: 'not_installed', action: 'install', version: null,
  });
  const { fake, services } = renderKb({ world });
  await screen.findByRole('navigation', { name: 'Sections' });
  await act(async () => { await services.agents.getState().install('codex'); });
  const first = services.agents.getState().installs.codex!.task.id;
  const task = fake.world.installTasks[first]!;
  task.state = 'failed';
  task.reason = 'The installer did not finish.';
  task.manual_command = "'/Users/me/Local Tools/npm' install -g @openai/codex";
  act(() => {
    services.agents.getState().followInstall('codex', first)();
    services.agents.setState((s) => ({ installs: { ...s.installs, codex: { task: structuredClone(task), lines: task.lines } } }));
  });
  const progress = await screen.findByRole('dialog', { name: 'Install Codex' });
  expect(within(progress).getByRole('alert')).toHaveTextContent(task.reason);
  expect(progress.querySelector('[data-stipple-globe]')).toBeNull();
  expect(within(progress).queryByLabelText('Install log')).toBeNull();
  await user.click(within(progress).getByRole('button', { name: 'Show output' }));
  expect(within(progress).getByLabelText('Install log')).toHaveTextContent(task.lines[0]!.text);
  await user.click(within(progress).getByRole('button', { name: 'Copy command' }));
  expect(await navigator.clipboard.readText()).toBe(task.manual_command);
  await user.click(within(progress).getByRole('button', { name: 'Try again' }));
  await waitFor(() => expect(services.agents.getState().installs.codex!.task.id).not.toBe(first));
  expect(screen.getAllByRole('dialog', { name: 'Install Codex' })).toHaveLength(1);
  expect(progress.querySelector('[data-stipple-globe]')).not.toBeNull();
  expect(fake.calls.filter((c) => c.method === 'POST' && c.path === '/kb/agents/codex/install')).toHaveLength(2);
  expect(fake.calls.some((c) => c.path.endsWith('/cancel'))).toBe(false);
});
