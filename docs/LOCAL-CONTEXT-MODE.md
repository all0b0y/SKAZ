# Experimental local contextual recording mode

This document describes the opt-in recorder/UI integration for the bounded local live-ASR scheduler. It does not change the default recorder path and is not evidence of real-speech quality or end-to-end acceptance.

## Session mode

Every session has an additive `mode`:

- `legacy` — the existing per-chunk ASR upload path. This is the default for old database rows, omitted create fields, and the renderer's next-recording choice.
- `contextual_local` — captured WAV is stored first, then a durable storage ACK may notify the local contextual scheduler. It never enters the legacy transcription queue.

Mode is chosen explicitly before a new recording, persisted in SQLite, returned by session list/detail/create responses, and is not patchable. Changing the selected model or flags does not rewrite a session's mode. A stopped session with captured audio is never silently reused under another mode.

## Read-only capability

Authenticated `GET /asr/live/capabilities` returns:

```json
{
  "mode": "contextual_local",
  "capable": false,
  "requirements": {
    "local_profile_selected": true,
    "contextual_local_enabled": false,
    "live_finality_enabled": false,
    "local_speech_gate_enabled": false
  },
  "detail": "Turn on experimental contextual local mode in Settings; it enables local live finality and the local speech gate for new recordings."
}
```

`capable` is true only when the selected ASR profile provider is `local-whisper` and both live finality and the local speech gate are effectively enabled. `contextual_local_enabled` is the persisted user opt-in reported separately, so a blocked UI can name the missing action. The endpoint does not read API keys, inspect/download model weights, select another model, mutate settings, or enable flags. Everything here remains off by default.

## Enabling the mode

There are two independent sources for the two runtime capabilities, and the effective value is their OR:

- `PUT /settings {"contextual_local_enabled": true}` — the explicit user opt-in, stored in the settings document and therefore surviving a restart. It is the only path reachable from the UI (Settings → *Experimental contextual local mode*). Omitting the field keeps the stored value, so no read, mount, or unrelated save can enable it.
- `AUDIOHELPER_LIVE_FINALITY=1` / `AUDIOHELPER_LOCAL_SPEECH_GATE=1` — the unchanged process-level developer override.

The opt-in applies to the contextual window decoder only: the legacy per-chunk ASR path keeps reading the process-level `local_speech_gate`, so enabling contextual mode never changes legacy or cloud transcription. Changing the opt-in also increments the ASR settings generation, so a decode admitted under the previous configuration cannot commit even when the user toggles the switch off and on again while that decode is running — the old job stops with `config_changed` and a new admission is required.

## Capture and scheduling lifecycle

`raw capture → PersistenceQueue → POST /audio/store → durable ACK → coalesced latest sequence → POST /asr/live/advance`

Only one renderer notification is in flight and only the greatest pending ACK sequence is retained. The server owns source validation, window choice, overlap/rollover, decoder serialization, revisions, immutable final commits and provenance. Slow ASR does not hold an audio track lock or block later source saves.

Pause and stop retain `flush_transcription=false`. They wait for local WAV persistence only; they do not wait for contextual ASR and never force a draft final. The last stored ACK notification remains eligible to finish after capture stops. A source-ended unresolved tail stays a draft.

Reopening a saved contextual session issues GET requests only: session detail/finals, live draft, scheduler status and audio manifest. Mounting, polling, viewing a citation and playing audio never POST. If processing must resume after restart or a visible stall, the user presses **Resume contextual processing**, which explicitly advances through the latest available stored sequence. There is no timer retry, cloud fallback, checkpoint download or alternate writer.

Settings are frozen by the backend scheduler job. If ASR provider/model/language, speech-gate or finality configuration changes during work, the old job stops visibly (for example `config_changed`); the UI does not adopt the new configuration or fall back to legacy/cloud.

## Transcript and state meaning

The contextual transcript is one flow of immutable final segments plus a visually distinct revisable draft:

- `text_scope=unstable_tail`: the draft follows the stable prefix and may be displayed after it.
- `text_scope=whole_window`: prefix verification conflicted. The text is shown in a separate warning and must not be concatenated after finals, because that would duplicate or contradict text.

Drafts have no segment ID and are excluded from citations, agent questions, transcript search and notes. The UI warns about this exclusion. Draft source references can be inspected and played as source chunks, but they are not invented word timestamps.

Progress is shown separately:

- **captured** — source endpoint represented by `stable_frontier_ms + lag_ms`;
- **processed** — right edge of the last scheduler-selected window;
- **stable** — durable immutable frontier.

Scheduler `status=complete` means the currently available captured target was decoded. It does not mean the hypothesis is fully finalized. When `lag_ms > 0`, the UI says **Available audio processed; draft remains**, never “fully transcribed”. `stalled`, capability/config errors and bounded block reasons remain visible and do not start replay loops.

## Safety and compatibility guards

- A `contextual_local` session rejects legacy `POST /sessions/{id}/audio` before decoder admission. `/audio/store` remains the source-first path.
- Final-writer ownership is derived from committed provenance: finals with `segment_sources` are contextual; finals without it are legacy. The opposite writer is rejected both before decoder admission when already discoverable and again inside the same SQLite transaction that would mutate segments/FTS/source links. A losing race returns HTTP 409 and cannot delete or mix the winner's finals.
- A `legacy` session with existing legacy finals rejects contextual update/advance. An empty legacy session retains the established explicit backend/manual live test seam; once that seam commits contextual finals, later legacy upload, retry, or lifecycle flush is rejected without changing the immutable session mode.
- Pause/stop never invokes legacy flush for a `contextual_local` session, including when an older caller omits `flush_transcription=false` and receives the compatibility default.
- Existing final-only Q&A/notes APIs are unchanged and continue to see only immutable `segments` rows.
- New finals may reference multiple original chunks. Exact playback uses every manifest chunk associated with the final and the segment's time bounds; context playback adds adjacent chunks. A legacy one-chunk final still plays that whole chunk.
- `source_kind=original_captured_wav` describes the archived source. The player labels the exact transformed model input as not stored; it does not claim byte identity with model input.

This mode remains experimental and off by default. Synthetic PCM tests cover transport, persistence and playback mechanics only; they do not establish microphone behavior, speech accuracy, latency acceptance or local-model quality.
