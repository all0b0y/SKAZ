#!/usr/bin/env python3
"""Offline ASR evaluation; never reads credentials or downloads weights.

The harness scores stored WAV fixtures against human reference transcripts. Everything it
produces is labelled "offline replay": it is NOT a physical-microphone capture and NOT a
live end-to-end latency measurement. A case whose hypothesis is missing, whose run did not
execute, or whose manual semantic check is still pending is INCOMPLETE and can never be PASS.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import importlib.util
import json
import math
import sys
import unicodedata
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

REPORT_SCHEMA = "audiohelper.asr-eval/1"
MANIFEST_VERSION = 1
REPLAY_LABEL = "offline replay"
EVIDENCE_CLASS = (
    "offline replay of stored WAV fixtures against supplied reference text; "
    "audio/reference provenance is not verified by the harness; "
    "NOT a physical-microphone capture and NOT a live end-to-end latency measurement"
)
DEFAULT_WINDOW_MS = 5_000
DEFAULT_MAX_WER = 0.05
DEFAULT_MAX_FINAL_LATENCY_MS = 3_000
DEFAULT_MAX_AUDIO_SECONDS = 600.0
REPLAY_TIMEOUT_S = 600.0
SEMANTIC_STATUSES = ("unchecked", "pass", "fail")
BACKEND_SRC = Path(__file__).resolve().parents[1] / "backend" / "src"


def normalize(text: str) -> str:
    """Ignore Unicode punctuation/case; preserve digits, accents and languages."""
    return " ".join("".join(
        char for char in text.lower() if not unicodedata.category(char).startswith("P")
    ).split())


def edit_distance(reference: list[str], hypothesis: list[str]) -> int:
    row = list(range(len(hypothesis) + 1))
    for i, left in enumerate(reference, 1):
        next_row = [i]
        for j, right in enumerate(hypothesis, 1):
            next_row.append(min(next_row[-1] + 1, row[j] + 1, row[j - 1] + (left != right)))
        row = next_row
    return row[-1]


def text_metrics(reference: str, hypothesis: str) -> dict:
    reference, hypothesis = normalize(reference), normalize(hypothesis)
    words, chars = reference.split(), list(reference.replace(" ", ""))
    word_edits = edit_distance(words, hypothesis.split())
    char_edits = edit_distance(chars, list(hypothesis.replace(" ", "")))
    return {
        "word_edits": word_edits, "reference_words": len(words),
        "char_edits": char_edits, "reference_chars": len(chars),
        "wer": word_edits / len(words) if words else None,
        "cer": char_edits / len(chars) if chars else None,
        "hallucinated_words": len(hypothesis.split()) if not words else 0,
    }


def percentile(values: list[float], fraction: float) -> float | None:
    """Nearest-rank percentile. Never a mean, never an interpolation of empty data."""
    if not values:
        return None
    ordered = sorted(values)
    rank = max(1, math.ceil(fraction * len(ordered)))
    return ordered[rank - 1]


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


class ManifestError(ValueError):
    """The manifest is unusable; nothing is executed and no report is written."""


def _reject_unknown(raw: dict, allowed: set[str], label: str) -> None:
    """Fail loudly on typos and unsupported fields instead of silently dropping a requirement."""
    unknown = sorted(set(raw) - allowed)
    if unknown:
        raise ManifestError(f"{label}: unknown field(s) {unknown}; expected only {sorted(allowed)}")


@dataclass(frozen=True)
class Thresholds:
    max_wer: float = DEFAULT_MAX_WER
    max_final_latency_ms: float = DEFAULT_MAX_FINAL_LATENCY_MS
    window_ms: int = DEFAULT_WINDOW_MS

    def as_dict(self) -> dict:
        return {
            "max_wer": self.max_wer,
            "max_final_latency_ms": self.max_final_latency_ms,
            "window_ms": self.window_ms,
        }


@dataclass(frozen=True)
class Phrase:
    """Reference phrase end and the moment final text became available, one shared timeline."""

    phrase_end_ms: float
    final_text_ms: float | None


@dataclass(frozen=True)
class WordSpan:
    word: str
    start_ms: float
    end_ms: float


@dataclass(frozen=True)
class Case:
    id: str
    audio_path: Path
    reference_path: Path
    reference_text: str
    hypothesis_path: Path | None
    hypothesis_text: str | None
    language: str | None
    duration_ms: float | None
    keywords: tuple[str, ...]
    phrases: tuple[Phrase, ...]
    word_timestamps: tuple[WordSpan, ...]
    semantic_status: str
    semantic_note: str


@dataclass(frozen=True)
class Manifest:
    path: Path
    cases: tuple[Case, ...]
    thresholds: Thresholds


def _number(value: Any, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ManifestError(f"{label}: expected a number, got {value!r}")
    number = float(value)
    if not math.isfinite(number):
        raise ManifestError(f"{label}: expected a finite number, got {value!r}")
    if number < 0:
        raise ManifestError(f"{label}: expected a non-negative number, got {value!r}")
    return number


def _text(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ManifestError(f"{label}: expected a non-empty string, got {value!r}")
    return value


def _existing(root: Path, value: Any, label: str) -> Path:
    path = (root / _text(value, label)).resolve()
    if not path.is_file():
        raise ManifestError(f"{label}: file does not exist: {path}")
    return path


def _validate_audio(path: Path, max_audio_seconds: float, label: str) -> None:
    """Reject a fixture that is not readable PCM16 mono WAV before any scoring or model work.

    This runs for every mode, not only ``--offline-replay``: a case scored from a recorded
    manifest hypothesis still claims to measure something about ``audio``, so the file must be
    a genuine, finite, within-limits WAV, not merely a file that exists.
    """
    if str(BACKEND_SRC) not in sys.path:
        sys.path.insert(0, str(BACKEND_SRC))
    try:
        from audiohelper.audio import InvalidAudio, parse_wav
    except ImportError as error:
        raise ManifestError(f"{label}: cannot validate audio, backend unavailable: {error}") from error
    try:
        parse_wav(path.read_bytes(), max_seconds=max_audio_seconds)
    except InvalidAudio as error:
        raise ManifestError(f"{label}: {error}") from error


def _phrases(raw: Any, label: str) -> tuple[Phrase, ...]:
    if raw is None:
        return ()
    if not isinstance(raw, list):
        raise ManifestError(f"{label}: expected a list of phrase objects")
    phrases = []
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            raise ManifestError(f"{label}[{index}]: expected an object")
        _reject_unknown(item, {"phrase_end_ms", "final_text_ms"}, f"{label}[{index}]")
        end = _number(item.get("phrase_end_ms"), f"{label}[{index}].phrase_end_ms")
        final_raw = item.get("final_text_ms")
        final = None if final_raw is None else _number(final_raw, f"{label}[{index}].final_text_ms")
        if final is not None and final < end:
            raise ManifestError(f"{label}[{index}]: final_text_ms is before phrase_end_ms")
        phrases.append(Phrase(end, final))
    return tuple(phrases)


def _word_timestamps(raw: Any, label: str) -> tuple[WordSpan, ...]:
    if raw is None:
        return ()
    if not isinstance(raw, list):
        raise ManifestError(f"{label}: expected a list of word objects")
    spans = []
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            raise ManifestError(f"{label}[{index}]: expected an object")
        _reject_unknown(item, {"word", "start_ms", "end_ms"}, f"{label}[{index}]")
        word = _text(item.get("word"), f"{label}[{index}].word")
        start = _number(item.get("start_ms"), f"{label}[{index}].start_ms")
        end = _number(item.get("end_ms"), f"{label}[{index}].end_ms")
        if end < start:
            raise ManifestError(f"{label}[{index}]: end_ms is before start_ms")
        spans.append(WordSpan(word, start, end))
    return tuple(spans)


def _keywords(raw: Any, label: str) -> tuple[str, ...]:
    if raw is None:
        return ()
    if not isinstance(raw, list):
        raise ManifestError(f"{label}: expected a list of critical terms")
    return tuple(_text(item, f"{label}[{index}]") for index, item in enumerate(raw))


def _semantic(raw: Any, label: str) -> tuple[str, str]:
    """The manual semantic verdict defaults to unchecked; only a human can set pass/fail."""
    if raw is None:
        return "unchecked", ""
    if not isinstance(raw, dict):
        raise ManifestError(f"{label}: expected an object")
    _reject_unknown(raw, {"status", "note"}, label)
    status = raw.get("status", "unchecked")
    if status not in SEMANTIC_STATUSES:
        raise ManifestError(f"{label}.status: expected one of {SEMANTIC_STATUSES}, got {status!r}")
    note = raw.get("note", "")
    if not isinstance(note, str):
        raise ManifestError(f"{label}.note: expected a string")
    return status, note


def _thresholds(raw: Any) -> Thresholds:
    if raw is None:
        return Thresholds()
    if not isinstance(raw, dict):
        raise ManifestError("thresholds: expected an object")
    _reject_unknown(raw, {"max_wer", "max_final_latency_ms", "window_ms"}, "thresholds")
    defaults = Thresholds()
    window = _number(raw.get("window_ms", defaults.window_ms), "thresholds.window_ms")
    if window <= 0:
        raise ManifestError("thresholds.window_ms: expected a positive number")
    return Thresholds(
        max_wer=_number(raw.get("max_wer", defaults.max_wer), "thresholds.max_wer"),
        max_final_latency_ms=_number(
            raw.get("max_final_latency_ms", defaults.max_final_latency_ms),
            "thresholds.max_final_latency_ms",
        ),
        window_ms=int(window),
    )


def _read_text(path: Path, label: str) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as error:
        raise ManifestError(f"{label}: cannot read as UTF-8 text: {error}") from error


def load_manifest(path: Path, *, max_audio_seconds: float = DEFAULT_MAX_AUDIO_SECONDS) -> Manifest:
    """Validate the whole manifest before anything runs: existence, unique ids, finite times."""
    path = Path(path)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError) as error:
        raise ManifestError(f"manifest: cannot read {path}: {error}") from error
    except json.JSONDecodeError as error:
        raise ManifestError(f"manifest: invalid JSON in {path}: {error}") from error
    if not isinstance(payload, dict):
        raise ManifestError("manifest: expected a JSON object at the top level")
    _reject_unknown(payload, {"version", "thresholds", "cases"}, "manifest")
    version = payload.get("version")
    if type(version) is not int or version != MANIFEST_VERSION:
        raise ManifestError(
            f"manifest.version: expected integer {MANIFEST_VERSION}, got {version!r}"
        )
    raw_cases = payload.get("cases")
    if not isinstance(raw_cases, list) or not raw_cases:
        raise ManifestError("manifest.cases: expected a non-empty list")

    root = path.parent
    seen: set[str] = set()
    cases: list[Case] = []
    for index, raw in enumerate(raw_cases):
        label = f"cases[{index}]"
        if not isinstance(raw, dict):
            raise ManifestError(f"{label}: expected an object")
        _reject_unknown(raw, {
            "id", "audio", "reference", "hypothesis", "language", "duration_ms",
            "keywords", "phrases", "reference_word_timestamps", "semantic_verdict",
        }, label)
        case_id = _text(raw.get("id"), f"{label}.id")
        if case_id in seen:
            raise ManifestError(f"{label}.id: duplicate case id {case_id!r}")
        seen.add(case_id)
        reference_path = _existing(root, raw.get("reference"), f"{label}.reference")
        hypothesis_raw = raw.get("hypothesis")
        hypothesis_path = (
            None if hypothesis_raw is None else _existing(root, hypothesis_raw, f"{label}.hypothesis")
        )
        audio_path = _existing(root, raw.get("audio"), f"{label}.audio")
        _validate_audio(audio_path, max_audio_seconds, f"{label}.audio")
        duration_raw = raw.get("duration_ms")
        semantic_status, semantic_note = _semantic(raw.get("semantic_verdict"), f"{label}.semantic_verdict")
        language = raw.get("language")
        if language is not None and not isinstance(language, str):
            raise ManifestError(f"{label}.language: expected a string")
        cases.append(Case(
            id=case_id,
            audio_path=audio_path,
            reference_path=reference_path,
            reference_text=_read_text(reference_path, f"{label}.reference"),
            hypothesis_path=hypothesis_path,
            hypothesis_text=(
                None if hypothesis_path is None
                else _read_text(hypothesis_path, f"{label}.hypothesis")
            ),
            language=language,
            duration_ms=(
                None if duration_raw is None else _number(duration_raw, f"{label}.duration_ms")
            ),
            keywords=_keywords(raw.get("keywords"), f"{label}.keywords"),
            phrases=_phrases(raw.get("phrases"), f"{label}.phrases"),
            word_timestamps=_word_timestamps(
                raw.get("reference_word_timestamps"), f"{label}.reference_word_timestamps"
            ),
            semantic_status=semantic_status,
            semantic_note=semantic_note,
        ))
    return Manifest(path=path, cases=tuple(cases), thresholds=_thresholds(payload.get("thresholds")))


def keyword_check(reference: str, hypothesis: str | None, keywords: tuple[str, ...]) -> dict:
    """Critical terms (negations, numbers, names) checked separately from the averaged WER."""
    if not keywords:
        return {"status": "not-declared", "checked": [], "missed": [], "absent_from_reference": []}
    if hypothesis is None:
        return {"status": "unknown", "checked": list(keywords), "missed": [], "absent_from_reference": []}
    reference_tokens = normalize(reference).split()
    hypothesis_tokens = normalize(hypothesis).split()
    missed, not_in_reference = [], []
    for term in keywords:
        tokens = normalize(term).split()
        if not tokens:
            continue
        present_in_reference = _contains(reference_tokens, tokens)
        if not present_in_reference:
            not_in_reference.append(term)
        elif not _contains(hypothesis_tokens, tokens):
            missed.append(term)
    return {
        "status": "fail" if missed else "pass",
        "checked": list(keywords),
        "missed": missed,
        "absent_from_reference": not_in_reference,
    }


def _contains(haystack: list[str], needle: list[str]) -> bool:
    span = len(needle)
    return any(haystack[start:start + span] == needle for start in range(len(haystack) - span + 1))


def latency_report(phrases: tuple[Phrase, ...], thresholds: Thresholds) -> dict:
    """Latency = reference phrase end -> final text available, on one shared audio timeline.

    An HTTP request duration is never reported here; when the timeline is missing the answer
    is "unknown", never zero.
    """
    samples = [
        phrase.final_text_ms - phrase.phrase_end_ms
        for phrase in phrases if phrase.final_text_ms is not None
    ]
    pending = sum(1 for phrase in phrases if phrase.final_text_ms is None)
    if not samples:
        return {
            "status": "unknown",
            "definition": "reference phrase end -> final text available (shared audio timeline)",
            "samples_ms": [],
            "phrases_without_final_text": pending,
            "p95_ms": None,
            "max_ms": None,
            "over_threshold": None,
        }
    return {
        "status": "measured",
        "definition": "reference phrase end -> final text available (shared audio timeline)",
        "samples_ms": samples,
        "phrases_without_final_text": pending,
        "p95_ms": percentile(samples, 0.95),
        "max_ms": max(samples),
        "over_threshold": sum(1 for value in samples if value > thresholds.max_final_latency_ms),
    }


def _crosses_window(span: WordSpan, window_ms: int) -> bool:
    last_ms = span.end_ms - 1 if span.end_ms > span.start_ms else span.start_ms
    return span.start_ms // window_ms != last_ms // window_ms


def _word_alignment_ops(reference: list[str], hypothesis: list[str]) -> list[str]:
    """One op per reference token via Levenshtein backtrace: "match", "sub", or "del".

    Hypothesis insertions are not reference operations and do not appear here. This is
    positional alignment, not a substring search: a word that recurs elsewhere in the
    hypothesis does not clear a "del"/"sub" at a different position.
    """
    rows, cols = len(reference) + 1, len(hypothesis) + 1
    dp = [[0] * cols for _ in range(rows)]
    for i in range(rows):
        dp[i][0] = i
    for j in range(cols):
        dp[0][j] = j
    for i in range(1, rows):
        for j in range(1, cols):
            if reference[i - 1] == hypothesis[j - 1]:
                dp[i][j] = dp[i - 1][j - 1]
            else:
                dp[i][j] = 1 + min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])
    ops: list[str] = []
    i, j = len(reference), len(hypothesis)
    while i > 0:
        if j > 0 and reference[i - 1] == hypothesis[j - 1] and dp[i][j] == dp[i - 1][j - 1]:
            ops.append("match")
            i, j = i - 1, j - 1
        elif j > 0 and dp[i][j] == dp[i - 1][j - 1] + 1:
            ops.append("sub")
            i, j = i - 1, j - 1
        elif dp[i][j] == dp[i - 1][j] + 1:
            ops.append("del")
            i -= 1
        else:
            j -= 1
    ops.reverse()
    return ops


def boundary_report(case: Case, hypothesis: str | None, thresholds: Thresholds) -> dict:
    """Word cuts at window boundaries, matched to the hypothesis by position, not by presence.

    Geometric crossing (a reference word straddling a window edge) is counted whenever
    reference word timestamps exist. Whether that specific occurrence was actually lost needs a
    positional alignment between the reference and hypothesis word sequences: a plain "does this
    word appear anywhere in the hypothesis" check would let an earlier, correctly recognised
    occurrence of the same word mask a real loss at the boundary. When the supplied
    ``reference_word_timestamps`` do not line up 1:1 with the reference text, loss stays
    "unknown" rather than guessed; the geometric crossing count is still reported.
    """
    word_timestamps = case.word_timestamps
    if not word_timestamps:
        return {
            "status": "unknown",
            "reason": "reference word timestamps were not supplied",
            "window_ms": thresholds.window_ms,
            "words_crossing_window": None,
            "words_lost_at_boundary": None,
            "lost_words": None,
        }
    window = thresholds.window_ms
    crossing_indexes = [i for i, span in enumerate(word_timestamps) if _crosses_window(span, window)]
    base = {
        "status": "measured",
        "window_ms": window,
        "words_crossing_window": len(crossing_indexes),
    }
    if hypothesis is None:
        return {
            **base, "words_lost_at_boundary": None, "lost_words": None,
            "loss_method": "unknown: no hypothesis available for this run",
        }
    reference_words = normalize(case.reference_text).split()
    span_tokens = [normalize(span.word).split() for span in word_timestamps]
    flat_tokens = [token for group in span_tokens for token in group]
    aligned_1to1 = all(len(group) == 1 for group in span_tokens) and flat_tokens == reference_words
    if not aligned_1to1:
        return {
            **base, "words_lost_at_boundary": None, "lost_words": None,
            "loss_method": "unknown: reference_word_timestamps do not align 1:1 with reference text",
        }
    hypothesis_words = normalize(hypothesis).split()
    matched = [op == "match" for op in _word_alignment_ops(reference_words, hypothesis_words)]
    lost_words = [word_timestamps[i].word for i in crossing_indexes if not matched[i]]
    return {
        **base, "words_lost_at_boundary": len(lost_words), "lost_words": lost_words,
        "loss_method": "positional-alignment",
    }


def score_case(case: Case, thresholds: Thresholds, *, replay: dict | None = None) -> dict:
    """Score one case. Failing evidence outranks incompleteness; incompleteness outranks PASS."""
    hypothesis = case.hypothesis_text
    boundary_hypothesis = hypothesis
    source = "manifest-hypothesis" if hypothesis is not None else "none"
    semantic_status, semantic_note = case.semantic_status, case.semantic_note
    phrases = case.phrases
    if replay is not None and replay.get("status") == "ok":
        hypothesis = replay.get("text")
        # Boundary loss is about what the *windowed* pass produced, not the whole-file pass:
        # the whole file never crosses a window edge, so it would silently hide real cuts.
        boundary_hypothesis = replay.get("windowed_text")
        source = f"{REPLAY_LABEL}: whole file"
        # The manifest's semantic verdict and phrase timeline were recorded against the
        # manifest hypothesis text. A replay produces a different hypothesis, so neither is
        # valid evidence for this run; there is currently no field tying them to the replay.
        semantic_status, semantic_note = "unchecked", (
            "not evaluated for this run: manifest semantic verdict is tied to a different "
            "hypothesis text, not to this replay output"
        )
        phrases = ()

    metrics = None if hypothesis is None else text_metrics(case.reference_text, hypothesis)
    keywords = keyword_check(case.reference_text, hypothesis, case.keywords)
    latency = latency_report(phrases, thresholds)
    boundary = boundary_report(case, boundary_hypothesis, thresholds)

    failures: list[str] = []
    incomplete: list[str] = []
    if metrics is None:
        incomplete.append("hypothesis-missing")
    elif metrics["reference_words"] == 0:
        if metrics["hallucinated_words"] > 0:
            failures.append("hallucination-on-silence")
    elif metrics["wer"] is not None and metrics["wer"] > thresholds.max_wer:
        failures.append("wer-above-threshold")
    if keywords["status"] == "fail":
        failures.append("keyword-missed")
    if keywords["status"] == "not-declared":
        incomplete.append("keywords-not-declared")
    elif keywords["absent_from_reference"]:
        incomplete.append("keyword-reference-mismatch")
    if semantic_status == "fail":
        failures.append("semantic-failed")
    elif semantic_status == "unchecked":
        incomplete.append("semantic-unchecked")
    if latency["status"] == "unknown":
        incomplete.append("latency-unknown")
    else:
        # Acceptance is "p95 <= threshold in 95% of cases", not "every single sample".
        if latency["phrases_without_final_text"]:
            incomplete.append("latency-incomplete")
        if latency["p95_ms"] is not None and latency["p95_ms"] > thresholds.max_final_latency_ms:
            failures.append("latency-above-threshold")
    if boundary["status"] == "unknown":
        incomplete.append("boundary-unknown")
    elif boundary["words_lost_at_boundary"]:
        failures.append("boundary-word-cut")
    if replay is not None and replay.get("status") != "ok":
        incomplete.append("run-not-executed")

    result = {
        "id": case.id,
        "audio": case.audio_path.name,
        "hypothesis_source": source,
        "language": case.language,
        "duration_ms": case.duration_ms,
        "text_metrics": metrics,
        "keywords": keywords,
        "semantic": {
            "status": semantic_status,
            "note": semantic_note,
            "how": "manual human check; the harness never decides semantics",
        },
        "latency": latency,
        "boundary": boundary,
        "replay": replay if replay is not None else {"status": "not-requested"},
        "status": "FAIL" if failures else ("INCOMPLETE" if incomplete else "PASS"),
        "reasons": failures + incomplete,
    }
    if replay is not None and replay.get("status") == "ok" and replay.get("windowed_text") is not None:
        result["windowed_text_metrics"] = text_metrics(case.reference_text, replay["windowed_text"])
    return result


def aggregate(results: list[dict]) -> dict:
    """Micro-averaged: sum of edits over sum of reference units, never a mean of percentages."""
    scored = [item["text_metrics"] for item in results if item["text_metrics"] is not None]
    word_edits = sum(item["word_edits"] for item in scored)
    reference_words = sum(item["reference_words"] for item in scored)
    char_edits = sum(item["char_edits"] for item in scored)
    reference_chars = sum(item["reference_chars"] for item in scored)
    latency_samples = [
        sample for item in results for sample in item["latency"]["samples_ms"]
    ]
    measured_boundary = [item["boundary"] for item in results if item["boundary"]["status"] == "measured"]
    counted_losses = [
        item["words_lost_at_boundary"] for item in measured_boundary
        if item["words_lost_at_boundary"] is not None
    ]
    return {
        "cases": len(results),
        "pass": sum(1 for item in results if item["status"] == "PASS"),
        "fail": sum(1 for item in results if item["status"] == "FAIL"),
        "incomplete": sum(1 for item in results if item["status"] == "INCOMPLETE"),
        "scored_cases": len(scored),
        "word_edits": word_edits,
        "reference_words": reference_words,
        "wer": word_edits / reference_words if reference_words else None,
        "char_edits": char_edits,
        "reference_chars": reference_chars,
        "cer": char_edits / reference_chars if reference_chars else None,
        "hallucinated_words_on_empty_reference": sum(item["hallucinated_words"] for item in scored),
        "averaging": "micro (sum of edits / sum of reference units)",
        "latency": {
            "samples": len(latency_samples),
            "cases_measured": sum(1 for item in results if item["latency"]["status"] == "measured"),
            "cases_unknown": sum(1 for item in results if item["latency"]["status"] == "unknown"),
            "p95_ms": percentile(latency_samples, 0.95),
            "max_ms": max(latency_samples) if latency_samples else None,
        },
        "boundary": {
            "cases_measured": len(measured_boundary),
            "cases_unknown": sum(1 for item in results if item["boundary"]["status"] == "unknown"),
            "words_crossing_window": (
                sum(item["words_crossing_window"] for item in measured_boundary)
                if measured_boundary else None
            ),
            "words_lost_at_boundary": sum(counted_losses) if counted_losses else None,
        },
        "keywords": {
            "terms_checked": sum(len(item["keywords"]["checked"]) for item in results),
            "terms_missed": sum(len(item["keywords"]["missed"]) for item in results),
            "cases_not_declared": sum(
                1 for item in results if item["keywords"]["status"] == "not-declared"
            ),
        },
        "semantic": {
            status: sum(1 for item in results if item["semantic"]["status"] == status)
            for status in SEMANTIC_STATUSES
        },
    }


def local_runner_available() -> bool:
    """faster-whisper and numpy must both be importable; otherwise the runner refuses to pretend."""
    return all(importlib.util.find_spec(name) is not None for name in ("faster_whisper", "numpy"))


def _load_backend() -> tuple[Any, Any]:
    if str(BACKEND_SRC) not in sys.path:
        sys.path.insert(0, str(BACKEND_SRC))
    from audiohelper.audio import parse_wav
    from audiohelper.gateways.asr import build_transcriber
    return parse_wav, build_transcriber


def _windows(audio: Any, window_ms: int) -> list[tuple[int, Any]]:
    """Fixed windows over the same audio timeline, mirroring the live upload size."""
    frames_per_window = max(1, int(audio.sample_rate * window_ms / 1000)) * 2
    chunks = []
    for start in range(0, len(audio.frames), frames_per_window):
        piece = audio.frames[start:start + frames_per_window]
        if not piece:
            continue
        offset_ms = round(start / 2 * 1000 / audio.sample_rate)
        chunks.append((offset_ms, type(audio)(audio.sample_rate, piece)))
    return chunks


async def _replay(
    parse_wav: Any, build_transcriber: Any, case: Case, *,
    model: str, language: str, window_ms: int, max_audio_seconds: float,
) -> dict:
    import httpx

    audio = parse_wav(case.audio_path.read_bytes(), max_seconds=max_audio_seconds)
    async with httpx.AsyncClient() as http:
        transcriber = build_transcriber(
            http=http,
            provider="local-whisper",
            model=model,
            api_key=None,
            base_url=None,
            timeout=REPLAY_TIMEOUT_S,
            allow_download=False,
        )
        whole = await transcriber.transcribe(audio, language=language)
        windows = []
        for offset_ms, chunk in _windows(audio, window_ms):
            pieces = await transcriber.transcribe(chunk, language=language)
            windows.append({
                "offset_ms": offset_ms,
                "duration_ms": chunk.duration_ms,
                "text": " ".join(piece.text for piece in pieces).strip(),
            })
    return {
        "status": "ok",
        "label": REPLAY_LABEL,
        "evidence_class": EVIDENCE_CLASS,
        "provider": "local-whisper",
        "model": model,
        "language": language,
        "allow_download": False,
        "audio_duration_ms": audio.duration_ms,
        "sample_rate": audio.sample_rate,
        "window_ms": window_ms,
        "text": " ".join(piece.text for piece in whole).strip(),
        "windows": windows,
        "windowed_text": " ".join(window["text"] for window in windows if window["text"]).strip(),
    }


def replay_case(
    case: Case, *, model: str, language: str, window_ms: int, max_audio_seconds: float,
) -> dict:
    """Offline replay through the production adapter. Not a microphone or live-latency run."""
    unavailable = {"status": "unavailable", "label": REPLAY_LABEL, "provider": "local-whisper",
                   "model": model, "allow_download": False}
    try:
        parse_wav, build_transcriber = _load_backend()
    except ImportError as error:
        return {**unavailable, "stage": "import-backend", "error": str(error)}
    try:
        return asyncio.run(_replay(
            parse_wav, build_transcriber, case,
            model=model, language=language, window_ms=window_ms, max_audio_seconds=max_audio_seconds,
        ))
    except (OSError, ValueError, RuntimeError, ImportError) as error:
        # Missing extra/weights, unreadable audio, unsupported device: report it, never fake a run.
        return {**unavailable, "stage": "transcribe", "error": f"{type(error).__name__}: {error}"}


def _partial_path(report_path: Path) -> Path:
    return report_path.parent / f"{report_path.stem}.partial.jsonl"


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--manifest", required=True, type=Path, help="Case manifest (JSON)")
    parser.add_argument("--report", required=True, type=Path, help="Where the JSON report is written")
    parser.add_argument("--offline-replay", action="store_true",
                        help="Transcribe each WAV locally via the production adapter (offline replay)")
    parser.add_argument("--model", default=None, help="Explicit local-whisper model id (required for replay)")
    parser.add_argument("--language", default=None, help="Explicit language code (required for replay)")
    parser.add_argument("--window-seconds", type=float, default=DEFAULT_WINDOW_MS / 1000,
                        help="Fixed replay/boundary window size in seconds")
    parser.add_argument("--max-wer", type=float, default=None, help="Override the WER threshold")
    parser.add_argument("--max-latency-ms", type=float, default=None,
                        help="Override the final-latency threshold in milliseconds")
    parser.add_argument("--max-audio-seconds", type=float, default=DEFAULT_MAX_AUDIO_SECONDS,
                        help="Reject fixtures longer than this many seconds")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    try:
        max_audio_seconds = _number(args.max_audio_seconds, "--max-audio-seconds")
        window_seconds = _number(args.window_seconds, "--window-seconds")
        if max_audio_seconds <= 0:
            raise ManifestError("--max-audio-seconds: expected a positive number")
        if window_seconds <= 0 or int(window_seconds * 1000) <= 0:
            raise ManifestError("--window-seconds: expected at least 0.001 seconds")
        max_wer = None if args.max_wer is None else _number(args.max_wer, "--max-wer")
        max_latency_ms = (
            None if args.max_latency_ms is None
            else _number(args.max_latency_ms, "--max-latency-ms")
        )
        manifest = load_manifest(args.manifest, max_audio_seconds=max_audio_seconds)
    except ManifestError as error:
        print(f"manifest rejected: {error}", file=sys.stderr)
        return 2
    if args.offline_replay and not (args.model and args.language):
        print("offline replay requires an explicit --model and --language", file=sys.stderr)
        return 2

    thresholds = replace(
        manifest.thresholds,
        max_wer=manifest.thresholds.max_wer if max_wer is None else max_wer,
        max_final_latency_ms=(
            manifest.thresholds.max_final_latency_ms if max_latency_ms is None
            else max_latency_ms
        ),
        window_ms=int(window_seconds * 1000),
    )

    report_path: Path = args.report
    report_path.parent.mkdir(parents=True, exist_ok=True)
    partial_path = _partial_path(report_path)
    results: list[dict] = []
    with partial_path.open("w", encoding="utf-8") as partial:
        for case in manifest.cases:
            run = None
            if args.offline_replay:
                run = replay_case(
                    case, model=args.model, language=args.language,
                    window_ms=thresholds.window_ms, max_audio_seconds=max_audio_seconds,
                )
            result = score_case(case, thresholds, replay=run)
            result["audio_sha256"] = sha256_file(case.audio_path)
            result["audio_bytes"] = case.audio_path.stat().st_size
            results.append(result)
            # Persist immediately: a crash keeps every case already scored.
            partial.write(json.dumps(result, ensure_ascii=False, allow_nan=False) + "\n")
            partial.flush()
            print(f"{case.id}: {result['status']} [{','.join(result['reasons']) or 'none'}]")

    totals = aggregate(results)
    exit_status = "FAIL" if totals["fail"] else ("INCOMPLETE" if totals["incomplete"] else "PASS")
    report = {
        "schema": REPORT_SCHEMA,
        "generated_at": datetime.now(UTC).isoformat(),
        "manifest": str(manifest.path),
        "mode": "offline-replay" if args.offline_replay else "score-recorded-hypotheses",
        "evidence_class": EVIDENCE_CLASS,
        "runner": {
            "provider": "local-whisper" if args.offline_replay else None,
            "model": args.model if args.offline_replay else None,
            "language": args.language if args.offline_replay else None,
            "allow_download": False,
            "local_runner_available": local_runner_available(),
            "python": sys.version.split()[0],
        },
        "thresholds": thresholds.as_dict(),
        "partial_log": str(partial_path),
        "cases": results,
        "aggregate": totals,
        "exit_status": exit_status,
        "limitations": [
            "Offline replay of stored files; no physical microphone was used.",
            "Audio/reference provenance is supplied by the manifest and is not verified.",
            ("Latency is only as trustworthy as the supplied reference timeline; "
             "request durations are never reported as end-to-end latency."),
            "Semantic verdicts are manual and default to unchecked.",
        ],
    }
    report_path.write_text(
        json.dumps(report, ensure_ascii=False, allow_nan=False, indent=2), encoding="utf-8"
    )
    print(
        f"cases={totals['cases']} pass={totals['pass']} fail={totals['fail']} "
        f"incomplete={totals['incomplete']} micro_wer={totals['wer']} "
        f"latency_p95_ms={totals['latency']['p95_ms']} status={exit_status}"
    )
    print(f"report: {report_path}")
    return 0 if exit_status == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
