"""Unit tests for the pure pieces: WAV handling, temporal scope, context budget."""

from __future__ import annotations

import dataclasses

import pytest

from audiohelper import repository as repo
from audiohelper.agent import context as ctx
from audiohelper.agent import notes
from audiohelper.agent.scope import resolve
from audiohelper.audio import InvalidAudio, parse_wav, resample_pcm16
from audiohelper.db import Database
from audiohelper.schemas import Segment
from tests.conftest import make_wav

MINUTE = 60_000


def test_parse_wav_reads_rate_and_duration() -> None:
    audio = parse_wav(make_wav(2.0, sample_rate=48_000), max_seconds=30)
    assert audio.sample_rate == 48_000
    assert audio.duration_ms == 2000


def test_parse_wav_rejects_garbage() -> None:
    with pytest.raises(InvalidAudio):
        parse_wav(b"not audio", max_seconds=30)


def test_parse_wav_rejects_empty_body() -> None:
    with pytest.raises(InvalidAudio):
        parse_wav(b"", max_seconds=30)


def test_round_trip_keeps_frames() -> None:
    audio = parse_wav(make_wav(0.5), max_seconds=30)
    assert parse_wav(audio.to_wav_bytes(), max_seconds=30).frames == audio.frames


def test_resampling_changes_length_proportionally() -> None:
    audio = parse_wav(make_wav(1.0, sample_rate=48_000), max_seconds=30)
    resampled = audio.resampled(16_000)
    assert resampled.sample_rate == 16_000
    assert abs(resampled.duration_ms - 1000) <= 1
    assert resampled.frame_count == 16_000


def test_resampling_is_a_noop_for_the_same_rate() -> None:
    frames = b"\x01\x00\x02\x00"
    assert resample_pcm16(frames, 16_000, 16_000) == frames


def test_float_conversion_is_normalised() -> None:
    audio = parse_wav(make_wav(0.1), max_seconds=30)
    assert all(-1.0 <= value <= 1.0 for value in audio.to_float32())


@pytest.mark.parametrize(
    ("question", "expected_minutes"),
    [
        ("Что я пропустил за последние 10 минут?", 10),
        ("Что было в последние 2 минуты?", 2),
        ("Расскажи за пять минут", 5),
        ("What happened in the last 15 minutes?", 15),
        ("Summarise the past two minutes", 2),
    ],
)
def test_explicit_minutes_win_over_the_default(question: str, expected_minutes: int) -> None:
    scope = resolve(question, "auto", 5, watermark_ms=60 * MINUTE)
    assert scope.kind == "recent"
    assert scope.end_ms - scope.start_ms == expected_minutes * MINUTE


@pytest.mark.parametrize(
    "question",
    ["Что было в начале записи?", "Напомни начало лекции", "What was said at the start?"],
)
def test_beginning_questions_resolve_to_the_start(question: str) -> None:
    scope = resolve(question, "auto", 5, watermark_ms=60 * MINUTE)
    assert scope.kind == "beginning"
    assert scope.start_ms == 0
    assert scope.end_ms == 5 * MINUTE


def test_first_five_minutes_is_a_bounded_beginning_window() -> None:
    scope = resolve("Что сказали в первые 5 минут?", "auto", 2, watermark_ms=60 * MINUTE)
    assert scope.kind == "beginning"
    assert (scope.start_ms, scope.end_ms) == (0, 5 * MINUTE)


def test_current_discussion_is_recent_not_topic_search() -> None:
    scope = resolve("Что сейчас обсуждают?", "auto", 5, watermark_ms=60 * MINUTE)
    assert scope.kind == "recent"
    assert (scope.start_ms, scope.end_ms) == (55 * MINUTE, 60 * MINUTE)


@pytest.mark.parametrize(
    "question",
    ["Когда мы обсуждали энтропию?", "Did we mention the deadline?", "Кто сказал про бюджет?"],
)
def test_topic_questions_resolve_to_search(question: str) -> None:
    assert resolve(question, "auto", 5, watermark_ms=60 * MINUTE).kind == "search"


def test_default_is_the_recent_window() -> None:
    scope = resolve("Что я пропустил?", "auto", 5, watermark_ms=60 * MINUTE)
    assert scope.kind == "recent"
    assert scope.end_ms - scope.start_ms == 5 * MINUTE


def test_explicit_scope_parameter_wins_over_the_question_text() -> None:
    assert resolve("Что было в начале?", "recent", 5, watermark_ms=MINUTE).kind == "recent"
    assert resolve("Что я пропустил?", "all", 5, watermark_ms=MINUTE).kind == "all"


def test_recent_window_never_goes_below_zero() -> None:
    scope = resolve("Что я пропустил?", "auto", 30, watermark_ms=MINUTE)
    assert scope.start_ms == 0


