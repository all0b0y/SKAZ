# Durable live ASR draft API

This is the durable persistence/read seam for one revisable local-ASR hypothesis.
Scheduling and stable-prefix finality are documented separately. The existing
`POST /sessions/{session_id}/asr/preview` remains manual and read-only.

Both routes below use the existing per-process bearer authentication and loopback
origin policy.

## Read the latest saved snapshot

`GET /sessions/{session_id}/asr/live`

When no draft has been saved:

```json
{"draft": null}
```

When a draft exists, the backend returns its historical text even if the currently
selected ASR configuration changed. Source bytes are validated independently of the
current provider/model/language. Additive `source_integrity` and
`resume_compatibility` objects state whether source playback/provenance is trusted and
whether an explicit resume can use the current decoder. Configuration drift never
makes the saved text disappear and never silently reinterprets that text as output of
the current decoder.

Missing source bytes return `source_integrity.status=missing`; digest, format,
duration, timeline, or saved-source-reference conflicts return `corrupt`. In both
cases the historical draft remains readable, `trusted=false`, source playback must be
disabled, and `resume_compatibility.status=source_unavailable`. Update/decode routes
retain the existing `404`/`409` source guards.

## Update the draft

`POST /sessions/{session_id}/asr/live/update`

```json
{
  "first_sequence": 4,
  "last_sequence": 9,
  "expected_revision": 0
}
```

All fields are required strict non-negative JSON integers, extra fields are rejected,
and `first_sequence <= last_sequence`. Revision `0` means that the caller expects no
saved draft. Otherwise it must identify the current snapshot.

The service uses the exact bounded source assembly and local-only decoder path of the
manual preview: at most 64 stored chunks, 30 seconds and 16 MiB by default. Sources
must be trustworthy contiguous mono PCM16 WAVs with a common sample rate. The selected
profile must be `local-whisper`; weights cannot be downloaded and no cloud fallback or
automatic retry occurs.

One live update is admitted process-wide and it shares the single decoder slot with
manual preview. There is no pending decoder queue: a concurrent update or occupied
decoder returns `429`. If the HTTP caller is cancelled while the underlying worker
thread is still running, both slots remain occupied until that thread exits.

The request snapshots provider, model, requested transcript language, speech gate and
a monotonic ASR-settings generation. A result is rejected with `409` if any of these
changes during inference, including a change followed by a change back. Source changes
during inference are also rejected. Deleting the session during inference returns
`404`; the foreign key and compare-and-swap write prevent resurrection.

A successful response is:

```json
{
  "draft": {
    "state": "draft",
    "revision": 1,
    "epoch": 1,
    "updated_at": "2026-09-10T12:00:00.000+00:00",
    "text": "...",
    "language": "ru",
    "provider": "local-whisper",
    "model": "small",
    "requested_language": "ru",
    "speech_gate_enabled": false,
    "source_fingerprint": "sha256-of-canonical-source-references",
    "config_fingerprint": "sha256-of-canonical-ASR-config-and-generation",
    "config_revision": 1,
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
        "end_ms": 750,
        "sample_rate": 16000,
        "sample_count": 12000,
        "window_sample_start": 0,
        "window_sample_end": 12000,
        "sha256": "sha256-of-original-stored-wav",
        "source_kind": "original_captured_wav"
      }
    ]
  },
  "source_integrity": {
    "status": "verified",
    "trusted": true
  },
  "resume_compatibility": {
    "status": "compatible",
    "can_resume": true,
    "requires_redecode": false
  }
}
```

`revision` increases only when a new snapshot is saved. `epoch` increases when an
existing draft is replaced under a different ASR configuration generation; changing
only the trusted source window keeps the epoch. There is no reset endpoint in this
slice.

An exact retry is idempotent: the same source fingerprint and configuration may use
either the current revision or the immediately preceding expected revision and returns
the saved response without another decode. If two different payloads race with the
same expected revision, only the first admitted result can advance it; the stale one
returns `409`.

Draft text is bounded to 64,000 characters by default. Oversized source windows or
text return `413` and are not persisted.

## Persistence boundary

The additive SQLite table `live_asr_drafts` has one row per session and
`ON DELETE CASCADE`. Its JSON snapshot is bounded by the source and text limits; source
hashes/ranges, revision, epoch, and ASR configuration identity are also explicit
columns or fields. `settings_revisions` stores only the monotonic ASR configuration
generation. Existing databases are initialized with both tables without rewriting old
content.

No route in this slice writes `segments`, `segments_fts`, notes, messages, model
verification, or chunk status. Draft text has no final segment ID, citation, stable
frontier, word timestamp, or independent-ASR-agreement meaning. Repeating the same
source hash is idempotency, not corroboration. Original WAV files are read and
validated but never altered.

Errors use the existing `{"detail":"..."}` envelope: request validation `422`,
missing session/source on update `404`, stale revision/config or corrupt update source
`409`, size limits `413`, busy `429`, unsupported/unavailable local provider `400`,
and sanitized decoder failure `502`. Historical GET source/config drift is expressed
as typed metadata instead of hiding the saved draft.
