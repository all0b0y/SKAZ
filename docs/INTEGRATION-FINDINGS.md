# Coordinator live integration findings

## Real backend ASR run
Command: `uv run --project backend python scripts/live_smoke.py --asr-only`
Report: `.runtime/live-20260906-201908/report.json` (ignored local evidence).
Actual model: google/gemini-2.5-flash-lite. Real JFK human speech, not TTS. App factory + public routes + real external OpenRouter HTTP; no physical microphone/Desktop in this run.

5s / 5s / 1s standalone windows succeeded, API latencies 1.593 / 1.131 / 0.973 seconds. Saved transcript read back via GET session. Total provider-reported cost $0.0001033.

**Quality finding:** naive5sec split produces `ask not But your country...for country` vs source `ask not what your country...for your country`. WER2/22 =9.09% for this tiny fixture, not broad quality estimate. Whole11sec WAV recognized correctly earlier. Need boundary treatment (VAD-aligned windows, overlap with attribution/dedupe or explicit post-stop reconciliation) and test before claiming high-quality transcript. Do not silently rewrite transcript using model world knowledge.

## Capability finding
NVIDIA nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free WAV returned HTTP200 but `Could you please provide the audio file or its transcript...`, audio_tokens0. FLAC failed400. Do not call a model ASR-verified solely because it returned any text/HTTP200. Catalog audio modality = candidate, not quality or task verification. Known failed candidate must not show verified unless retested successfully.

## Coordinator acceptance regressions (RED, independently reproduced)
Command: `uv run --project backend pytest acceptance/test_regressions.py -q --tb=short` →4failed.
1. Privacy: cloud_consent=false after revocation still sends transcript to question/notes cloud model. Must gate text as well as audio, before external POST.
2. `Что сейчас обсуждают?` should recent, not search based on обсужда prefix.
3. `Что сказали в первые 5 минут?` must beginning with bounded first5min, not last5min. Bare beginning currently includes all when transcript fits budget; fix bounds explicitly.
4. Nonempty API text (e.g. please provide audio) must not set ASR verified=true. Distinguish transport success from capability/quality verification. Avoid overfitting merely one refused sentence.

Real full smoke `.runtime/live-20260906-202141/report.json`: Qwen actual response1.436s, notes1.1s; total provider cost.0002206239USD. Persistence and sources work. Quality not yet sufficient: reply listed final fragments instead of explaining coherent gist, notes included standalone final-word bullet. Improve prompts to combine adjacent chunks into coherent important meaning, never list chunk boundaries as substantive points. Full acceptance still open.

## Execution
Both Claude workers hit session limit, reset already passed; coordinator actual retry confirmed Opus5 and resumed both original sessions with medium effort, no fallback. Current implementation not yet accepted. Physical microphone test approved by user, but MUST notify immediately before starting and wait for their test speech; no background/unannounced recording.
