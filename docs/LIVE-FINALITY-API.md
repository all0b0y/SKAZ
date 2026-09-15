# Experimental live ASR stable-prefix finality

This is backend slice 2B: one bounded, opt-in stable-prefix transaction on top of
the durable live draft API. It is not the rolling scheduler, recorder integration,
speaker diarization, UI, semantic correction, or live-latency acceptance.

## Opt-in configuration

Finalization is **off by default**. With it off, `POST /asr/live/update` and
`GET /asr/live` keep the slice-2A draft contract, and `POST /asr/preview` remains
read-only.

- `AUDIOHELPER_LIVE_FINALITY=1` enables this experimental backend capability.
- `AUDIOHELPER_LIVE_FINALITY_GUARD_MS` is a positive integer. Its experimental
  default is `750`: a word must end at least this far behind the right edge of both
  decoder windows before it can become final.

The flag does not schedule updates. A caller still explicitly selects trusted stored
chunks and supplies `expected_revision` to `POST /sessions/{id}/asr/live/update`.

## Evidence and agreement

Only the selected `local-whisper` adapter is eligible. For the live update only, the
backend asks the installed faster-whisper API for `word_timestamps=True`. Manual
preview and legacy ingestion keep their existing decoder call.

The first hypothesis establishes evidence but commits nothing. A following hypothesis
can advance final text only when:

1. ASR settings have the same monotonic configuration epoch;
2. the left window edge is unchanged and the right edge is later, so authenticated
   source audio was added;
3. normalized word tokens form the same monotonic prefix by occurrence index,
   including repeated words, and corresponding spans overlap or differ by at most
   250 ms at both endpoints;
4. every committed candidate word is beyond the positive guard in both windows; and
5. the new hypothesis still contains every active-window committed normalized token.

After a final exists, the caller may move the left edge forward only through the
bounded overlap protocol in [LIVE-ROLLOVER-API.md](LIVE-ROLLOVER-API.md). A safe
rollover uses absolute token/time alignment, keeps the immutable frontier, and starts
a new agreement pair. It never treats a rebased same-endpoint decode as agreement.

Normalization is Unicode NFKC + case-folding after trimming surrounding whitespace;
a trailing comma, question mark or period is then ignored. This is used only for
lexical comparison. Internal punctuation remains significant: decimals, negative
numbers, apostrophes and hyphenated terms are not collapsed into unpunctuated tokens.
Words are still compared by occurrence index, so real repetitions are not deleted.
The stored text uses the current decoder word surfaces; the backend does not rewrite
an already committed surface, deduplicate repeated words, change case, or force
sentence-ending punctuation.

An exact source/config retry is returned idempotently before decode and is never a
second agreement. The live-state configuration fingerprint includes the enabled policy
and its guard while finality is on; the off-policy retains the pre-finality fingerprint.
A settings, enabled guard, or on/off policy change therefore marks a saved draft
`resume_compatibility.status=config_changed` on read while keeping the historical text
visible. Only an explicit update/retry starts a new epoch and it cannot silently reuse
the old idempotency result. Manual preview has no finality policy fields,
and the disabled live response retains its legacy shape. Already committed segment IDs
and text remain immutable. A changed left edge starts agreement over before any commit;
after a committed prefix it must pass the explicit bounded rollover protocol and then
starts agreement over at the new anchor.

Missing word objects and non-finite, negative, zero-width, decreasing, or out-of-window
word spans do not get clamped. They retain a revisable draft and report
`word_timestamps_unavailable` or `invalid_word_timestamps`. Empty/no-speech evidence
creates no final words. Stop, elapsed time, window cap and retries never force final.
For an ended source, any remaining non-blank tail is exposed as
`stalled/finality_blocked`; that marker is not a finalized transcript and does not
replace the later fragment-level edit/accept design.

## Response additions when enabled

The response keeps `draft` and adds the final segments created by this transaction:

```json
{
  "draft": {
    "state": "draft",
    "revision": 2,
    "epoch": 1,
    "text": "revisable tail",
    "text_scope": "unstable_tail",
    "finality": {
      "enabled": true,
      "status": "advanced",
      "stable_frontier_ms": 1210,
      "active_anchor_ms": 0,
      "stable_token_offset": 0
    }
  },
  "finalized_segments": [
    {
      "id": "immutable-id",
      "start_ms": 110,
      "end_ms": 1210,
      "text": "Alpha go go",
      "language": "en",
      "sources": [
        {
          "sequence": 0,
          "sample_start": 1760,
          "sample_end": 12000,
          "sha256": "stored-wav-sha256",
          "source_kind": "original_captured_wav"
        }
      ]
    }
  ]
}
```

`status` is `awaiting_agreement`, `stable`, `advanced`, or `blocked`. A blocked state
also contains `blocked_reason`; the committed frontier never shrinks. `text_scope`
defines how to interpret `draft.text`:

- `unstable_tail` means the text follows the verified committed prefix;
- `whole_window` means prefix verification failed (including a changed anchor or a
  lexical conflict), so the complete new hypothesis is retained as conflicting draft.

Consumers must branch on `text_scope`; they must not concatenate a `whole_window`
hypothesis after committed text as though it were a tail. A conflict never overwrites
the existing final segment or its FTS row. Ordinary session, FTS, agent and notes
readers see only rows committed to `segments`, never either kind of draft.

`active_anchor_ms` is the absolute origin of the bounded retained word evidence;
`stable_token_offset` counts committed tokens already discarded from that active
state. Historical text remains in immutable segment rows instead of being copied into
every draft.

When finality is disabled, these additions are omitted so the existing durable draft
wire shape remains intact. `GET /asr/live` continues to return `{"draft": null}` before
the first update.

## Atomic persistence and provenance

One SQLite transaction checks session existence, the expected draft revision and the
monotonic ASR settings generation, then inserts the immutable final segment, its FTS
row and `segment_sources`, advances `live_asr_finality`, and replaces the live draft.
Any failure rolls all of those changes back. Foreign keys cascade both live state and
source associations when the session is deleted.

`segments.sequence` remains the first contributing chunk as a legacy anchor. New
multi-chunk membership is read from `segment_sources`; the audio manifest combines
that association with the legacy fallback for old segments.

Each source range refers to samples in the already validated original WAV snapshot.
It records which source samples spanned the decoder's candidate time range. It is
provenance for the input snapshot, **not proof of exact spoken-word timing or semantic
truth**. Local agreement can stabilize the same ASR error twice.

The original WAV bytes are never rewritten. No credentials, cloud request, model
download, VAD trimming, forced retry, or arbitrary client-provided transcript text is
part of this capability.
