import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import type { KbWebSearchPart } from '../../api/kb/types.gen';
import { KbServicesProvider, createServices } from '../state/context';
import { createFakeBridge } from '../test/fakeBridge';
import { WebSearchCard } from './webSearch';

const START = '2026-11-01T08:00:00Z';
const part = (extra: Partial<KbWebSearchPart> = {}): KbWebSearchPart => ({
  type: 'web_search', id: 'web-run', engine: 'claude_code', query: 'entropy', status: 'allowed',
  auto: false, reason: null, links: [], allowed_domains: [], blocked_domains: [], ...extra,
});
function view(record: KbWebSearchPart, working = true) {
  const services = createServices(createFakeBridge().bridge, null, { capture: null });
  const card = (p: KbWebSearchPart, live = working) => (
    <KbServicesProvider services={services}><WebSearchCard chatId="chat" part={p} working={live} /></KbServicesProvider>
  );
  const result = render(card(record));
  return { ...result, show: (p: KbWebSearchPart, live = working) => result.rerender(card(p, live)) };
}
afterEach(() => vi.useRealTimers());

describe('Web execution is independent of its permission', () => {
  it.each([
    [null, 'Search approved'], ['running', 'Searching the web…'], ['done', 'Searched the web'],
    ['error', 'Search failed'], ['stopped', 'Search stopped'], ['unknown', 'Search result unknown'],
    [undefined, 'Search result unknown'],
  ] as const)('%s has truthful words even with zero links', (execution, label) => {
    const { container } = view(part({ execution }));
    expect(screen.getByRole('group', { name: `${label}: entropy` })).toBeInTheDocument();
    expect(container.querySelector('[data-stipple-globe]') !== null).toBe(execution === 'running' || execution === 'done');
    if (execution === 'done') {
      expect(screen.getByText('Done', { exact: true })).toBeInTheDocument();
      expect(screen.getByText('0 links', { exact: true })).toBeInTheDocument();
    } else expect(screen.queryByText('Done', { exact: true })).toBeNull();
  });

  it('running time starts at the stored start; terminal time stays frozen after reopening', () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(START) + 2_000);
    const running = part({ execution: 'running', started_at: START });
    const { container, show } = view(running);
    expect(container.querySelector('.kb-web__time')).toHaveTextContent('2.0 s');
    act(() => { vi.advanceTimersByTime(500); });
    expect(container.querySelector('.kb-web__time')).toHaveTextContent('2.5 s');
    const globe = container.querySelector('[data-stipple-globe]');
    show({ ...running, execution: 'done', duration_ms: 2_450,
      links: [{ title: 'Example', url: 'https://example.org', site: 'example.org' }] });
    expect(container.querySelector('[data-stipple-globe]')).toBe(globe);
    expect(globe).toHaveAttribute('data-completion', 'glow');
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(container.querySelector('.kb-web__time')).toHaveTextContent('2.4 s');
    expect(container.querySelector('[data-stipple-globe]')).toHaveAttribute('data-completion', 'still');
  });

  it('legacy links do not prove success, and a finished answer cannot keep a stale spinner or time', () => {
    const { container, show } = view(part({ links: [{ title: 'Example', url: 'https://example.org', site: 'example.org' }] }));
    expect(screen.getByRole('group', { name: 'Search result unknown: entropy' })).toBeInTheDocument();
    expect(screen.queryByText('Done', { exact: true })).toBeNull();
    show(part({ execution: 'running', started_at: START, duration_ms: 5_000 }), false);
    expect(screen.getByRole('group', { name: 'Search result unknown: entropy' })).toBeInTheDocument();
    expect(container.querySelector('[data-stipple-globe], .kb-web__time')).toBeNull();
  });

  it('does not offer a broader search during execution or after an error', () => {
    const rules = { never: [], settings_never: [], only: ['example.org'], prefer: [], origin: 'chat' as const, everywhere_once: false };
    const { show } = view(part({ execution: 'running', rules }));
    expect(screen.queryByRole('button', { name: 'Search everywhere once' })).toBeNull();
    show(part({ execution: 'error', rules, execution_error: 'Web search could not be completed.' }));
    expect(screen.queryByRole('button', { name: 'Search everywhere once' })).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent('Web search could not be completed.');
    show(part({ execution: 'done', rules }));
    expect(screen.getByRole('button', { name: 'Search everywhere once' })).toBeInTheDocument();
  });
});
