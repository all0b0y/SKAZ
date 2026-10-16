import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderKb } from '../test/renderKb';
import { docWorld } from '../test/fakeBridge';
import type { UpdateState } from '../../api/bridge';
import type { KbBridge } from '../state/context';

// Main's updater is faked at the bridge: this proves the About row's honesty, not the download.
const BASE: UpdateState = {
  current: '0.2.0', phase: 'up_to_date', available: null, checkedAt: new Date().toISOString(), progress: null, error: null,
  canInstall: true, disabledReason: null,
};

function host(initial: Partial<UpdateState>) {
  let listener: ((s: UpdateState) => void) | null = null;
  let state: UpdateState = { ...BASE, ...initial };
  const bridge: Partial<KbBridge> = {
    updateState: vi.fn(async () => state),
    checkForUpdates: vi.fn(async () => state),
    prepareUpdate: vi.fn(async () => state),
    installUpdate: vi.fn(async () => true),
    onUpdateState: vi.fn((l: (s: UpdateState) => void) => { listener = l; return () => { listener = null; }; }),
  };
  return { bridge, push: (patch: Partial<UpdateState>) => { state = { ...state, ...patch }; act(() => listener?.(state)); } };
}

const openAbout = async () => {
  await screen.findByRole('navigation', { name: 'Sections' });
  fireEvent.keyDown(window, { key: ',', metaKey: true });
  const dialog = await screen.findByRole('dialog', { name: 'Settings' });
  fireEvent.click(within(dialog).getByRole('button', { name: /^About/ }));
  return within(dialog).getByRole('group', { name: 'Updates' });
};

describe('Settings → About → Updates (B20)', () => {
  it('up to date, Check now; offline is a quiet "Couldn’t check"', async () => {
    const h = host({});
    renderKb({ world: docWorld(), bridge: h.bridge });
    const row = await openAbout();
    expect(await within(row).findByText(/SKAZ 0.2.0 is up to date/)).toBeInTheDocument();
    await userEvent.setup().click(within(row).getByRole('button', { name: 'Check now' }));
    expect(h.bridge.checkForUpdates).toHaveBeenCalled();
    h.push({ phase: 'couldnt_check', error: 'Couldn’t check' });
    expect(await within(row).findByText(/Couldn’t check for updates/)).toBeInTheDocument();
    expect(within(row).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('available → Update downloads with progress → "SKAZ will close to update" → installs only on agreement', async () => {
    const user = userEvent.setup();
    const h = host({ phase: 'available', available: { version: '0.3.0', page: 'https://github.com/all0b0y/SKAZ/releases/tag/v0.3.0' } });
    renderKb({ world: docWorld(), bridge: h.bridge });
    const row = await openAbout();
    expect(await within(row).findByText(/SKAZ 0.3.0 is available \(you have 0.2.0\)/)).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: /What’s new/ })).toHaveAttribute('href', 'https://github.com/all0b0y/SKAZ/releases/tag/v0.3.0');
    await user.click(within(row).getByRole('button', { name: 'Update' }));
    expect(h.bridge.prepareUpdate).toHaveBeenCalled();
    h.push({ phase: 'downloading', progress: 0.42 });
    expect(await within(row).findByRole('progressbar', { name: 'Downloading the update' })).toHaveAttribute('aria-valuenow', '42');
    expect(within(row).queryByRole('button', { name: 'Check now' })).not.toBeInTheDocument();
    h.push({ phase: 'ready', progress: 1 });
    const ask = await screen.findByRole('dialog', { name: 'SKAZ will close to update' });
    expect(h.bridge.installUpdate).not.toHaveBeenCalled();
    await user.click(within(ask).getByRole('button', { name: 'Later' }));
    expect(h.bridge.installUpdate).not.toHaveBeenCalled();
    await user.click(within(row).getByRole('button', { name: 'Install…' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'SKAZ will close to update' })).getByRole('button', { name: 'Update and restart' }));
    await waitFor(() => expect(h.bridge.installUpdate).toHaveBeenCalledTimes(1));
  });

  it('a failed check of the download says why and offers Try again', async () => {
    const h = host({ phase: 'failed', available: { version: '0.3.0', page: 'https://github.com/all0b0y/SKAZ/releases/tag/v0.3.0' }, error: 'The checksum doesn’t match SHA256SUMS.txt. Not installing.' });
    renderKb({ world: docWorld(), bridge: h.bridge });
    const row = await openAbout();
    expect(await within(row).findByRole('alert')).toHaveTextContent('The checksum doesn’t match SHA256SUMS.txt.');
    expect(within(row).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('development build: shows the result, Update disabled with the reason', async () => {
    const h = host({ phase: 'available', available: { version: '0.3.0', page: 'https://github.com/all0b0y/SKAZ/releases/tag/v0.3.0' }, canInstall: false, disabledReason: 'Updates work in the installed app.' });
    renderKb({ world: docWorld(), bridge: h.bridge });
    const row = await openAbout();
    expect(await within(row).findByText(/SKAZ 0.3.0 is available/)).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Update' })).toBeDisabled();
    expect(within(row).getByText('Updates work in the installed app.')).toBeInTheDocument();
  });
});

describe('No placeholder rows are left (B20)', () => {
  it('every section of Settings renders live controls — no "Not connected yet"', async () => {
    renderKb({ world: docWorld(), bridge: host({}).bridge });
    await screen.findByRole('navigation', { name: 'Sections' });
    fireEvent.keyDown(window, { key: ',', metaKey: true });
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    for (const section of ['Accounts & keys', 'Models', 'Recording & speech', 'Wiki', 'Storage', 'Privacy', 'Appearance', 'About']) {
      fireEvent.click(within(dialog).getByRole('button', { name: new RegExp(`^${section}`) }));
      await within(dialog).findByRole('heading', { level: 3, name: section });
      expect(within(dialog).queryAllByText('Not connected yet'), section).toHaveLength(0);
    }
  });
});
