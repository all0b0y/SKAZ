// AudioWorklet processor: forwards mono Float32 PCM to the main thread.
// Served from the app origin (public/) so it loads under CSP script-src 'self'
// rather than as a blocked data: URL. Standalone module — no imports. The main
// thread accumulates these frames into fixed windows (chunker.ts) and encodes
// each as a standalone PCM16 WAV.
//
// Render quanta are 128 samples, ~375 per second at 48 kHz. Posting each one
// woke the renderer's main thread that often during recording; frames are
// batched to ~20 ms instead. Latency stays far below the 100 ms chunk window,
// and the level meter aggregates 300 ms anyway. A barrier flushes the partial
// batch first, so pause/stop never lose the tail.
const BATCH_SECONDS = 0.02;

class PcmForwarder extends AudioWorkletProcessor {
  constructor() {
    super();
    // `sampleRate` is a global of AudioWorkletGlobalScope.
    this.batch = new Float32Array(Math.max(128, Math.round(sampleRate * BATCH_SECONDS)));
    this.filled = 0;
    this.port.onmessage = (event) => {
      if (event.data && event.data.type === 'barrier') {
        // MessagePort preserves ordering. The main thread disconnects the
        // source before requesting this barrier, so every preceding PCM frame
        // — including the partial batch flushed here — is delivered before
        // the acknowledgement.
        this.flush();
        this.port.postMessage({ type: 'barrier', id: event.data.id });
      }
    };
  }

  flush() {
    if (this.filled === 0) return;
    // Copy out: the batch buffer is reused for the next frames.
    this.port.postMessage(this.batch.slice(0, this.filled));
    this.filled = 0;
  }

  process(inputs) {
    const input = inputs[0];
    const channel = input && input.length > 0 ? input[0] : null;
    if (channel && channel.length > 0) {
      // The engine reuses `channel` after process() returns: copy its values.
      let offset = 0;
      while (offset < channel.length) {
        const count = Math.min(channel.length - offset, this.batch.length - this.filled);
        this.batch.set(channel.subarray(offset, offset + count), this.filled);
        this.filled += count;
        offset += count;
        if (this.filled === this.batch.length) this.flush();
      }
    }
    return true;
  }
}

registerProcessor('pcm-forwarder', PcmForwarder);
