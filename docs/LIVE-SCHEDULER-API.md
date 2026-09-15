# Explicit bounded live-ASR scheduler API

This experimental seam schedules contextual local-ASR work only after audio has a
durable local ACK. The renderer coalesces those ACK watermarks and exposes only an
explicit retry after failure. Both routes use the backend's existing bearer
authentication and loopback-origin policy.

The capability is off by default. It is available only when all three conditions are
true: the selected ASR provider is `local-whisper`,
`AUDIOHELPER_LIVE_FINALITY=1`, and `AUDIOHELPER_LOCAL_SPEECH_GATE=1`. The routes do
not change those settings. Ordinary save, legacy ASR, pause, stop, startup, and GET
requests never initiate scheduler work.

## Notify a persisted watermark

`POST /sessions/{session_id}/asr/live/advance`

```json
{"through_sequence": 17}
```

The body is strict: `through_sequence` is a non-negative JSON integer and extra
fields are rejected. The named source chunk must already be durably stored and pass
the existing source validation before admission. Success is `202`:

```json
{
  "accepted": true,
  "scheduler": {
    "capable": true,
    "accepted_count": 3,
    "status": "running",
    "captured_target_sequence": 17,
    "processed_window": {
      "first_sequence": 8,
      "last_sequence": 13,
      "start_ms": 40000,
      "end_ms": 70000
    },
    "stable_frontier_ms": 52310,
    "lag_ms": 32690,
    "block_reason": null,
    "source_ended": false,
    "recovery_required": false,
    "available_audio_processed": false,
    "source_continuity_verified": true
  }
}
```

Only one session is admitted process-wide. Further notifications for that session
coalesce to the greatest validated target; there is no list of pending windows.
Another session receives `429`. The admitted job freezes provider, model, language,
speech-gate value, finality policy/guard, and the monotonic ASR settings revision.
A change stops the old job instead of silently adopting new configuration.

Every decode remains bounded by the contextual preview limits: 64 source chunks,
30 seconds, and 16 MiB by default. Persisted chunks and their validated WAV bytes are
the source of truth. The planner extends the active anchor to the furthest fitting
contiguous endpoint. At the cap it chooses a stored anchor strictly before the stable
frontier, retains conservative overlap, and leaves room for a later right extension.
A rollover only rebases evidence; it is never agreement by itself. At most one
earlier safe anchor is attempted after an overlap/boundary rejection.

The scheduler calls only `LiveAsrDraftService.update`, so draft/final writes keep the
existing revision, provenance, finality, and atomic-CAS validation. Exact repeated
windows are guarded and the existing update idempotence remains authoritative. There
are no timers, automatic retries, cloud fallback, model downloads, alternate decoder,
or alternate final writer.

## Read transient status

`GET /sessions/{session_id}/asr/live/scheduler`

GET is read-only and returns the scheduler object shown above without the
`accepted`/`scheduler` envelope. Status values are `idle`, `scheduled`, `running`,
`stalled`, `complete`, and `stopped`. `processed_window` is the last
successful/idempotent scheduler-selected window. `lag_ms` is the non-negative
distance from the captured source endpoint to the durable stable frontier; it is not
phrase latency or live p95.

`block_reason` is null or one bounded value: `source_missing`, `source_conflict`,
`source_limit`, `decoder_busy`, `live_update_busy`, `config_changed`,
`session_missing`, `no_safe_anchor`, `awaiting_source_extension`, `finality_blocked`,
`cancelled`, or `decoder_failed`. Status never contains transcript text, audio,
paths, hashes, bearer tokens, or raw provider exceptions.

`source_continuity_verified` is false when the durable source contains more than
the bounded preview scan can inspect. A visible gap inside that bounded scan still
reports `source_missing`; false alone is an honest uncertainty marker and is not a
claim that a gap exists. GET never performs an unbounded manifest scan.

Runtime admission remains process-transient, but GET reconstructs the latest stored
target, last saved draft window, stable frontier, lag, source-ended truth, and a
conservative recovery state from SQLite after restart. It does not decode, write, or
start capture. A crashed process is never reported as still `running`; unfinished
work is `stalled`/`stopped` with `recovery_required=true`. A later explicit POST
rediscovers stored sources and resumes through the existing CAS path. Configuration
drift requires an explicit re-decode and never makes the historical draft current by
itself.

After a persistence-first contextual `PATCH /sessions/{id}` ACK sets `stopped`, the
source is durably ended. `complete` is then allowed only when all stored target audio
was processed and no non-blank draft tail remains. Otherwise status is the bounded,
visible `stalled/finality_blocked`; this is a recovery state, not successful transcript
finalization. A stop racing an active decode is checked again when that decode exits,
and a late stored target also invalidates a previous `complete` claim.

Unexpected top-level scheduler exceptions are converted to
`stalled/decoder_failed`, release admission, and emit only a technical event without
the exception or transcript/audio payload. Deleting a session cascades durable live
state; an old job cannot recreate it.

Errors use the existing `{"detail":"..."}` envelope: unauthenticated `401`, invalid
body `422`, missing session/target/source `404`, source/config conflict `409`, bounded
source limit `413`, other-session admission `429`, unavailable capability `400`, and
sanitized decoder failure in scheduler status. A stalled or stopped scheduler never
forces the saved pending tail to final merely because a cap, stop, or error occurred.
