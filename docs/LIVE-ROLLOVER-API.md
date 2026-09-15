# Experimental bounded live-finality window rollover

This backend-only capability lets the existing manual
`POST /sessions/{id}/asr/live/update` caller advance `first_sequence` after final text
exists. It remains controlled by `AUDIOHELPER_LIVE_FINALITY=1`, which is off by
default. There is no scheduler, recorder/UI integration, decoder change, extra
endpoint, or automatic request.

## Safe anchor transition

The requested first chunk is the new anchor and must be a validated stored source
boundary. With committed text, the anchor must move forward but remain strictly
before `stable_frontier_ms`. The backend translates the previous timed committed
prefix from window-relative to absolute recording time and aligns the ordered suffix
that overlaps the new window against its leading words.

Alignment is monotonic by occurrence and requires both the normalized token and a
compatible absolute time span. Repeated words therefore remain distinct. Existing
normalization is unchanged: NFKC + case-fold, ignoring only a trailing comma,
question mark, or period; internal decimal points, signs, apostrophes, and hyphens
remain significant.

If a chunk boundary crosses a committed word, that occurrence is retained only as
context when the new timed word maps unambiguously to it. A missing/conflicting
occurrence blocks with `rollover_word_boundary_ambiguous`. Other unverified overlap
blocks with `rollover_overlap_unverified`; an anchor at/after the frontier blocks with
`rollover_after_stable_frontier`. These responses keep the complete new hypothesis
as `text_scope=whole_window`. They never rewrite a final, cut uncommitted audio, or
insert any text/FTS row.

## Agreement after rollover

A successful rollover preserves the immutable frontier and returns
`status=awaiting_agreement`. The rebased observation is not independent agreement,
even if its right endpoint or source hash matches an earlier request. A later update
at the same new anchor must add right-side stored audio; only words agreed and guarded
in both new-anchor observations, with absolute start at or beyond the prior frontier,
may append.

The 30-second maximum selected window is only a decoder/RAM resource cap. Reaching it,
elapsed time, retry, pause, or stop never forces final text. If no safe overlapping
anchor exists, the caller must hold or choose an earlier stored boundary; the backend
reports the stall instead of discarding words.

## Bounded persisted metadata

Enabled `draft.finality` additionally returns:

```json
{
  "active_anchor_ms": 10000,
  "stable_token_offset": 1
}
```

`active_anchor_ms` is the absolute origin for the one retained decoder observation.
`stable_token_offset` counts committed tokens removed from active state during safe
rollovers. `stable_tokens_json`, `stable_text`, and `previous_words_json` retain only
the active overlap and current bounded window; old transcript text remains in
immutable `segments`/FTS with its original IDs and `segment_sources`.

SQLite adds both non-negative columns idempotently. Legacy rows are preserved;
`active_anchor_ms` is backfilled from `previous_window_start_ms` and the token offset
starts at zero. Disabled-finality responses still omit all finality fields and keep
the pre-existing draft shape.

All successful append operations remain one CAS transaction across final segment,
FTS, multi-chunk source provenance, frontier/evidence, and draft revision. Original
WAV bytes are never changed and gaps are never synthesized.

This mechanism establishes local hypothesis consistency, not speech truth or general
ASR quality. Scheduler/UI work and real continuous-speech liveness acceptance remain
separate.
