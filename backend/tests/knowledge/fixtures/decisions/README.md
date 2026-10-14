# Decision set (D1 spike gate)

Authored for SKAZ; no personal data, no copied text. 128 questions, ru/en 64/64, four decision
types × 32: `place` (which existing wiki page a new concept goes to, or a new page — choice),
`read` (what to read first for a user question — choice), `merge` (are two pages one concept — yes/no),
`link` (is a link between two concepts worth it — yes/no). Choice options are shuffled with a
fixed seed per item; the "new page" option stays last.

Split fixed before any model run: per (type, language) the first 6 of 16 items are `tune.jsonl`
(48 = 37.5%), the other 10 are `heldout.jsonl` (80 = 62.5%). Thresholds are chosen on `tune` only.

Fields: `id`, `split`, `lang`, `type`, `primitive` (`choice`|`noul`), `state`, `question`,
`options` (choice only), `answer` (option text, or `true`/`false`).

Run: `backend/scripts/decisions_benchmark.py` (not part of pytest).

`systemone_examples.json` — response examples copied from the TypeSafe/OpenRouter/llama.cpp
documentation (sources inside the file). `fake_llama_server.py` — a stand-in HTTP process for tests.
