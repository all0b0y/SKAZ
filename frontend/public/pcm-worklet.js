// AudioWorklet processor: forwards mono Float32 PCM frames to the main thread.
// Served from the app origin (public/) so it loads under CSP script-src 'self'
// rather than as a blocked data: URL. Standalone module — no imports. The main
// thread accumulates these frames into fixed 5s windows (chunker.ts) and
// encodes each as a standalone PCM16 WAV.
class PcmForwarder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.port.onmessage = (event) => {
      if (event.data && event.data.type === 'barrier') {
        // MessagePort preserves ordering. The main thread disconnects the
        // source before requesting this barrier, so every preceding PCM frame
        // is delivered before the acknowledgement.
        this.port.postMessage({ type: 'barrier', id: event.data.id });
      }
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (input && input.length > 0) {
      const channel = input[0];
      if (channel && channel.length > 0) {
        // Copy: the engine reuses the underlying buffer after process().
        this.port.postMessage(channel.slice(0));
      }
    }
    return true;
  }
}

registerProcessor('pcm-forwarder', PcmForwarder);