def test_a_chunk_sequence_can_only_be_claimed_once() -> None:
    """The second claim reports the loss instead of raising or overwriting the owner."""
    db = Database(":memory:")
    try:
        session = repo.create_session(db, "Гонка")
        first = repo.ChunkRecord(
            session_id=session.id,
            sequence=0,
            start_ms=0,
            end_ms=1000,
            sha256="aaa",
            path="/tmp/first.wav",
            status=repo.CHUNK_PENDING,
            error=None,
        )
        second = dataclasses.replace(first, sha256="bbb", path="/tmp/second.wav")
        assert repo.insert_chunk(db, first) is True
        assert repo.insert_chunk(db, second) is False
        stored = repo.get_chunk(db, session.id, 0)
        assert stored is not None
        assert (stored.sha256, stored.path) == ("aaa", "/tmp/first.wav")
    finally:
        db.close()


def _segments(count: int) -> list[Segment]:
    return [
        Segment(id=f"seg-{index}", start_ms=index * 1000, end_ms=(index + 1) * 1000, text=f"line {index}")
        for index in range(count)
    ]


def test_context_labels_and_citations_round_trip() -> None:
    built = ctx.build(_segments(3), budget_chars=10_000)
    assert "[S1]" in built.text and "[S3]" in built.text
    citations = built.citations_for("Both [S1] and [S3] say so, but [S42] does not exist.")
    assert [citation.segment_id for citation in citations] == ["seg-0", "seg-2"]


def test_context_truncation_keeps_the_newest_and_says_so() -> None:
    built = ctx.build(_segments(50), budget_chars=200, keep="latest")
    assert built.truncated is True
    assert "truncated" in built.text
    assert built.segments[-1].id == "seg-49"


def test_context_truncation_can_keep_the_earliest() -> None:
    built = ctx.build(_segments(50), budget_chars=200, keep="earliest")
    assert built.segments[0].id == "seg-0"


def _transcript_lines(built: ctx.TranscriptContext) -> str:
    """The rendered transcript lines only, without the fixed header or truncation notice."""
    return "\n".join(line for line in built.text.splitlines() if line.startswith("[S") and "]" in line)


@pytest.mark.parametrize("budget", [1, 5, 19, 21, 120, 400])
def test_one_oversize_segment_never_exceeds_the_context_budget(budget: int) -> None:
    segment = Segment(id="huge", start_ms=0, end_ms=1000, text="x" * 10_000)
    built = ctx.build([segment], budget_chars=budget)
    assert built.truncated is True
    assert len(_transcript_lines(built)) <= budget, "a single segment must not blow the budget"


def test_one_oversize_segment_keeps_its_beginning_and_says_it_was_clipped() -> None:
    segment = Segment(id="huge", start_ms=0, end_ms=1000, text="важное начало " + "x" * 10_000)
    built = ctx.build([segment], budget_chars=120)
    assert "важное начало" in built.text
    assert "clipped" in built.text


def test_exhausted_budget_does_not_claim_the_transcript_is_empty() -> None:
    """A budget too small for any line is truncation, not an absent recording."""
    built = ctx.build(_segments(5), budget_chars=1)
    assert built.truncated is True
    assert ctx.NO_MATCH_MARKER not in built.text
    assert "truncated" in built.text


def _run(*windows: tuple[int, int]) -> list[Segment]:
    return [
        Segment(id=f"seg-{index}", start_ms=start, end_ms=end, text=f"line {index}")
        for index, (start, end) in enumerate(windows)
    ]


def test_contiguous_chunks_form_one_passage() -> None:
    """The live JFK shape: one sentence cut into 5s/5s/1s windows with no pause."""
    passages = ctx.group_passages(_run((0, 5000), (5000, 10000), (10000, 11000)))
    assert [len(passage) for passage in passages] == [3]


def test_a_real_pause_starts_a_new_passage() -> None:
    passages = ctx.group_passages(_run((0, 5000), (5000, 10000), (60_000, 61_000)))
    assert [[segment.id for segment in passage] for passage in passages] == [
        ["seg-0", "seg-1"],
        ["seg-2"],
    ]


def test_a_passage_never_swallows_the_whole_recording() -> None:
    """Contiguity alone must not merge an entire session into a single "thought"."""
    contiguous = _run(*[(index * 1000, (index + 1) * 1000) for index in range(40)])
    passages = ctx.group_passages(contiguous)
    assert len(passages) > 1
    assert all(len(passage) <= ctx.MAX_PASSAGE_LINES for passage in passages)
    assert sum(len(passage) for passage in passages) == 40, "no segment may be dropped"


def test_passage_tags_are_rendered_only_for_multi_line_passages() -> None:
    built = ctx.build(_run((0, 5000), (5000, 10000), (60_000, 61_000)), budget_chars=10_000)
    assert "(P1 1/2)" in built.text and "(P1 2/2)" in built.text
    assert "(P2" not in built.text, "a single-line passage needs no tag"
    assert ctx.PASSAGE_NOTE in built.text


def test_passage_note_is_omitted_when_nothing_is_grouped() -> None:
    built = ctx.build(_run((0, 1000), (60_000, 61_000)), budget_chars=10_000)
    assert "(P" not in built.text
    assert ctx.PASSAGE_NOTE not in built.text, "the note must not cost characters it cannot earn"


