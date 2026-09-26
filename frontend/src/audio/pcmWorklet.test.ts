import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

// Runs the real public/pcm-worklet.js inside a minimal AudioWorkletGlobalScope
// stand-in: the processor class, its port and the render quantum are the only
// browser pieces. No audio device, no speech — this checks PCM framing only.
const source = readFileSync(resolve(__dirname, '../../public/pcm-worklet.js'), 'utf8');
type Message = Float32Array | { type: 'barrier'; id: number };

function load(sampleRate = 48_000) {
  const posted: Message[] = [];
  let Processor!: new () => { process(inputs: Float32Array[][]): boolean; port: { onmessage: ((e: { data: unknown }) => void) | null } };
  class AudioWorkletProcessor {
    port = { onmessage: null as ((e: { data: unknown }) => void) | null,
      postMessage: (data: Message) => { posted.push(data); } };
  }
  runInNewContext(source, {
    AudioWorkletProcessor, sampleRate, Float32Array,
    registerProcessor: (_name: string, cls: typeof Processor) => { Processor = cls; },
  });
  const node = new Processor();
  let next = 0;
  // The engine reuses one 128-sample buffer for every render quantum.
  const quantum = new Float32Array(128);
  const render = (count = 1) => {
    for (let i = 0; i < count; i += 1) {
      for (let s = 0; s < 128; s += 1) quantum[s] = (next++ % 1000) / 1000;
      expect(node.process([[quantum]])).toBe(true);
    }
  };
  const barrier = (id: number) => node.port.onmessage?.({ data: { type: 'barrier', id } });
  const pcm = () => posted.filter((m): m is Float32Array => m instanceof Float32Array);
  const joined = () => pcm().flatMap(frame => Array.from(frame));
  const expected = () => Array.from({ length: next }, (_, i) => Math.fround((i % 1000) / 1000));
  return { render, barrier, posted, pcm, joined, expected };
}

describe('pcm-worklet framing', () => {
  it('posts ~20 ms batches instead of one message per 128-sample render quantum', () => {
    const worklet = load(48_000);
    worklet.render(375); // one second at 48 kHz
    // 48 000 samples in 960-sample (20 ms) batches; the partial remainder waits.
    expect(worklet.pcm().length).toBeLessThanOrEqual(50);
    expect(worklet.pcm().every(frame => frame.length === 960)).toBe(true);
  });

  it('keeps every sample in order across batches despite the reused engine buffer', () => {
    const worklet = load(48_000);
    worklet.render(40);
    worklet.barrier(1);
    expect(worklet.joined()).toEqual(worklet.expected());
  });

  it('flushes the partial batch before acknowledging a barrier', () => {
    const worklet = load(48_000);
    worklet.render(3); // 384 samples: below one batch
    expect(worklet.pcm()).toHaveLength(0);
    worklet.barrier(7);
    expect(worklet.posted.at(-2)).toBeInstanceOf(Float32Array);
    expect((worklet.posted.at(-2) as Float32Array).length).toBe(384);
    expect(worklet.posted.at(-1)).toEqual({ type: 'barrier', id: 7 });
    expect(worklet.joined()).toEqual(worklet.expected());
  });

  it('acknowledges a barrier with nothing pending without posting empty PCM', () => {
    const worklet = load(48_000);
    worklet.barrier(2);
    expect(worklet.posted).toEqual([{ type: 'barrier', id: 2 }]);
  });
});
