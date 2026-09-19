/**
 * Baseline measurement, not a behaviour test: how long one live poll's React
 * work costs for a real long-recording payload. jsdom is slower than Chromium,
 * so treat the absolute numbers as an upper bound — the ratio that matters is
 * mount vs re-render, and how both scale with recording length.
 *
 * The fixtures are multi-megabyte snapshots of a real user session and are
 * deliberately NOT committed. Regenerate them locally with the profiling
 * script described in docs/BASELINE-PROFILE.md, or point SKAZ_BENCH_DIR at a
 * directory holding `snap_<session>_<minute>.json` files. Without them this
 * file skips instead of failing, so CI stays green.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { render } from '@testing-library/react';
import { act } from 'react';
import { describe, it } from 'vitest';
import { NativeMonologues } from './NativeMonologues';
import type { NativeSnapshot } from '../../api/nativeLive';

const BENCH_DIR = process.env.SKAZ_BENCH_DIR ?? '/tmp/skaz_baseline';

const fixtures = existsSync(BENCH_DIR)
  ? readdirSync(BENCH_DIR)
      .filter((name) => /^snap_.+_\d+\.json$/.test(name))
      .sort((a, b) => Number(a.match(/_(\d+)\.json$/)![1]) - Number(b.match(/_(\d+)\.json$/)![1]))
      .map((name) => ({ label: `minute ${name.match(/_(\d+)\.json$/)![1]}`, path: join(BENCH_DIR, name) }))
  : [];

describe.skipIf(fixtures.length === 0)('NativeMonologues live-poll cost', () => {
  for (const { label, path } of fixtures) {
    it(label, async () => {
      const snapshot = JSON.parse(readFileSync(path, 'utf8')) as NativeSnapshot;
      let view: ReturnType<typeof render> | undefined;
      // Time the whole act() call: React commits as act exits, so a timer
      // inside the callback would measure nothing.
      const mountStart = performance.now();
      await act(async () => {
        view = render(
          <NativeMonologues snapshot={snapshot} segments={[]} focusSegmentId={null} />,
        );
      });
      const mountMs = performance.now() - mountStart;
      // A live poll hands React a NEW snapshot object holding the same content,
      // exactly as useNativeTranscript's setRead does every second.
      const rerenders: number[] = [];
      for (let i = 0; i < 3; i += 1) {
        const t0 = performance.now();
        await act(async () => {
          view!.rerender(
            <NativeMonologues
              snapshot={{ ...snapshot }}
              segments={[]}
              focusSegmentId={null}
            />,
          );
        });
        rerenders.push(performance.now() - t0);
      }
      const spans = view!.container.querySelectorAll('span').length;
      const median = rerenders.sort((a, b) => a - b)[1]!;
      // eslint-disable-next-line no-console
      console.log(
        `${label}: mount ${mountMs.toFixed(0)} ms · re-render per poll ${median.toFixed(0)} ms · DOM spans ${spans}`,
      );
      view!.unmount();
    }, 600_000);
  }
});
