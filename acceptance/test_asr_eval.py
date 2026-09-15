"""Deterministic harness mechanics; synthetic signals are NOT real ASR evidence."""
import hashlib
import importlib.util
import json
import struct
import subprocess
import sys
import tempfile
import unittest
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/asr_eval.py"


def harness():
    assert SCRIPT.is_file(), "ASR evaluation harness is not implemented"
    spec = importlib.util.spec_from_file_location("asr_eval", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module  # dataclasses resolve annotations through sys.modules
    spec.loader.exec_module(module)
    return module


def write_wav(path: Path, *, seconds: float = 1.0, sample_rate: int = 16_000, seed: int = 1) -> None:
    """Deterministic square-ish tone: harness mechanics only, never speech evidence."""
    frames = bytearray()
    for index in range(int(seconds * sample_rate)):
        value = 4000 if (index // (sample_rate // (20 * seed))) % 2 else -4000
        frames += struct.pack("<h", value)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(bytes(frames))


def build_case(root: Path, case_id: str, reference: str, hypothesis: str | None, **extra) -> dict:
    """Synthetic fixture wiring; the 'speech' is a tone, so metrics here prove code, not ASR."""
    write_wav(root / f"{case_id}.wav")
    (root / f"{case_id}.ref.txt").write_text(reference, encoding="utf-8")
    case = {"id": case_id, "audio": f"{case_id}.wav", "reference": f"{case_id}.ref.txt"}
    if hypothesis is not None:
        (root / f"{case_id}.hyp.txt").write_text(hypothesis, encoding="utf-8")
        case["hypothesis"] = f"{case_id}.hyp.txt"
    case.update(extra)
    return case


def write_manifest(root: Path, cases: list[dict], **extra) -> Path:
    manifest = {"version": 1, "cases": cases}
    manifest.update(extra)
    path = root / "manifest.json"
    path.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
    return path


class MetricsTests(unittest.TestCase):
    def test_edits_normalization_and_silence(self):
        score = harness().text_metrics
        self.assertEqual(score("НЕ 42, API!", "не 42 api")["word_edits"], 0)
        self.assertEqual(score("не 42", "42")["wer"], 0.5)
        self.assertEqual(score("кот", "кит")["cer"], 1 / 3)
        self.assertEqual(score("42", "forty two")["word_edits"], 2)
        silence = score("", "выдумка")
        self.assertIsNone(silence["wer"])
        self.assertIsNone(silence["cer"])
        self.assertEqual(silence["hallucinated_words"], 1)


class ManifestValidationTests(unittest.TestCase):
    def test_duplicate_ids_rejected_before_any_run(self):
        module = harness()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cases = [
                build_case(root, "dup", "не 42", "не 42"),
                dict(build_case(root, "other", "да", "да"), id="dup"),
            ]
            manifest = write_manifest(root, cases)
            with self.assertRaises(module.ManifestError) as caught:
                module.load_manifest(manifest)
        self.assertIn("dup", str(caught.exception))

    def test_missing_files_rejected(self):
        module = harness()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            case = build_case(root, "a", "не 42", "не 42")
            (root / "a.wav").unlink()
            manifest = write_manifest(root, [case])
            with self.assertRaises(module.ManifestError):
                module.load_manifest(manifest)

    def test_non_finite_or_negative_durations_rejected(self):
        module = harness()
        for duration in ("NaN", "-1", "Infinity"):
            with tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                raw = json.dumps({"version": 1, "cases": [build_case(root, "a", "да", "да")]})
                payload = json.loads(raw)
                payload["cases"][0]["duration_ms"] = json.loads(duration)
                path = root / "manifest.json"
                path.write_text(json.dumps(payload), encoding="utf-8")
                with self.assertRaises(module.ManifestError, msg=duration):
                    module.load_manifest(path)

    def test_audio_sha256_is_recorded(self):
        module = harness()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest = write_manifest(root, [build_case(root, "a", "да", "да")])
            loaded = module.load_manifest(manifest)
            expected = hashlib.sha256((root / "a.wav").read_bytes()).hexdigest()
            self.assertEqual(module.sha256_file(loaded.cases[0].audio_path), expected)


class StatusTests(unittest.TestCase):
    def test_missing_hypothesis_is_incomplete_never_pass(self):
        module = harness()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest = write_manifest(root, [build_case(root, "a", "не 42", None)])
            case = module.load_manifest(manifest).cases[0]
            result = module.score_case(case, module.Thresholds())
        self.assertEqual(result["status"], "INCOMPLETE")
        self.assertIn("hypothesis-missing", result["reasons"])

    def test_unchecked_semantic_verdict_blocks_pass(self):
        module = harness()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            case = build_case(
                root, "a", "не 42", "не 42",
                phrases=[{"phrase_end_ms": 1000, "final_text_ms": 2000}],
                reference_word_timestamps=[
                    {"word": "не", "start_ms": 0, "end_ms": 400},
                    {"word": "42", "start_ms": 400, "end_ms": 900},
                ],
            )
            manifest = write_manifest(root, [case])
            loaded = module.load_manifest(manifest).cases[0]
            unchecked = module.score_case(loaded, module.Thresholds())
        self.assertEqual(unchecked["semantic"]["status"], "unchecked")
        self.assertEqual(unchecked["status"], "INCOMPLETE")
        self.assertIn("semantic-unchecked", unchecked["reasons"])

    def test_manual_semantic_pass_allows_pass(self):
        module = harness()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            case = build_case(
                root, "a", "не 42", "не 42",
                keywords=["не", "42"],
                phrases=[{"phrase_end_ms": 1000, "final_text_ms": 2000}],
                reference_word_timestamps=[
                    {"word": "не", "start_ms": 0, "end_ms": 400},
                    {"word": "42", "start_ms": 400, "end_ms": 900},
                ],
                semantic_verdict={"status": "pass", "note": "checked by hand"},
            )
            manifest = write_manifest(root, [case])
            loaded = module.load_manifest(manifest).cases[0]
            result = module.score_case(loaded, module.Thresholds())
        self.assertEqual(result["status"], "PASS", result["reasons"])

    def test_failure_beats_incompleteness(self):
        module = harness()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest = write_manifest(root, [build_case(root, "a", "не 42 сейчас", "да 7 потом")])
            case = module.load_manifest(manifest).cases[0]
            result = module.score_case(case, module.Thresholds())
        self.assertEqual(result["status"], "FAIL")
        self.assertIn("wer-above-threshold", result["reasons"])

    def test_hallucination_on_silence_fails(self):
        module = harness()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest = write_manifest(root, [build_case(root, "a", "", "выдуманная фраза")])
            case = module.load_manifest(manifest).cases[0]
            result = module.score_case(case, module.Thresholds())
        self.assertEqual(result["status"], "FAIL")
        self.assertIn("hallucination-on-silence", result["reasons"])


class KeywordTests(unittest.TestCase):
    def test_keywords_reported_separately_from_wer(self):
        module = harness()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            # Long reference: one dropped negation keeps WER low but must still fail the term check.
            reference = "не отключай сервер сегодня вечером после обновления базы данных на сервере"
            hypothesis = "отключай сервер сегодня вечером после обновления базы данных на сервере"
            case = build_case(root, "a", reference, hypothesis, keywords=["не"])
            manifest = write_manifest(root, [case])
            loaded = module.load_manifest(manifest).cases[0]
            result = module.score_case(loaded, module.Thresholds())
        self.assertLess(result["text_metrics"]["wer"], 0.1)
        self.assertEqual(result["keywords"]["missed"], ["не"])
        self.assertEqual(result["keywords"]["status"], "fail")
        self.assertEqual(result["status"], "FAIL")
        self.assertIn("keyword-missed", result["reasons"])

    def test_missing_keyword_declaration_can_never_pass_acceptance(self):
        module = harness()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            case = build_case(
                root, "a", "не отключай API 42", "не отключай API 42",
                phrases=[{"phrase_end_ms": 1000, "final_text_ms": 1500}],
                reference_word_timestamps=[
                    {"word": "не", "start_ms": 0, "end_ms": 100},
                    {"word": "отключай", "start_ms": 100, "end_ms": 300},
                    {"word": "API", "start_ms": 300, "end_ms": 500},
                    {"word": "42", "start_ms": 500, "end_ms": 700},
                ],
                semantic_verdict={"status": "pass", "note": "checked by hand"},
            )
            loaded = module.load_manifest(write_manifest(root, [case])).cases[0]
            result = module.score_case(loaded, module.Thresholds())
        self.assertEqual(result["status"], "INCOMPLETE")
        self.assertIn("keywords-not-declared", result["reasons"])

    def test_keyword_absent_from_reference_can_never_pass_acceptance(self):
        module = harness()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            case = build_case(
                root, "a", "не отключай API 42", "не отключай API 42 опечатка",
                keywords=["не", "42", "опечатка"],
                phrases=[{"phrase_end_ms": 1000, "final_text_ms": 1500}],
                reference_word_timestamps=[
                    {"word": "не", "start_ms": 0, "end_ms": 100},
                    {"word": "отключай", "start_ms": 100, "end_ms": 300},
                    {"word": "API", "start_ms": 300, "end_ms": 500},
                    {"word": "42", "start_ms": 500, "end_ms": 700},
                ],
                semantic_verdict={"status": "pass", "note": "checked by hand"},
            )
            loaded = module.load_manifest(write_manifest(root, [case])).cases[0]
            result = module.score_case(loaded, module.Thresholds(max_wer=1.0))
        self.assertEqual(result["keywords"]["absent_from_reference"], ["опечатка"])
        self.assertEqual(result["status"], "INCOMPLETE")
        self.assertIn("keyword-reference-mismatch", result["reasons"])

    def test_reference_annotation_error_is_not_blamed_on_the_model(self):
        module = harness()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            case = build_case(root, "a", "не отключай API", "не отключай API", keywords=["42"])
            loaded = module.load_manifest(write_manifest(root, [case])).cases[0]
            result = module.score_case(loaded, module.Thresholds())
        self.assertEqual(result["status"], "INCOMPLETE")
        self.assertEqual(result["keywords"]["missed"], [])
        self.assertNotIn("keyword-missed", result["reasons"])
        self.assertIn("keyword-reference-mismatch", result["reasons"])


class LatencyTests(unittest.TestCase):
    def test_latency_unknown_without_timestamps(self):
        module = harness()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest = write_manifest(root, [build_case(root, "a", "да", "да")])
            case = module.load_manifest(manifest).cases[0]
            result = module.score_case(case, module.Thresholds())
        self.assertEqual(result["latency"]["status"], "unknown")
        self.assertIsNone(result["latency"]["p95_ms"])
        self.assertEqual(result["latency"]["samples_ms"], [])
        self.assertIn("latency-unknown", result["reasons"])

    def test_latency_measured_from_phrase_end_on_shared_timeline(self):
        module = harness()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            case = build_case(
                root, "a", "да", "да",
                phrases=[
                    {"phrase_end_ms": 1000, "final_text_ms": 2200},
                    {"phrase_end_ms": 4000, "final_text_ms": 4500},
                ],
            )
            manifest = write_manifest(root, [case])
            loaded = module.load_manifest(manifest).cases[0]
            result = module.score_case(loaded, module.Thresholds())
        self.assertEqual(result["latency"]["status"], "measured")
        self.assertEqual(result["latency"]["samples_ms"], [1200, 500])
        self.assertEqual(result["latency"]["p95_ms"], 1200)

    def test_p95_is_nearest_rank_not_mean(self):
        module = harness()
        self.assertEqual(module.percentile([100, 200, 300, 400], 0.95), 400)
        self.assertEqual(module.percentile([5], 0.95), 5)
        self.assertIsNone(module.percentile([], 0.95))


class BoundaryTests(unittest.TestCase):
    def test_boundary_cuts_unknown_without_word_timestamps(self):
        module = harness()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest = write_manifest(root, [build_case(root, "a", "да", "да")])
            case = module.load_manifest(manifest).cases[0]
            result = module.score_case(case, module.Thresholds())
        self.assertEqual(result["boundary"]["status"], "unknown")
        self.assertIsNone(result["boundary"]["words_crossing_window"])
        self.assertIsNone(result["boundary"]["words_lost_at_boundary"])

    def test_boundary_cut_counted_when_timestamps_supplied(self):
        module = harness()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            case = build_case(
                root, "a", "альфа бета", "альфа",
                reference_word_timestamps=[
                    {"word": "альфа", "start_ms": 0, "end_ms": 900},
                    {"word": "бета", "start_ms": 4800, "end_ms": 5300},
                ],
            )
            manifest = write_manifest(root, [case])
            loaded = module.load_manifest(manifest).cases[0]
            result = module.score_case(loaded, module.Thresholds(window_ms=5000))
        self.assertEqual(result["boundary"]["status"], "measured")
        self.assertEqual(result["boundary"]["words_crossing_window"], 1)
        self.assertEqual(result["boundary"]["words_lost_at_boundary"], 1)
        self.assertIn("boundary-word-cut", result["reasons"])


class AggregateTests(unittest.TestCase):
    def test_aggregate_is_micro_averaged_not_mean_of_percentages(self):
        module = harness()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            long_reference = " ".join(f"слово{index}" for index in range(20))
            cases = [
                build_case(root, "short", "альфа", "бета"),          # 1/1 errors
                build_case(root, "long", long_reference, long_reference),  # 0/20 errors
            ]
            manifest = write_manifest(root, cases)
            loaded = module.load_manifest(manifest)
            results = [module.score_case(case, module.Thresholds()) for case in loaded.cases]
            aggregate = module.aggregate(results)
        self.assertEqual(aggregate["word_edits"], 1)
        self.assertEqual(aggregate["reference_words"], 21)
        self.assertAlmostEqual(aggregate["wer"], 1 / 21)
        self.assertNotAlmostEqual(aggregate["wer"], 0.5)  # the mean of per-case percentages
        self.assertEqual(aggregate["cases"], 2)

    def test_aggregate_latency_p95_across_cases_and_unknown_counts(self):
        module = harness()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cases = [
                build_case(
                    root, "timed", "да", "да",
                    phrases=[{"phrase_end_ms": 0, "final_text_ms": 900}],
                ),
                build_case(root, "untimed", "да", "да"),
            ]
            manifest = write_manifest(root, cases)
            loaded = module.load_manifest(manifest)
            results = [module.score_case(case, module.Thresholds()) for case in loaded.cases]
            aggregate = module.aggregate(results)
        self.assertEqual(aggregate["latency"]["p95_ms"], 900)
        self.assertEqual(aggregate["latency"]["cases_unknown"], 1)
        self.assertEqual(aggregate["boundary"]["cases_unknown"], 2)


class CliTests(unittest.TestCase):
    def run_cli(self, root: Path, manifest: Path, *args: str):
        report = root / "report.json"
        completed = subprocess.run(
            [sys.executable, str(SCRIPT), "--manifest", str(manifest), "--report", str(report), *args],
            capture_output=True,
            text=True,
            check=False,
        )
        return completed, report

    def test_incomplete_run_exits_non_zero_and_writes_report(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest = write_manifest(root, [build_case(root, "a", "не 42", None)])
            completed, report = self.run_cli(root, manifest)
            self.assertNotEqual(completed.returncode, 0)
            payload = json.loads(report.read_text(encoding="utf-8"))
        self.assertEqual(payload["cases"][0]["status"], "INCOMPLETE")
        self.assertEqual(payload["exit_status"], "INCOMPLETE")
        self.assertEqual(len(payload["cases"][0]["audio_sha256"]), 64)

    def test_stdout_never_prints_transcript_bodies(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            case = build_case(root, "a", "СЕКРЕТНАЯЭТАЛОННАЯФРАЗА", "СЕКРЕТНАЯГИПОТЕЗА")
            manifest = write_manifest(root, [case])
            completed, _ = self.run_cli(root, manifest)
        self.assertNotIn("СЕКРЕТНАЯЭТАЛОННАЯФРАЗА", completed.stdout + completed.stderr)
        self.assertNotIn("СЕКРЕТНАЯГИПОТЕЗА", completed.stdout + completed.stderr)
        self.assertIn("a", completed.stdout)

    def test_invalid_manifest_exits_before_running_anything(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cases = [build_case(root, "a", "да", "да"), build_case(root, "b", "да", "да")]
            cases[1]["audio"] = "missing.wav"
            manifest = write_manifest(root, cases)
            completed, report = self.run_cli(root, manifest)
        self.assertEqual(completed.returncode, 2)
        self.assertFalse(report.exists())

    def test_non_finite_threshold_overrides_are_rejected_instead_of_bypassing_gates(self):
        scenarios = {
            "--max-wer": ("не отключай API 42", "не отключай API 43", 1500),
            "--max-latency-ms": ("не отключай API 42", "не отключай API 42", 9000),
            "--max-audio-seconds": ("не отключай API 42", "не отключай API 42", 1500),
            "--window-seconds": ("не отключай API 42", "не отключай API 42", 1500),
        }
        for flag, (reference, hypothesis, final_text_ms) in scenarios.items():
            with self.subTest(flag=flag), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                case = build_case(
                    root, "a", reference, hypothesis,
                    keywords=["не", "API"],
                    phrases=[{"phrase_end_ms": 1000, "final_text_ms": final_text_ms}],
                    reference_word_timestamps=[
                        {"word": "не", "start_ms": 0, "end_ms": 100},
                        {"word": "отключай", "start_ms": 100, "end_ms": 300},
                        {"word": "API", "start_ms": 300, "end_ms": 500},
                        {"word": "42", "start_ms": 500, "end_ms": 700},
                    ],
                    semantic_verdict={"status": "pass", "note": "checked by hand"},
                )
                manifest = write_manifest(root, [case])
                completed, report = self.run_cli(root, manifest, flag, "nan")
            self.assertEqual(completed.returncode, 2)
            self.assertFalse(report.exists())

    def test_partial_results_persisted_per_case(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cases = [build_case(root, "a", "да", "да"), build_case(root, "b", "нет", "нет")]
            manifest = write_manifest(root, cases)
            completed, report = self.run_cli(root, manifest)
            partial = Path(json.loads(report.read_text(encoding="utf-8"))["partial_log"])
            lines = [json.loads(line) for line in partial.read_text(encoding="utf-8").splitlines()]
        self.assertEqual([line["id"] for line in lines], ["a", "b"])
        self.assertNotEqual(completed.returncode, 0)  # semantic verdicts are unchecked

    def test_offline_replay_reports_honest_unavailability(self):
        module = harness()
        if module.local_runner_available():
            self.skipTest("faster-whisper is installed; unavailability path is not exercised here")
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest = write_manifest(root, [build_case(root, "a", "да", None)])
            completed, report = self.run_cli(
                root, manifest, "--offline-replay", "--model", "small", "--language", "ru"
            )
            payload = json.loads(report.read_text(encoding="utf-8"))
        self.assertNotEqual(completed.returncode, 0)
        case = payload["cases"][0]
        self.assertEqual(case["replay"]["status"], "unavailable")
        self.assertIn("run-not-executed", case["reasons"])
        self.assertEqual(case["status"], "INCOMPLETE")
        self.assertIn("offline replay", payload["evidence_class"])
        self.assertNotIn("microphone measurement", payload["evidence_class"])


class ReplayLabellingTests(unittest.TestCase):
    def test_evidence_label_does_not_claim_unverified_human_provenance(self):
        module = harness()
        self.assertNotIn("human reference", module.EVIDENCE_CLASS)
        self.assertIn("provenance is not verified", module.EVIDENCE_CLASS)

    def test_replay_never_reports_request_duration_as_latency(self):
        module = harness()
        source = SCRIPT.read_text(encoding="utf-8")
        self.assertIn("offline replay", source)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest = write_manifest(root, [build_case(root, "a", "да", "да")])
            case = module.load_manifest(manifest).cases[0]
            replay = {"status": "unavailable", "error": "faster-whisper is not installed"}
            result = module.score_case(case, module.Thresholds(), replay=replay)
        self.assertEqual(result["latency"]["status"], "unknown")
        self.assertNotIn("request", json.dumps(result["latency"]))
        self.assertIn("run-not-executed", result["reasons"])


class BoundaryPositionalAlignmentTests(unittest.TestCase):
    def test_duplicate_word_loss_is_not_masked_by_an_earlier_occurrence(self):
        """Naive 'does the word appear anywhere' would wrongly clear this loss."""
        module = harness()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            case = build_case(
                root, "a", "браво старт браво", "да",
                reference_word_timestamps=[
                    {"word": "браво", "start_ms": 0, "end_ms": 400},
                    {"word": "старт", "start_ms": 400, "end_ms": 900},
                    {"word": "браво", "start_ms": 4900, "end_ms": 5300},
                ],
            )
            manifest = write_manifest(root, [case])
            loaded = module.load_manifest(manifest).cases[0]
            replay = {"status": "ok", "text": "браво старт браво", "windowed_text": "браво старт"}
            result = module.score_case(loaded, module.Thresholds(window_ms=5000), replay=replay)
        self.assertEqual(result["boundary"]["status"], "measured")
        self.assertEqual(result["boundary"]["words_crossing_window"], 1)
        self.assertEqual(result["boundary"]["words_lost_at_boundary"], 1)
        self.assertEqual(result["boundary"]["lost_words"], ["браво"])
        self.assertIn("boundary-word-cut", result["reasons"])

    def test_boundary_uses_windowed_replay_text_not_whole_file_text(self):
        """The whole-file pass never sees a window edge; it must not be used for boundary loss."""
        module = harness()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            case = build_case(
                root, "a", "альфа бета", "да",
                reference_word_timestamps=[
                    {"word": "альфа", "start_ms": 0, "end_ms": 900},
                    {"word": "бета", "start_ms": 4800, "end_ms": 5300},
                ],
            )
            manifest = write_manifest(root, [case])
            loaded = module.load_manifest(manifest).cases[0]
            # Whole-file text recovers both words; only the windowed pass loses "бета".
            replay = {"status": "ok", "text": "альфа бета", "windowed_text": "альфа"}
            result = module.score_case(loaded, module.Thresholds(window_ms=5000), replay=replay)
        self.assertEqual(result["boundary"]["words_lost_at_boundary"], 1)
        self.assertEqual(result["boundary"]["lost_words"], ["бета"])

    def test_unaligned_word_timestamps_report_unknown_loss_not_a_guess(self):
        module = harness()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            case = build_case(
                root, "a", "альфа бета гамма", "альфа бета гамма",
                reference_word_timestamps=[
                    # Deliberately does not match the reference text word-for-word.
                    {"word": "alpha", "start_ms": 0, "end_ms": 400},
                    {"word": "beta", "start_ms": 4900, "end_ms": 5300},
                ],
            )
            manifest = write_manifest(root, [case])
            loaded = module.load_manifest(manifest).cases[0]
            result = module.score_case(loaded, module.Thresholds(window_ms=5000))
        self.assertEqual(result["boundary"]["status"], "measured")
        self.assertEqual(result["boundary"]["words_crossing_window"], 1)
        self.assertIsNone(result["boundary"]["words_lost_at_boundary"])
        self.assertIsNone(result["boundary"]["lost_words"])
        self.assertIn("unknown", result["boundary"]["loss_method"])


class LatencyGatingTests(unittest.TestCase):
    def test_partial_phrase_timing_stays_incomplete_never_pass(self):
        module = harness()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            case = build_case(
                root, "a", "да", "да",
                keywords=["да"],
                phrases=[
                    {"phrase_end_ms": 1000, "final_text_ms": 1500},
                    {"phrase_end_ms": 4000},  # final text for this phrase never arrived
                ],
                semantic_verdict={"status": "pass", "note": "checked by hand"},
            )
            manifest = write_manifest(root, [case])
            loaded = module.load_manifest(manifest).cases[0]
            result = module.score_case(loaded, module.Thresholds())
        self.assertEqual(result["latency"]["status"], "measured")
        self.assertEqual(result["latency"]["phrases_without_final_text"], 1)
        self.assertIn("latency-incomplete", result["reasons"])
        self.assertNotEqual(result["status"], "PASS")

    def test_latency_gate_uses_p95_not_a_single_outlier(self):
        module = harness()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            phrases = [
                {"phrase_end_ms": index * 10_000, "final_text_ms": index * 10_000 + 1_000}
                for index in range(19)
            ]
            phrases.append({"phrase_end_ms": 200_000, "final_text_ms": 205_000})  # one 5s outlier
            case = build_case(
                root, "a", "да", "да",
                keywords=["да"],
                phrases=phrases,
                semantic_verdict={"status": "pass", "note": "checked by hand"},
            )
            manifest = write_manifest(root, [case])
            loaded = module.load_manifest(manifest).cases[0]
            result = module.score_case(loaded, module.Thresholds())
        self.assertEqual(result["latency"]["p95_ms"], 1000)
        self.assertEqual(result["latency"]["over_threshold"], 1)
        self.assertNotIn("latency-above-threshold", result["reasons"])

    def test_p95_above_threshold_still_fails(self):
        module = harness()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            case = build_case(
                root, "a", "да", "да",
                phrases=[{"phrase_end_ms": 0, "final_text_ms": 4_000}],
            )
            manifest = write_manifest(root, [case])
            loaded = module.load_manifest(manifest).cases[0]
            result = module.score_case(loaded, module.Thresholds())
        self.assertIn("latency-above-threshold", result["reasons"])
        self.assertEqual(result["status"], "FAIL")


class ReplayEvidenceIsolationTests(unittest.TestCase):
    def test_replay_does_not_inherit_manifest_semantic_or_latency_verdict(self):
        module = harness()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            case = build_case(
                root, "a", "да", "да",
                phrases=[{"phrase_end_ms": 1000, "final_text_ms": 1500}],
                semantic_verdict={"status": "pass", "note": "checked against manifest hypothesis"},
            )
            manifest = write_manifest(root, [case])
            loaded = module.load_manifest(manifest).cases[0]
            replay = {"status": "ok", "text": "нет", "windowed_text": "нет"}
            result = module.score_case(loaded, module.Thresholds(), replay=replay)
        self.assertEqual(result["semantic"]["status"], "unchecked")
        self.assertEqual(result["latency"]["status"], "unknown")
        self.assertIn("semantic-unchecked", result["reasons"])
        self.assertIn("latency-unknown", result["reasons"])
        self.assertEqual(result["hypothesis_source"], f"{module.REPLAY_LABEL}: whole file")


class ManifestSchemaStrictnessTests(unittest.TestCase):
    def test_unknown_manifest_version_is_rejected(self):
        module = harness()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest = write_manifest(root, [build_case(root, "a", "да", "да")])
            payload = json.loads(manifest.read_text(encoding="utf-8"))
            payload["version"] = 999
            manifest.write_text(json.dumps(payload), encoding="utf-8")
            with self.assertRaises(module.ManifestError) as caught:
                module.load_manifest(manifest)
        self.assertIn("version", str(caught.exception))

    def test_unknown_top_level_field_rejected(self):
        module = harness()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest = write_manifest(
                root, [build_case(root, "a", "да", "да")], critical_terms=["да"]
            )
            with self.assertRaises(module.ManifestError) as caught:
                module.load_manifest(manifest)
        self.assertIn("critical_terms", str(caught.exception))

    def test_unknown_case_field_rejected(self):
        module = harness()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            case = build_case(root, "a", "да", "да", critical_terms=["да"])
            manifest = write_manifest(root, [case])
            with self.assertRaises(module.ManifestError) as caught:
                module.load_manifest(manifest)
        self.assertIn("critical_terms", str(caught.exception))

    def test_misplaced_top_level_phrase_end_ms_rejected(self):
        module = harness()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            case = build_case(root, "a", "да", "да", phrase_end_ms=1000)
            manifest = write_manifest(root, [case])
            with self.assertRaises(module.ManifestError) as caught:
                module.load_manifest(manifest)
        self.assertIn("phrase_end_ms", str(caught.exception))

    def test_unknown_phrase_field_rejected(self):
        module = harness()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            case = build_case(
                root, "a", "да", "да",
                phrases=[{"phrase_end_ms": 100, "final_text_ms": 200, "phase_end_ms": 100}],
            )
            manifest = write_manifest(root, [case])
            with self.assertRaises(module.ManifestError):
                module.load_manifest(manifest)

    def test_unknown_thresholds_field_rejected(self):
        module = harness()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest = write_manifest(
                root, [build_case(root, "a", "да", "да")], thresholds={"max_wer": 0.1, "max_wers": 0.2}
            )
            with self.assertRaises(module.ManifestError):
                module.load_manifest(manifest)


class AudioValidationTests(unittest.TestCase):
    def test_non_wav_audio_rejected_before_any_run_even_without_replay(self):
        module = harness()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            case = build_case(root, "a", "да", "да")
            (root / "a.wav").write_bytes(b"not actually a wav file at all")
            manifest = write_manifest(root, [case])
            with self.assertRaises(module.ManifestError) as caught:
                module.load_manifest(manifest)
        self.assertIn("cases[0].audio", str(caught.exception))
        self.assertIn("readable WAV", str(caught.exception))

    def test_stereo_audio_rejected(self):
        module = harness()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            case = build_case(root, "a", "да", "да")
            with wave.open(str(root / "a.wav"), "wb") as handle:
                handle.setnchannels(2)
                handle.setsampwidth(2)
                handle.setframerate(16_000)
                handle.writeframes(b"\x00\x00\x00\x00" * 100)
            manifest = write_manifest(root, [case])
            with self.assertRaises(module.ManifestError):
                module.load_manifest(manifest)

    def test_audio_longer_than_max_seconds_rejected_at_load_time(self):
        module = harness()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_wav(root / "a.wav", seconds=2.0)
            (root / "a.ref.txt").write_text("да", encoding="utf-8")
            manifest = write_manifest(root, [{"id": "a", "audio": "a.wav", "reference": "a.ref.txt"}])
            with self.assertRaises(module.ManifestError):
                module.load_manifest(manifest, max_audio_seconds=1.0)


if __name__ == "__main__":
    unittest.main()
