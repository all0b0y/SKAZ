# Backend: notes and semantic source grouping

Owner: backend worker (`claude-opus-5`, no delegation, no model substitution).
Touched: `backend/**`, `acceptance/test_regressions.py` (coverage added, no assertion weakened),
this file. Nothing committed or pushed. No credentials, no `.env`, no private recordings read,
no live API calls made.

## 1. Reproduced the interruption damage first

```
uv run --project backend pytest backend/tests acceptance -q --tb=short
→ 152 passed, 11 failed
```

Exactly the coordinator's baseline. Cause was a single half-applied edit of mine: I had widened
`LABEL_PATTERN` from `\[S(\d{1,4})\]` (one capture group of digits) to a pattern matching a whole
citation block, but had not yet updated `citations_from`, which still did `f"S{label}"` on each
match. That produced keys like `S[S1]`, so **every** citation resolved to nothing. All 11 failures
were the same defect surfacing in different places: historical-topic answers, citation round-trip,
follow-up original sources, notes persistence.

Fixed by completing the parser. No citations are dropped: unknown labels are still discarded (a
model cannot invent a source), but every known label now resolves.

## 2. Root cause of the live notes/citation defect

From `.runtime/live-20260907-152127/report.json` — one JFK sentence cut into three recorder windows:

| label | window | text |
|---|---|---|
| S1 | 00:00–00:05 | `And so, my fellow Americans, ask not.` |
| S2 | 00:05–00:10 | `What your country can do for you, ask what you can do for your.` |
| S3 | 00:10–00:11 | `Country.` |

Two independent defects, both in **representation**, not in prompt wording:

1. **Each line was rendered as a self-contained unit with its own timestamp.** Nothing told the
   model that S1–S3 are fragments of one continuous utterance split on a fixed clock. The prompt
   already said "chunk boundaries are not ideas", but a data shape that presents three timestamped
   lines contradicts that instruction, and shape beats instruction. Result: three bullets, one of
   them for the single word `Country.`
2. **The citation grammar was one label per claim.** There was no way to express "supported across
   S1–S3", so the model picked one label. That is why the answer paraphrased the whole sentence
   while citing only S2, and why notes attached an expanded final phrase to the one-word S3. The
   citations pointed at real segments — the *coverage* was wrong, not the existence check.

## 3. What changed

### Passage grouping (`agent/context.py`)

`group_passages()` splits segments into runs of contiguous audio using only the recorded timeline:
segments closer than `PASSAGE_GAP_MS = 800` are one passage. This asserts **no silence between
lines** — a timeline fact from stored offsets — never that two fragments mean the same thing.
Runs are bounded by `MAX_PASSAGE_LINES = 12` and `MAX_PASSAGE_CHARS = 1200`, so contiguity alone
cannot collapse a whole recording into a single "thought".

Lines of a multi-line passage carry a shared inline tag, and a one-off note explains it:

```
[S1] 00:00–00:05 (P1 1/3) And so, my fellow Americans, ask not.
[S2] 00:05–00:10 (P1 2/3) What your country can do for you, ask what you can do for your.
[S3] 00:10–00:11 (P1 3/3) Country.
```

The tag is inline rather than a separate header line on purpose: it keeps the 1:1 line↔segment
mapping, so truncation, budget accounting and `_fit` are untouched, and a partially shown passage
still reads honestly as `(P1 2/3)`. Single-line passages get no tag and the explanatory note is
omitted entirely when nothing is tagged, so it never costs characters it cannot earn.

### Range and list citations

`[S2-S4]`, `[S1–S4]` / `[S1—S4]` (en/em dash), `[S1-3]`, reversed `[S4-S2]` and `[S1, S3]` now all
resolve, expanding to **every contributing segment** in first-use order. Bounded by
`MAX_CITATIONS = 24`, so `[S1-S9999]` cannot turn into "cite the entire session" — it resolves to
the known labels only and stops. Unknown labels are still dropped.

### Search completes its passage — bounded (`agent/ask.py`)

Found while testing: a lexical hit landing on a mid-sentence fragment was supplied **alone**. The
model received `Мы начали обсуждать план поставки и` with no completion. `_complete_passages()`
now extends each hit to its own passage, so the match is readable and every contributing line is
citable.

This is deliberately narrow: only passages that already contain a hit are returned. A time window
(`recent` / `beginning` / `all`) is **never** widened — its bounds are exactly what the user asked
for, so temporal precision is preserved. Grouping widens *provenance*, not *scope*.

### Prompts

Rules in both `ask` and `notes` now match the representation: a `(P<n> i/k)` group is one unit;
one passage is normally one bullet; a sentence fragment or trailing word is never its own point;
cite the whole range a statement rests on, and do not attach lines it does not rest on.

### Verified against the live case

```
range cite [S1-S3] → ('a','And so, my fellow Americans, ask not.'),
                     ('b','What your country can do for you, ask what you can do for your.'),
                     ('c','Country.')
```

## 4. Results

```
uv run --project backend pytest backend/tests acceptance -q  → 181 passed   (exit 0)
cd backend && uv run ruff check .                            → All checks passed!  (exit 0)
cd backend && uv run ruff format --check .                   → 42 files already formatted (exit 0)
cd backend && uv run mypy                                    → Success: no issues found in 41 source files (exit 0)
```

163 → 181: the 163 pre-existing tests all still pass, unmodified except for two that pinned the
exact old prompt strings I replaced. Both were re-pointed at the **stronger** rules and made to
exercise real grouping, not weakened:

- `test_notes_prompt_requires_coherent_adjacent_gist_and_ignores_stray_word` previously declared
  30-second windows while uploading 1 second of audio, so its segments landed 29 s apart and never
  formed a passage. Now uses contiguous windows like a real recorder and asserts the `(P1 i/3)`
  tags actually reach the model plus the new rules.
- `test_gist_and_notes_prompts_forbid_chunk_boundary_bullets` (acceptance) now reproduces the live
  JFK shape — three contiguous chunks whose last holds only the closing word — and asserts both
  the supplied representation and the rules.

New coverage: 16 unit tests (passage grouping incl. gap split, line/char caps, no segment dropped;
tag rendering; note omitted when unused; 9 parametrized range/list citation forms; over-cite and
invented-range bounds) and 2 acceptance tests (`test_range_citation_resolves_to_every_contributing_segment`,
`test_range_citation_never_reaches_outside_the_requested_scope`).

## 5. Honest limits

1. **Mocks prove the wire contract and the supplied representation, not semantic quality.** Every
   test here asserts what reaches the model and how citations resolve. Whether the model *uses*
   `[S1-S3]` and stops bulleting `Country.` can only be established by the coordinator's live run.
2. `PASSAGE_GAP_MS = 800` is a judgement call, not a measured threshold. It is right for the
   observed recorder behaviour (contiguous windows, gap 0) but has not been tuned against real
   pauses in RU speech or against local-whisper sub-segment timings, which differ from
   whole-chunk timings.
3. Over-grouping is possible: two short adjacent sentences with no pause become one passage. The
   consequence is mild (they may merge into one bullet) and the caps bound it, but it is not free.
4. `_complete_passages` loads the session's segments to find passage neighbours, same scale
   assumption as notes generation. Fine for a single local user; not a design for very long sessions.
5. Time windows can still cut a passage mid-sentence. That is deliberate — the window is what the
   user asked for — and the `(P1 2/3)` tag signals the missing head, but the head is not supplied.
6. Still outstanding from the previous report and untouched here: chunk-boundary ASR quality
   (VAD-aligned windows), RU/mixed WER, long-session retrieval, local-whisper, cost persistence.
