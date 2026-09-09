# Q&A semantic slice — 2026-09-08

## Scope and attribution

Production Q&A now renders bounded continuous passages instead of separate chunk lines. This is a plausible mitigation of ASR punctuation at fixed chunk boundaries, not proof that presentation alone caused the original failure: notes and Q&A have different tasks/prompts.

Implementation: `claude-opus-5`, confirmed by `modelUsage` in `.runtime/opus-semantic-result.json` and `opus-semantic-finish.json`; session `9d0db157-6bee-49d8-be40-f4d196e4528f`. Launch `--model claude-opus-5 --permission-mode acceptEdits --allowedTools Read,Write,Edit,Glob,Grep,Bash --max-turns 35 --output-format json`, then resume20. First hit the configured turn cap, second exit0. No fallback model was supplied.

Opus review launches (Read only, max-turns15) both hit the actual session limit before review: `.runtime/opus-semantic-review-spec.json`, `opus-semantic-review-standards.json`. Orchestrator explicitly continued as **gpt-6-astra / openai-codex**, as permitted by AGENTS.md. Subsequent context fitting and evaluation-diagnostics fixes belong to the orchestrator, not Opus. Independent fallback reviewers used inherited runtime model routing; their identity is not inferred from self-description (batch metadata reports `?`).

## Changes

- `backend/src/audiohelper/agent/ask.py:answer`: `unit="passage"` for the selected transcript. Model IDs, scope selection, individual S labels and history remain unchanged.
- `backend/src/audiohelper/agent/context.py:build/_passage_line`: oversized multi-segment passages are split into constituent entries **before** fitting. Earliest/latest selection applies to actual segments; fully omitted members do not remain citable through a clipped passage. Single-segment partial clipping remains explicitly marked.
- `backend/tests/test_agent_ask.py`: joined passage, P/S citations and constrained-budget earliest/latest/source regression tests.
- `acceptance/fixtures/jfk_replay.json`: public JFK transcript from earlier real runs, explicitly replay-only, original audio hash and manual rubric. Not a fresh ASR result.
- `scripts/semantic_eval.py`: deliberate `--live` vs `--dry-run`, bounded repeats, production ask API with real outward HTTP in live mode. Reports each session's sources, question/attempt timing even on HTTP error/timeout, actual provider model status (unknown fails), cost missingness, effective command, exit code, source and request-message hashes and generation parameters. No headers/keys in reports.
- `acceptance/test_semantic_eval.py`: fixture-specific failure rules plus offline CLI and external HTTP transport tests. These tests prove harness behavior, not model quality. SHA tests use independent `shasum -a 256` vectors for `abc` and `abcd`.
- `acceptance/test_regressions.py`: Opus replaced old per-line-tag assertions with joined-passage assertions. This file was not included in the initial snapshot; the claimed only-change scope cannot be independently confirmed against that snapshot.

## Real evidence

All runs below used current application models, no silent model switch. Q&A response model: `qwen/qwen3-30b-a3b-instruct-2507`. Actual ASR response has no model field; requested ID `qwen/qwen3-asr-1.7b` is not asserted as provider-confirmed identity.

| Run | Command | Tool exit | Observed result |
|---|---|---:|---|
| `.runtime/live-20260908-100019-b321aa/report.json` | `uv run --project backend python scripts/live_smoke.py` | 0 | Before fix: Q&A again omits the first half of contrast; notes preserve it. ASR 1.055/0.709/0.438s. |
| `.runtime/semantic-20260908-100842-ea48bd/report.json` | `uv run --project backend python scripts/semantic_eval.py --live --repeats 3` | 0 | First replay: 3 contrast answers retain negation and both sides; 3 budget answers invent no amount. Language and unsupported “beginning of speech” issues remain. |
| `.runtime/live-20260908-100859-89c0a5/report.json` | `uv run --project backend python scripts/live_smoke.py` | 0 | New real ASR after fix: Q&A retains contrast but uses awkward Russian. Notes soften negation to “а не только”. ASR 1.218/0.717/0.408s, answer4.151s. Structural smoke only. |
| `.runtime/semantic-20260908-122638-de9b9e/report.json` | `uv run --project backend python scripts/semantic_eval.py --live --repeats 3` | 0 | Final replay after review fixes: 6 attempts, 3 sessions, provider ID confirmed on all. 9 returned citations checked in code against each session's source text/times/IDs. |

Final replay **orchestrator qualitative assessment**, not a human sign-off or automatic oracle:

| Repeat / question | Meaning | Language / limitations |
|---|---|---|
| 1 / missed_recent | Negation and both sides retained | Main quotation is in English despite Russian request: language criterion fails. 1.968s. |
| 1 / absent_budget | Correctly states budget absent in fragment | Russian, no invented amount. 2.117s. |
| 2 / missed_recent | Negation and both sides retained | Main quotation is in English: language criterion fails. 2.544s. |
| 2 / absent_budget | Correct refusal | Russian, no invented amount. 2.398s. |
| 3 / missed_recent | Negation and both sides retained | Untranslated `fellow Americans` remains. 2.544s. |
| 3 / absent_budget | Correct refusal | Russian, no invented amount. 0.912s. |

Do not mark `manual_verdict` as human-approved: raw reports intentionally retain pending. Fixture regex rules detect known phrasings only and may miss paraphrases or produce conservative false positives. Green structural/fixture results **do not mean product acceptance**.

Provider-reported costs for these four runs aggregate to approximately **$0.00132410**, with no missing reported costs. Final replay alone $0.0002781945. This excludes coding/reviewer usage. Aggregated from JSON using Decimal, not estimated pricing.

## Verification and limits

Orchestrator executed `uv run --project backend pytest backend/tests acceptance -q --tb=short`: baseline214, after Opus231, after initial review fixes238, final **239 passed** in3.24s. Ruff backend and mypy with `--config-file backend/pyproject.toml backend/src`: passed (31 files). `npm test && npm run typecheck && npm run smoke`:100 frontend tests, TS checks, production build and3 Electron smoke passed; repeated after backend fixes. Smoke is not physical microphone evidence.

Final independent source review `deleg_a7e42479` closed the earlier targeted findings and identified one more medium issue: non-dict provider usage crashed aggregation outside the reporting try. Orchestrator reproduced it at the external transport boundary (AttributeError), then guarded usage/cost types and unknown-cost accounting; full239 tests passed. This final change and the context docstring clarification happened after the final live replay; neither changes Q&A model inputs or generation. No claim of an additional live call is made.

RED evidence: two CLI path tests failed with ValueError before path fix; two constrained-context tests failed before group-fitting fix. `.runtime/semantic-diagnostics-red.log` records harness diagnostics failures before fix; the first run with missing transport argument was API-shape RED, then transport was added and behavioral failures exercised. Final full suite passed.

Remaining: Russian output quality; more diverse real RU/EN/mixed speech; full lecture acceptance; prior90.164s ASR spike; notes MAX_CITATIONS24 truncation; incomplete general body-label/provenance validation. Harness fixture/key/app preparation failures before report creation still lack a saved report. Request fingerprints capture code/request inputs, not undocumented provider defaults or backend service internals. Context docstring was clarified after the final replay; no runtime behavior changed in that clarification.

No microphone activation, no commit/push, no IDEA.md changes. Snapshot `.runtime/semantic-baseline/` retained.
