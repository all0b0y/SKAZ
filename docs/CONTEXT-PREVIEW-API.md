# Contextual ASR preview API

`POST /sessions/{session_id}/asr/preview` is the first diagnostic vertical slice for
multi-chunk ASR. It is authenticated by the same per-process bearer token as every
session route. It does not enable a scheduler, live finality, or UI.

## Request

```json
{"first_sequence": 4, "last_sequence": 9}
```

Both fields are strict JSON integers greater than or equal to zero, and
`first_sequence <= last_sequence`. Extra fields are rejected. Sequence numbers inside
the inclusive interval need not be adjacent, but both endpoint chunks must exist in
the requested session. A client cannot supply a file path.

The endpoint works only when the selected ASR profile is `local-whisper`. A cloud
profile is rejected before catalog, credential, or outbound-network access. Preview
always constructs the production local adapter with `allow_download=false`, regardless
of the global model-download environment toggle. The model, requested transcript
language, and speech-presence gate are snapshotted once for the request. There are no
automatic retries.

## Source validation and bounds

Metadata is read in numeric sequence order with a 64-chunk bound. Before constructing
the decoder, the backend requires every selected file to exist, the sum of WAV file
bytes to fit `max_chunk_bytes`, and the sum of PCM samples to fit
`max_chunk_seconds`. It verifies each stored SHA-256, mono PCM16 format, a common
sample rate, each capture duration against its sample count with integer-ms rounding,
and an exactly contiguous capture timeline. The request is rejected rather than
truncated; missing sequence IDs are never guessed or replaced with silence.

After validation, original PCM is concatenated once in sample order. The production
local adapter resamples the assembled window to 16 kHz when necessary. Stored source
files, chunk status, final segments, FTS, notes, agent context, and model verification
are not modified. Only one preview may run per backend process; another request gets
`429`. Cancellation retains the slot until an already-running decoder thread exits.
If the session or selected metadata disappears during inference, stale success is
rejected.

## Response

```json
{
  "state": "draft",
  "text": "...",
  "language": "ru",
  "provider": "local-whisper",
  "model": "small",
  "requested_language": "ru",
  "speech_gate_enabled": false,
  "window": {
    "start_ms": 0,
    "end_ms": 750,
    "sample_rate": 16000,
    "sample_count": 12000,
    "model_input_sample_rate": 16000,
    "model_input_sample_count": 12000,
    "model_input_kind": "assembled_pcm16_mono_resampled_for_local_whisper"
  },
  "sources": [
    {
      "sequence": 4,
      "start_ms": 0,
      "end_ms": 500,
      "sample_rate": 16000,
      "sample_count": 8000,
      "window_sample_start": 0,
      "window_sample_end": 8000,
      "sha256": "stored-original-wav-sha256",
      "source_kind": "original_captured_wav"
    }
  ]
}
```

`sources` identifies original captured WAV files and their trusted sample ranges in
the assembled source window. `model_input_kind` explicitly describes a transformed
input; it does not claim that the model received exact source-WAV bytes. Draft text is
untrusted data and has no final `segment_id`, word timestamp, or citation mapping.

Errors use the existing `{"detail": "..."}` envelope: validation `422`, missing
session/endpoint/file `404`, corrupt or discontinuous source `409`, combined/count cap
`413`, busy `429`, unsupported/unavailable local provider `400`, and decoder failure
`502`.

## Limitation

This endpoint is a manual, read-only diagnostic preview. The old per-chunk live ASR
path is unchanged. There is no scheduler, stable frontier, durable draft, final commit,
speaker/VAD segmentation algorithm, recording queue integration, or frontend in this
slice.
