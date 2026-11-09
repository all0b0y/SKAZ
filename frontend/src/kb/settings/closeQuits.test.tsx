import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createServices, KbServicesProvider, type KbBridge } from '../state/context';
import { createFakeBridge } from '../test/fakeBridge';
import { CloseQuitsRow } from './CloseQuitsRow';
import { ROWS, searchRows } from './schema';

function renderRow(bridge: Partial<KbBridge>) {
  const fake = createFakeBridge();
  Object.assign(fake.bridge, bridge);
  const services = createServices(fake.bridge, localStorage, { capture: null });
  return render(<KbServicesProvider services={services}><CloseQuitsRow label="Closing the window quits SKAZ" /></KbServicesProvider>);
}

const toggle = () => screen.findByRole('switch', { name: 'Closing the window quits SKAZ' });

describe('Settings → Closing the window quits SKAZ (decision 3f′)', () => {
  it('is a real, findable row of the agreed name', () => {
    expect(ROWS.find((r) => r.id === 'close-quits')).toMatchObject({ label: 'Closing the window quits SKAZ' });
    for (const word of ['tray', 'menu bar', 'quit', 'close']) {
      expect(searchRows(word).map((r) => r.id)).toContain('close-quits');
    }
  });

  it('shows the state main holds: off by default', async () => {
    renderRow({ getCloseQuits: vi.fn(async () => false), setCloseQuits: vi.fn(async (on: boolean) => on) });
    expect(await toggle()).toHaveAttribute('aria-checked', 'false');
  });

  it('turning it on goes through main and shows what main answered', async () => {
    const setCloseQuits = vi.fn(async (on: boolean) => on);
    renderRow({ getCloseQuits: vi.fn(async () => false), setCloseQuits });
    await userEvent.click(await toggle());
    expect(setCloseQuits).toHaveBeenCalledWith(true);
    await waitFor(async () => expect(await toggle()).toHaveAttribute('aria-checked', 'true'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each([
    ['main refused (the setting could not be saved)', vi.fn(async () => false)],
    ['the call failed', vi.fn(async () => { throw new Error('ipc'); })],
  ])('never pretends when %s: stays off and says so', async (_name, setCloseQuits) => {
    renderRow({ getCloseQuits: vi.fn(async () => false), setCloseQuits });
    await userEvent.click(await toggle());
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t save this setting');
    expect(await toggle()).toHaveAttribute('aria-checked', 'false');
  });

  it('says so when the current state can\'t be read, instead of showing a wrong switch', async () => {
    renderRow({ getCloseQuits: vi.fn(async () => { throw new Error('ipc'); }), setCloseQuits: vi.fn(async (on: boolean) => on) });
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t read this setting');
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('outside the desktop app it is honest that there is nothing to switch', () => {
    renderRow({});
    expect(screen.getByText('Works in the SKAZ desktop app.')).toBeInTheDocument();
    expect(screen.queryByRole('switch')).toBeNull();
  });
});
