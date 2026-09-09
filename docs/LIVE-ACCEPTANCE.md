# Live acceptance — independent coordinator evidence

## 2026-09-07, dedicated STT baseline
Command: `uv run --project backend python scripts/live_smoke.py`
Report: `.runtime/live-20260907-152127/report.json` (ignored, local).
Input: public JFK human speech, 11 seconds, SHA256 `4d968ac99a1d0d4bc42ae8dd1552f4235e7b952a8121b39797f3dc2ca16123e9`.
No mocked external API. This uses production backend through in-process HTTP, NOT physical microphone/Electron.

Requested ASR `qwen/qwen3-asr-1.7b`, dedicated OpenRouter STT. Response does not echo model; requested ID recorded, not inferred from self-identification.
Q&A and notes response model: `qwen/qwen3-30b-a3b-instruct-2507`.

- 5/5/1-second chunks: latency 0.996/0.698/0.395 seconds.
- Normalized WER: 0 edits/22 reference words. Case/punctuation ignored. Punctuation across chunk boundaries remains awkward.
- ASR reported cost: $0.0000825; full test including two questions and notes: $0.00025471, no missing cost fields.
- Recent question selected recent scope and returned coherent Russian answer in 3.884 s.
- Absent budget question correctly reported no stated budget; no invented amount.
- Notes generated in 5.386 s and read back from persistence; four chat messages persisted.

## Not accepted yet
- Notes split a single rhetorical statement into redundant bullets, including a separate bullet about the final word. Segment boundaries must not dictate note structure.
- Citations identify real segments but are insufficient in isolation: the answer paraphrases the whole sentence while citing only its middle segment; notes link an expanded final phrase to the one-word `Country.` segment. Existence checks do not guarantee semantic citation support.
- Short EN recording cannot establish RU/multilingual lecture quality, long-session retrieval, hardware capture, or local ASR readiness.

## Routing
Backend follow-up: coordinator independently verified **163 passed**, `ruff check backend` passed, `mypy --config-file backend/pyproject.toml backend/src` passed (31 source files). The broader worker mypy scope remains its report, not a claim of independent verification. Backend notes/source-grouping follow-up launched as `proc_192fb6f7025a` on the same Opus 5 session. Frontend review work continues separately.

## Actual lecture pilot — source interval 05:00–06:30
Source supplied in `test_audio/Lesson 1 Part 1.m4a`; only this 90-second interval processed, NOT the whole lecture. Test session timestamps start at zero; add 300 seconds to map to source. Comparison `.runtime/lecture-comparison.json` verifies four runs each covers 90 seconds.

| Model | Chunk seconds | Chunks | Reported ASR cost USD | Request latency range seconds |
|---|---:|---:|---:|---:|
| qwen/qwen3-asr-1.7b | 5 | 18 | 0.000675 | 0.584–2.585 |
| qwen/qwen3-asr-1.7b | 30 | 3 | 0.000675 | 1.444–1.753 |
| nvidia/parakeet-tdt-0.6b-v3 | 30 | 3 | 0.002250 | 0.390–0.675 |
| openai/whisper-large-v3-turbo | 30 | 3 | 0.0002997 | 1.393–2.531 |

Pricing checked against current STT catalog and provider pages: Parakeet $0.0015/minute; Whisper turbo catalog $0.00000333/second. Whole-file estimates (4515.306667 seconds) $0.112883 and $0.015036 respectively, both below $0.30. These are estimates, not whole-lecture charges.

Qualitative caveats: outputs disagree on product names; Qwen emits short Chinese fragments in largely English speech and Whisper produces repeated thank-you fragments. Without manual audio reference these are suspicious artifacts, not quantified errors. Parakeet text appears less fragmented here but is NOT declared a measured quality winner. Thirty-second windows add collection delay and are not a substitute for the five-second live path. Do not silently change the user model based on this pilot.

Backend `claude-opus-5` resumed session `8410603c-bf06-4508-8b95-a5c3050f2d48`, process `proc_7cd3bb1570ac`.
Frontend `claude-opus-4-8` resumed session `02e17d1f-8541-4847-9c70-5e0a4bf31a24`, process `proc_d94c87258eed`.
No fallback; existing changes preserved. Both launched after verified Claude limit reset.
