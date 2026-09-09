# AudioHelper — передача работы, 2026-09-08

## Проверенный результат
- Начало запуска: `uv run --project backend pytest backend/tests acceptance -q --tb=short` → **40 failed, 141 passed**, exit 1. Это был сломанный baseline, не рабочий релиз. Лог `/Users/all0b0y/.hermes/cache/terminal-output/out-1788819967-25224-dc10.log`.
- Конец реализации: та же команда → **188 passed**, exit 0; `uv run --project backend ruff check backend` → passed; `uv run --project backend mypy --config-file backend/pyproject.toml backend/src` → passed, 31 файл.
- Независимо повторено `npm test && npm run typecheck && npm run smoke` → **100 passed**, typecheck/production build passed, **3 Electron smoke passed**. UI не изменялся, физический микрофон не включался.

## Изменённые исходники и тесты
- `backend/src/audiohelper/agent/ask.py:answer`: оба контекстных блока используют `references`, далее тот же контракт передаётся в `citations_from`; смещения S-меток сохраняют раздельность текущего окна и старых источников.
- `backend/src/audiohelper/agent/notes.py:_batches`: возвращает batches → passages → segments. Граница batch не разрезает passage, поэтому P/S-нумерация map совпадает с разрешением по полной сессии. Oversize passage сохраняется целиком.
- `notes.py:_merge`: инструкция сохранять обе формы `[P...]` и `[S...]`.
- Тесты `test_audio_and_scope_units.py`, `test_notes_api.py`: добавлены шесть регрессий P-ссылок, S-ссылок/диапазонов и нумерации при нескольких batch. Старый тест структуры prompt адаптирован с отдельных `(P1 i/k)` к единому `[P1]` с полным текстом и диапазоном первоисточников; проверки смыслового объединения сохранены. Оркестратор дополнительно восстановил исходное требование показывать пример `[S2-S4]`.
- Оркестратор изменил `ask.py:SYSTEM_RULES` и добавил `test_agent_ask.py:test_prompt_preserves_negation_across_chunk_boundaries` после реальной потери отрицания. RED воспроизведён, GREEN подтверждён. Это тест отправляемой инструкции, не доказательство качества модели.
- Оркестратор изменил `notes.py:SYSTEM_RULES`: диапазоны S и точное сохранение ASCII идентификаторов без перевода. Обе проверки сначала упали, затем прошли. Кириллическое `[П1]` НЕ нормализуется в валидное `[P1]`.

## Снимки, маршрутизация и граф
- До изменений скопирован и проверен `diff -qr` снимок `.runtime/snapshot-broken-20260908-contract/`: agent и два тестовых файла; позже добавлены test_agent_ask и версии ask/notes после Opus. Без секретов и аудио. Никаких commit/push, IDEA.md не менялся.
- Backend исполнитель `claude-opus-5`, session `71b2c43f-f81d-4ec0-bf42-312f5fa5a23c`; `--permission-mode acceptEdits --allowedTools Read,Write,Edit,Glob,Grep,Bash --output-format json`, max-turns 35, затем resume 15. Оба остановлены **заданным max_turns**, не доказанным лимитом квоты/OAuth. modelUsage в `.runtime/opus-contract-repair-20260908.json` и `.runtime/opus-contract-finish-20260908.json` подтверждает точный ID.
- Оркестратор `gpt-6-astra` / `openai-codex` самостоятельно выполнил последующие prompt/test правки и проверки, с явным объявлением; не приписывать их Opus. Конкурирующих исполнителей одного участка не было.
- MCP `Users-all0b0y-VSCodeProjects-AudioHelper`, исходная generation `2026-09-07T18:47:35Z`: context/ask/notes и два теста no_recorded_issue, metadata_match. TranscriptContext найден graph/snippet, исходники проверены. Последующий coverage test_agent_ask generation `2026-09-07T22:34:52Z`, metadata_match. Индекс обновляется; ручной полной переиндексации не было. Игнорируемые pycache/.env/.runtime не считать пробелом исходников.

## Реальные live-прогоны
Команда каждого: `uv run --project backend python scripts/live_smoke.py`, exit 0; публичная человеческая речь JFK, 11 секунд, окна 5/5/1. Реальные внешние OpenRouter HTTP через production backend/in-process ASGI, не microphone/Electron.
- SHA256 `4d968ac99a1d0d4bc42ae8dd1552f4235e7b952a8121b39797f3dc2ca16123e9`.
- ASR requested `qwen/qwen3-asr-1.7b` (сервер не возвращает model ID); chat response model `qwen/qwen3-30b-a3b-instruct-2507`.
- `.runtime/live-20260908-013629-04ee2c/report.json`: notes один связный пункт с 3 citations, но Q&A потерял отрицание — не принят.
- `.runtime/live-20260908-013804-2f1525/report.json`: Q&A сохраняет противопоставление с S1-S3; notes вернул кириллическое `[П1]`, citations пусты — не принят. Первый ASR запрос занял 55.722 s: стабильная live latency не доказана.
- `.runtime/live-20260908-014002-f37a5d/report.json`: notes единый пункт `[P1]`, все 3 исходных сегмента, без отдельного Country; вопрос о несуществующем бюджете корректно отклонён. Q&A цитирует поддержанную вторую часть фразы S2-S3, но опускает первую: полноту gist нельзя объявлять устойчиво принятой.
- Последние задержки ASR: 1.014/1.229/1.539 s, Q&A 2.866 s, notes 0.961 s. Прочитаны сохранённые notes и 4 сообщения. Последний reported cost $0.00025990115; все три прогона $0.00079418665, во всех cost поля присутствуют. Это стоимость live API, не Claude-разработки.
- Скрипт live_smoke проверяет answer citations и сохранённый notes content, но **не проверяет непустые notes citations**; exit 0 сам по себе не является semantic acceptance.

## Следующий шаг / остаточные риски
1. Независимый read-only review завершён: `proc_d73371ed6e26` / `claude-opus-5`, session `e00bc0b5-b6f8-480c-a6aa-4f01e973b5ee`, `--tools Read --allowedTools Read --max-turns 10 --output-format json`, exit 0, modelUsage подтверждён; лог `.runtime/opus-independent-review-20260908.json`. Блокирующих дефектов миграции не найдено. Проверяющий прочитал шесть текущих файлов, но не сравнивал snapshot; сравнение тестовых diff выполнил оркестратор. Отмечены остаточные риски: неизвестная/кириллическая ссылка сохраняет notes без citations, zero-hit search может нести старые источники, budget accounting и общий лимит citations требуют отдельной приёмки. Не считать review доказательством live-качества.
2. Следующий ограниченный срез: live evaluation с обязательными notes citations, полнотой противопоставлений и проверкой неизвестных/переведённых labels. Не лечить неизвестные ID молчаливой нормализацией. Не считать prompt-only правило гарантией качества.
3. Полная лекция, RU/смешанная речь, локальная ASR, стабильная latency и физический микрофон остаются непроверенными. Микрофон только с непосредственным согласием пользователя.

Продукт **не готов**. Исправление аварийного backend-контракта проверено; общая семантическая приёмка ещё открыта. История до этого запуска: `docs/STATUS-HISTORY-20260907.md`.