@pytest.mark.parametrize(
    ("cited", "expected"),
    [
        ("Спан [S1-S3].", ["seg-0", "seg-1", "seg-2"]),
        ("Спан [S1–S3].", ["seg-0", "seg-1", "seg-2"]),  # en dash
        ("Спан [S1—S3].", ["seg-0", "seg-1", "seg-2"]),  # em dash
        ("Спан [S1-3].", ["seg-0", "seg-1", "seg-2"]),  # bare second number
        ("Спан [S3-S1].", ["seg-0", "seg-1", "seg-2"]),  # reversed range
        ("Список [S1, S3].", ["seg-0", "seg-2"]),
        ("Список [S3,S1].", ["seg-2", "seg-0"]),  # first-use order is preserved
        ("Одна [S2].", ["seg-1"]),
        ("Смесь [S1-S2] и [S3].", ["seg-0", "seg-1", "seg-2"]),
    ],
)
def test_range_and_list_citations_resolve_to_every_contributing_segment(
    cited: str, expected: list[str]
) -> None:
    built = ctx.build(_segments(3), budget_chars=10_000)
    assert [citation.segment_id for citation in built.citations_for(cited)] == expected


def test_a_range_cannot_invent_or_overcite_sources() -> None:
    built = ctx.build(_segments(3), budget_chars=10_000)
    assert built.citations_for("Всё [S1-S9999].") == built.citations_for("Всё [S1-S3].")
    assert built.citations_for("Нет такого [S50-S60].") == []
    assert len(built.citations_for("Всё [S1-S9999].")) == 3


def test_citation_count_is_bounded() -> None:
    built = ctx.build(_segments(200), budget_chars=100_000)
    assert len(built.citations_for("Всё [S1-S200].")) == ctx.MAX_CITATIONS


def test_empty_context_is_marked_as_no_match() -> None:
    built = ctx.build([], budget_chars=1000)
    assert ctx.NO_MATCH_MARKER in built.text
    assert built.citations_for("[S1]") == []


def test_citations_resolve_across_two_context_blocks() -> None:
    """A follow-up cites both the current window and its carried-over sources."""
    window = ctx.build(_segments(2), budget_chars=10_000)
    earlier = ctx.build(
        [Segment(id="old", start_ms=0, end_ms=500, text="старое")],
        budget_chars=10_000,
        label_offset=2,
        header=ctx.EARLIER_SOURCES_HEADER,
    )
    references = {**window.references, **earlier.references}
    assert "[S3]" in earlier.text
    citations = ctx.citations_from(references, "Как в [S1] и в [S3].")
    assert [citation.segment_id for citation in citations] == ["seg-0", "old"]


def test_a_passage_label_cites_every_segment_inside_it() -> None:
    """[P<n>] carries the provenance of the whole joined passage, not of its first line."""
    built = ctx.build(_run((0, 1000), (1000, 2000), (2000, 3000)), budget_chars=10_000, unit="passage")
    assert "[P1]" in built.text
    assert [citation.segment_id for citation in built.citations_for("Одна мысль [P1].")] == [
        "seg-0",
        "seg-1",
        "seg-2",
    ]


def test_passage_mode_keeps_single_and_range_segment_citations() -> None:
    """Passage rendering adds a label; it never removes the original per-segment ones."""
    built = ctx.build(_run((0, 1000), (1000, 2000), (2000, 3000)), budget_chars=10_000, unit="passage")
    assert [citation.segment_id for citation in built.citations_for("Точно [S2].")] == ["seg-1"]
    assert [citation.segment_id for citation in built.citations_for("Спан [S1-S3].")] == [
        "seg-0",
        "seg-1",
        "seg-2",
    ]


def _resolved_ids(built: ctx.TranscriptContext) -> dict[str, list[str]]:
    """Every citation label of a context block with the segment ids it resolves to."""
    return {key: [segment.id for segment in members] for key, members in built.references.items()}


def test_a_passage_label_resolves_to_the_same_segments_after_batching() -> None:
    """Map steps must number passages exactly as one pass over the whole session does.

    A batch that cut a passage in half would shift every later ``[P<n>]``, so a label
    cited by a partial summary would resolve to the wrong segments in the saved note.
    """
    segments = _run((0, 1000), (1000, 2000), (60_000, 61_000), (61_000, 62_000))
    batches = notes._batches(segments, budget_chars=80)
    assert len(batches) > 1, "the budget must actually force several map steps"
    assert [[segment.id for segment in passage] for batch in batches for passage in batch] == [
        [segment.id for segment in passage] for passage in ctx.group_passages(segments)
    ], "batching must not split or drop a passage"

    # The same offsets the map steps advance, applied to the same builder.
    segment_offset = 0
    passage_offset = 0
    per_batch: dict[str, list[str]] = {}
    for batch in batches:
        block = ctx.build(
            [segment for passage in batch for segment in passage],
            budget_chars=10_000,
            keep="earliest",
            label_offset=segment_offset,
            unit="passage",
            passage_offset=passage_offset,
        )
        per_batch.update(_resolved_ids(block))
        segment_offset += sum(len(passage) for passage in batch)
        passage_offset += len(batch)

    whole = ctx.build(segments, budget_chars=10_000, keep="earliest", unit="passage")
    assert per_batch == _resolved_ids(whole)
