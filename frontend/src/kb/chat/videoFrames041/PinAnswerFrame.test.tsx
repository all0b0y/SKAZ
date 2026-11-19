import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import type { JsonResponse } from '../../../api/bridge';
import { KbApp } from '../../KbApp';
import { createServices } from '../../state/context';
import { PREFS_KEY } from '../../state/prefs';
import { createFakeBridge } from '../../test/fakeBridge';
import { chatWorld } from '../../test/fixtures';

it.each(['allowed', 'expired'] as const)('pins only the selected answer frame (%s)', async (outcome) => {
  localStorage.clear();
  localStorage.setItem(PREFS_KEY, JSON.stringify({ onboardingDone: true }));
  const world = chatWorld();
  const chat = world.chats.find((item) => item.id === 'c1')!;
  const answer = chat.messages.find((item) => item.role === 'assistant')!;
  answer.parts.unshift({ type: 'text', text: 'A frame shows the result. [Video frame at 00:11.000](https://vimeo.com/11111111#t=11s)\n\n' });
  const { bridge } = createFakeBridge(world);
  const request = bridge.request.bind(bridge);
  const writes: string[] = [];
  const common = { message_id: answer.id, material_id: 'mat-report', label: 'Lecture', pinned: false };
  const frames = [
    { ...common, frame_id: 'vis-one', timestamp_ms: 11_000 },
    { ...common, frame_id: 'vis-two', timestamp_ms: 11_120 },
  ];
  bridge.request = async <T = unknown>(req: Parameters<typeof request>[0]): Promise<JsonResponse<T>> => {
    if (req.method === 'GET' && req.path.endsWith('/answer-frames')) {
      const items = req.path === '/kb/chats/c1/answer-frames' ? frames : [];
      return { ok: true, status: 200, data: items as T };
    }
    if (req.method === 'POST' && req.path.endsWith('/pin')) {
      writes.push(req.path);
      expect(req.body).toBeUndefined();
      return outcome === 'expired'
        ? { ok: false, status: 409, detail: 'This frame is no longer available to pin.', code: 'FRAME_EXPIRED' }
        : { ok: true, status: 200, data: { ...frames[1], pinned: true } as T };
    }
    return request<T>(req);
  };
  const services = createServices(bridge, localStorage, { capture: null });
  render(<KbApp services={services} />);
  const user = userEvent.setup();
  const chats = screen.getByRole('region', { name: 'Chats' });
  await user.click(await within(chats).findByRole('button', { name: /Why is there a logarithm/ }));
  const displayed = within(await screen.findByRole('article', { name: 'Answer' }));
  expect(displayed.getByRole('link', { name: 'Video frame at 00:11.000' }))
    .toHaveAttribute('href', 'https://vimeo.com/11111111#t=11s');
  const first = await displayed.findByRole('button', { name: 'Pin frame at 00:11.000 from Lecture' });
  const second = displayed.getByRole('button', { name: 'Pin frame at 00:11.120 from Lecture' });
  expect(writes).toEqual([]);
  await user.click(second);
  expect(writes).toEqual([`/kb/chats/c1/messages/${answer.id}/frames/vis-two/pin`]);
  if (outcome === 'allowed') {
    expect(await displayed.findByText('Frame pinned')).toBeVisible();
  } else {
    expect(await displayed.findByRole('alert')).toHaveTextContent('This frame is no longer available to pin.');
  }
  expect(first).toBeEnabled();
  await user.click(within(chats).getByRole('button', { name: /Transformer paper review/ }));
  expect(screen.queryByRole('button', { name: /Pin frame/ })).toBeNull();
  expect(writes).toHaveLength(1);
});
