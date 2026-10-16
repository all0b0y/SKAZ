/**
 * Measurement, not a behaviour test: the renderer cost of ONE live poll tick
 * of useNativeTranscript, stage by stage, on real event pages of a user
 * recording at several lengths (NativeHistory.merge → parts() →
 * NativeMonologues re-render of the open part), from a warm history.
 *
 * Fixtures are pages dumped from a COPY of the user's database by
 * `.dev/perf/profile_backend.py`; they are private and never committed. Point
 * SKAZ_POLL_BENCH_DIR at them; without it this file skips.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { render } from '@testing-library/react';
import { act } from 'react';
import { describe, it } from 'vitest';
import type { NativeEventPage } from '../../api/nativeEventPages';
import { NativeHistory } from './nativeHistory';
import { NativeMonologues } from './NativeMonologues';

const DIR = process.env.SKAZ_POLL_BENCH_DIR ?? '';
const NEW_EVENTS = 5;
const minutes = DIR && existsSync(DIR)
  ? readdirSync(DIR).map(name => /^pages_(\d+)\.json$/.exec(name)?.[1]).filter((m): m is string => Boolean(m))
    .filter(m => existsSync(join(DIR, `poll_${m}.json`))).map(Number).sort((a, b) => a - b)
  : [];

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const time = (fn: () => void) => { const t0 = performance.now(); fn(); return performance.now() - t0; };

describe.skipIf(minutes.length === 0)('live poll tick cost', () => {
  const rows: string[] = [];
  for (const minute of minutes) {
    it(`minute ${minute}`, async () => {
      const pages = JSON.parse(readFileSync(join(DIR, `pages_${minute}.json`), 'utf8')) as
        Array<{ direction: 'older' | 'newer'; page: NativeEventPage }>;
      const poll = JSON.parse(readFileSync(join(DIR, `poll_${minute}.json`), 'utf8')) as NativeEventPage;
      const fresh = new Set(poll.events.map(event => event.ordinal));
      // History as the client held it one tick earlier: without the newest events.
      const build = () => {
        const history = new NativeHistory();
        for (const { direction, page } of pages) {
          history.merge({ ...page, events: page.events.filter(event => !fresh.has(event.ordinal)),
            next_after: Math.min(page.next_after, poll.next_after - NEW_EVENTS) }, direction);
        }
        return history;
      };
      const history = build();
      const previous = history.parts().at(-1)!.snapshot;
      let view: ReturnType<typeof render> | undefined;
      await act(async () => {
        view = render(<NativeMonologues snapshot={previous} segments={[]} focusSegmentId={null} />);
      });
      const merge: number[] = []; const parts: number[] = []; const react: number[] = [];
      let partCount = 0; let partTokens = 0; let totalTokens = 0;
      for (let i = 0; i < 5; i += 1) {
        // Warm history one tick earlier, exactly as the live hook holds it.
        const h = build(); h.parts();
        merge.push(time(() => h.merge(poll, 'newer')));
        let result: ReturnType<NativeHistory['parts']> = [];
        parts.push(time(() => { result = h.parts(); }));
        partCount = result.length;
        totalTokens = result.reduce((n, part) => n + (part.snapshot.final_tokens?.length ?? 0), 0);
        const last = result.at(-1)!.snapshot; partTokens = last.final_tokens?.length ?? 0;
        const t0 = performance.now();
        await act(async () => {
          view!.rerender(<NativeMonologues snapshot={last} segments={[]} focusSegmentId={null} />);
        });
        react.push(performance.now() - t0);
        await act(async () => { view!.rerender(<NativeMonologues snapshot={previous} segments={[]} focusSegmentId={null} />); });
      }
      const spans = view!.container.querySelectorAll('span').length;
      const total = median(merge) + median(parts) + median(react);
      rows.push(`| ${minute} | ${totalTokens} | ${partCount} | ${partTokens} | ${median(merge).toFixed(1)} | `
        + `${median(parts).toFixed(1)} | ${median(react).toFixed(1)} | ${spans} | ${total.toFixed(1)} |`);
      view!.unmount();
    }, 600_000);
  }
  it('report', () => {
    // eslint-disable-next-line no-console
    console.log(['| min | tokens | parts | part tokens | merge ms | parts() ms | React ms | spans | tick ms |',
      '|---|---|---|---|---|---|---|---|---|', ...rows].join('\n'));
  });
});
