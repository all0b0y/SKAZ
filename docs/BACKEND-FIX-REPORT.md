# Backend fix report

Owner: backend worker (model `claude-opus-5`, no delegation, no model substitution).
Scope touched: `backend/**`, `acceptance/test_regressions.py` (added tests only), this file.
Nothing committed, nothing pushed. `.env` was never read.

## Стартовое состояние (не то, что описано в BACKEND-REPORT.md)

Предыдущие исполнители остановились на лимите и оставили дерево частично сломанным.
Фактический baseline, измеренный первым делом:

```
uv run --project backend pytest acceptance -q --tb=short   → 3 passed, 1 failed
cd backend && uv run pytest -q                             → 118 passed, 4 failed
cd backend && uv run ruff check .                          → 7 errors
cd backend && uv run ruff format --check .                 → 5 files would be reformatted
cd backend && uv run mypy                                  → 3 errors
```

Три из четырёх координаторских регрессий уже были починены предыдущей сессией
(consent на текст, `Что сейчас обсуждают?` → recent, `первые 5 минут` → bounded
beginning), и выделенный OpenRouter STT-адаптер уже существовал. Эта работа
продолжена, а не переписана. Цифра «111 passed» из `BACKEND-REPORT.md` —
историческая и на момент старта не воспроизводилась.

## Итог

```
cd backend && uv run pytest -q                → 150 passed          (exit 0)
cd backend && uv run ruff check .             → All checks passed!  (exit 0)
cd backend && uv run ruff format --check .    → 42 files already formatted (exit 0)
cd backend && uv run mypy                     → Success: no issues found in 41 source files (exit 0)
uv run --project backend pytest acceptance -q → 13 passed           (exit 0)
```

Итого 163. Координатор независимо получил 159 на предыдущем срезе (150 + 9);
после этого добавлены 4 acceptance-теста на выделенный STT-контракт (см. §8).
`backend/scripts/live_check.py` дополнительно проверен: `python -m py_compile` и
`uv run mypy scripts/live_check.py` → Success (в основной `mypy` он не входит,
`files = ["src", "tests"]`).

Окружение: uv 0.11.6, Python 3.12.13, macOS arm64 (Darwin 25.6.0), fastapi 0.141.1,
pydantic 2.13.5, httpx 0.28.1, pytest 9.1.1, mypy 2.3.1, ruff 0.16.6.
`requires-python = ">=3.11"`, ruff/mypy настроены на 3.11 — поэтому f-string с
обратным слешем в `agent/ask.py` был реальным нарушением переносимости, а не стилем.

Все внешние вызовы в тестах подменяются **только** на транспортном стыке
(`httpx.MockTransport`). Живых платных вызовов не делалось — это зона координатора.

---

## 1. Каталог ASR: dedicated STT против legacy audio-LLM

Проверено по реально сохранённому ответу `.runtime/stt-models.json`
(`GET /api/v1/models?output_modalities=transcription`, 20 моделей, `links.next: null`
— пагинация не нужна). Формат подтверждён: `architecture.modality: "audio->transcription"`,
`input_modalities: ["audio"]`, `output_modalities: ["transcription"]`.

- `GET /models?provider=openrouter&task=asr` теперь склеивает **два** источника:
  отфильтрованный STT-листинг, затем — audio-input чат-модели из общего каталога.
  Каждая запись помечена новым полем `asr_contract`: `"dedicated"` или `"legacy"`.
- Порядок: сначала dedicated (внутри — `qwen/qwen3-asr-1.7b` первым), затем legacy.
  `recommended: true` возможен **только** у dedicated.
- У legacy-записи `verified` принудительно `false`, а `note` прямо говорит, что это
  audio input chat model, не выделенный STT-контракт, и качество не подтверждено.
- Текстовые и image-only модели в ASR-пикер не попадают вообще.

**Почему legacy не выкинут из списка совсем.** Координаторский acceptance-тест
`test_request_for_audio_is_not_a_verified_transcription` требует, чтобы
`google/gemini-2.5-flash-lite` присутствовал в `task=asr` с `verified: false`.
Полное исключение сделало бы тест `StopIteration`, а не «зелёным». Компромисс:
модель остаётся в ответе, но явно дискриминирована полем `asr_contract`, так что
нормальный пикер во фронтенде фильтрует по `asr_contract === 'dedicated'`, а
legacy — осознанный advanced-выбор. Скрытых миграций и fallback-ов между
контрактами нет: адаптер выбирается по объявленной output-модальности каталога,
никогда по имени семейства.

Для контроля я заменил ранее написанный backend-тест
`test_asr_task_lists_only_dedicated_transcription_models` на более точный набор
(`..._puts_dedicated_transcription_models_first`,
`..._is_offered_only_as_legacy`, `..._text_only_models_never_appear...`,
`..._dedicated_asr_model_is_not_offered_for_chat_tasks`). Утверждения усилены, не ослаблены.

### Побочный реальный баг, который это чинило

`_fits()` для `task=asr` требовал `emits_transcription`, но записи `local-whisper`
объявлялись как `output_modalities: ("text",)`. В результате
`GET /models?provider=local-whisper&task=asr` возвращал **пустой список** — локальный
Whisper вообще нельзя было выбрать. Исправлено: и faster-whisper checkpoints, и
модели OpenAI `/v1/audio/transcriptions` теперь честно объявляют
`output_modalities: ("transcription",)`. Побочный полезный эффект: STT-модели больше
не предлагаются для задач agent/notes.

### Устойчивость классификации

`openrouter_asr_kind()` теперь смотрит и в отфильтрованный, и в общий каталог.
Раньше временная 503 на `?output_modalities=transcription` приводила к тому, что
настоящая STT-модель не находилась ни как dedicated, ни как legacy, и `PUT /settings`
отдавал 400. Проверено тестом
`test_dedicated_model_stays_dedicated_when_the_stt_listing_is_down`; я подтвердил,
что он падает (400 вместо 200) на старой логике.

### max_output и цена

`max_output_tokens` берётся из `top_provider.max_completion_tokens` (у STT-моделей
там `0` → отдаём `null`, не выдумываем). Цена отдаётся **только** там, где единица
измерения подтверждена: `qwen/qwen3-asr-1.7b` → `{amount_usd: 0.0000075, unit: "second"}`
по странице модели. Реальный дамп подтверждает, что единицы у вендоров разные:
`openai/whisper-1` в том же поле `pricing.prompt` = `0.006` (это USD/минуту),
`microsoft/mai-transcribe-2` = `0.1`. Поэтому для остальных цена не публикуется —
угадывать единицу нельзя.

## 2. Разбор ответа STT

`_pieces_from_openai` укреплён: контрактным считается только `text`; `segments`,
`usage`, `language` необязательны. Не-dict элементы, `None`/строковые/NaN/inf
таймстемпы больше не роняют запрос в 500 и не теряют транскрипт — кусок
откатывается к окну чанка. `text` принимается и строкой, и списком content-parts.
Покрыто параметризованным тестом `test_optional_transcription_fields_parse_safely`
(8 форм ответа) и `test_empty_transcription_is_not_a_verified_model`.

## 3. Границы контекста

Реальные баги, найденные и починенные:

1. **Одна огромная реплика вылезала за бюджет.** В `_fit` ветка обрезки считала
   `prefix_size = max(1, remaining - len(marker) - 1)`: при `remaining = 5` она
   выдавала строку в 21 символ. Теперь обрезанная строка гарантированно не длиннее
   остатка бюджета. Тест — параметризованный по бюджетам `[1, 5, 19, 21, 120, 400]`.
2. **Исчерпанный бюджет выдавался за отсутствие речи.** Если ни одна строка не
   помещалась, `body` становился `NO MATCHING TRANSCRIPT`, то есть модель получала
   утверждение «в записи ничего нет». Теперь это отдельная честная пометка
   «бюджет слишком мал, не делайте вывод об отсутствии темы».
3. **Пол в 256 символов перекрывал настроенный бюджет.**
   `transcript_budget = max(256, max_context_chars - len(memory_text))` игнорировал
   `max_context_chars` меньше 256 — из-за этого `truncated` не выставлялся.
   Теперь бюджет делится явно: история ≤ 1/5, перенесённые источники ≤ 1/5,
   транскрипт — остаток; весь промпт удерживается внутри `max_context_chars`.

## 4. История чата, конспект и исходные источники

Для follow-up вопросов уже подставлялись прошлые сообщения, последний конспект и
процитированные ранее сегменты — но сегменты **вливались в основной блок
транскрипта**. Это тихо расширяло окно: вопрос «что сейчас обсуждают» после
любого ответа про начало записи получал в контекст и начало тоже.

Теперь перенесённые источники рендерятся отдельным блоком
`EARLIER TRANSCRIPT LINES YOU ALREADY CITED` с собственными метками (label offset),
а окно `recent`/`beginning` остаётся ровно тем, что вернул scope-резолвер.
Цитаты резолвятся по обоим блокам (`ctx.citations_from`). `context.start_ms/end_ms`
описывают именно разрешённое окно и больше не расходятся с реальностью.

Покрытие: `test_carried_over_sources_do_not_widen_the_recent_window`,
`test_citations_resolve_across_two_context_blocks`, и в acceptance —
`test_follow_up_question_keeps_history_notes_and_original_sources`.

## 5. Пустой поиск

Восстановлена инструкция `do not use any [S...] labels` (её потеряли при переписывании
`_user_prompt`; она была добавлена после живого прогона, потому что модель печатала
несуществующие метки). Она ставится только когда цитировать реально нечего —
ни в окне, ни в перенесённых источниках.

Отдельно закреплено, что пустой лексический поиск сообщает только об отсутствии
**лексического совпадения** и не объявляет, что темы нет во всей записи.
Тесты: `test_empty_search_reports_only_the_lexical_evidence` (backend) и
`test_empty_search_does_not_claim_absence_beyond_lexical_evidence` (acceptance).

## 6. Связный смысл и отсутствие буллета из одного слова

Правила в system-промптах `ask` и `notes` («chunk boundaries are not ideas»,
«do not present a repeated standalone trailing word as a separate substantive point»)
были на месте от предыдущей сессии, но ничем не защищены. Добавлен acceptance-тест
`test_gist_and_notes_prompts_forbid_chunk_boundary_bullets`, который проверяет оба
промпта на стыке API. Это защита от регрессии формулировок, **не** доказательство
качества модели — оно требует живого прогона (зона координатора).

## 7. Ingestion: конкурентность, дубликаты, метаданные

Честная оценка: **внутрипроцессной гонки не было**. Между `get_chunk` и
`insert_chunk` нет ни одного `await`, а event loop однопоточный, поэтому две
одновременные загрузки одного sequence не могли пересечься в критической секции.
Я это проверил экспериментально, а не на глаз: тесты с `asyncio.gather` проходят
и на старом неатомарном INSERT.

Что изменено — это укрепление инварианта на уровне хранилища, а не починка
воспроизводимого бага:

- `insert_chunk` использует `ON CONFLICT(session_id, sequence) DO NOTHING` и
  возвращает `bool`. Проигравший претендент получает запись победителя и валидируется
  против неё (sha256 + start_ms/end_ms) → корректный `409`, а не `IntegrityError`/500.
  Это доказуемая смена поведения, закреплённая
  `test_a_chunk_sequence_can_only_be_claimed_once` (на старом коде тест падает
  с `IntegrityError`).
- Порядок изменён на «сначала атомарно занять слот, потом писать аудио», поэтому
  проигравший вообще не трогает диск и не может подменить байты победителя.
- **Реальное улучшение долговечности:** запись идёт во временный `.part` и потом
  `os.replace` — оборванная запись больше не оставляет усечённый WAV, выглядящий
  как целый чанк. `DELETE /sessions/{id}` сносит каталог целиком (`rmtree`), так
  что осиротевшие `.part` не накапливаются.

Тесты `test_concurrent_conflicting_sequence_keeps_the_stored_audio_consistent` и
`test_concurrent_conflicting_metadata_is_rejected_not_silently_merged` закрепляют
инвариант на HTTP-стыке (один 200 + один 409, байты на диске совпадают с
победителем), но, как сказано выше, они проходят и без изменений — это покрытие,
а не доказательство фикса. Не выдаю их за большее.

## 8. Выделенный STT закреплён на acceptance-стыке

Координаторская фикстура `api` использует `google/gemini-2.5-flash-lite`, то есть
**legacy** audio-chat путь. Выделенный контракт ею не проверялся вообще. Добавлена
отдельная фикстура `stt_api` (существующая не тронута) и 4 теста:

- `test_dedicated_stt_uses_the_transcriptions_endpoint_not_chat` — фиксирует точный
  провод: URL `https://openrouter.ai/api/v1/audio/transcriptions`, тело
  `{model, input_audio:{data:<base64>, format:"wav"}, response_format:"json"}`,
  `language` **отсутствует** при автоопределении, и ни одного обращения к
  `chat/completions`.
- `test_dedicated_stt_becomes_verified_only_after_a_real_transcription` — до вызова
  `verified: false` и в каталоге, и в `/settings`; после реальной транскрипции — `true`.
  Заодно проверяет `asr_contract: "dedicated"`, `recommended: true` и
  `pricing: {amount_usd: 0.0000075, unit: "second"}`.
- `test_empty_dedicated_transcription_does_not_count_as_verification` — HTTP 200 с
  пустым текстом (тишина) не является доказательством способности к ASR.
- `test_consent_revocation_blocks_audio_before_any_outbound_post` — после отзыва
  согласия аудио не уходит наружу вообще (проверяется отсутствие POST, а не только код).

## 9. Единый гейт согласия

`ingestion._transcriber` дублировал проверку согласия инлайном вместо общего
`require_cloud_consent`. Семантика и текст ошибки совпадали, но правило жило в двух
местах. Сведено к одному гейту: аудио — `require_cloud_consent(..., "audio")`,
текст вопроса и конспекта — `require_cloud_consent(..., "transcript text")`.
Все три места проверяют согласие **до** построения gateway и, соответственно, до
любого исходящего POST.

Сознательное исключение: `GET /models` согласия не требует. Он отправляет провайдеру
только ключ и не передаёт ни аудио, ни транскрипт; требовать согласия до того, как
пользователь вообще увидел список моделей, сделало бы настройку невозможной.

---

## Точные настройки для живого прогона (зона координатора)

Живых вызовов я не делал: ни ключей, ни `.env`, ни личных записей не читал.
Ниже — ровно то, что нужно, чтобы координатор запустил приёмку на реальной речи.

### Запуск процесса

```bash
AUDIOHELPER_TOKEN=<per-run token> \
AUDIOHELPER_DATA_DIR=<dir> \
OPENROUTER_API_KEY=<key> \
  uv run --project backend python -m audiohelper --port 0
```

Процесс печатает в stdout `{"event": "listening", "host": "127.0.0.1", "port": N}`.
Ключ берётся из OS keychain, при отсутствии — из переменной окружения
(`OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`). В БД, ответы API и
логи ключи не попадают; в `/settings` только `has_api_key`.

### Профиль для выделенного OpenRouter STT

```http
PUT /settings
{
  "asr":   {"provider": "openrouter", "model": "qwen/qwen3-asr-1.7b"},
  "agent": {"provider": "openrouter", "model": "qwen/qwen3-30b-a3b-instruct-2507"},
  "notes": {"provider": "openrouter", "model": "qwen/qwen3-30b-a3b-instruct-2507"},
  "transcript_language": "auto",
  "output_language": "ru",
  "cloud_consent": true
}
```

`transcript_language: "auto"` обязателен для смешанной RU/EN речи: при `auto`
поле `language` в запрос к провайдеру **не кладётся** вообще (не отправляется
строка `"auto"`). Явный язык кладётся как есть.

Что уходит на провод при загрузке чанка:

```http
POST https://openrouter.ai/api/v1/audio/transcriptions
Authorization: Bearer <key>
{"model":"qwen/qwen3-asr-1.7b","input_audio":{"data":"<base64 wav>","format":"wav"},"response_format":"json"}
```

### Скрипт живой проверки

```bash
OPENROUTER_API_KEY=<key> \
  uv run --project backend python backend/scripts/live_check.py <base_url> <token> <wav_path>
```

По умолчанию теперь берётся **выделенный** `qwen/qwen3-asr-1.7b` (раньше был
захардкожен legacy `google/gemini-2.5-flash-lite` — живой прогон не проверял бы новый
контракт вообще). Переопределяется без правки кода:
`AUDIOHELPER_LIVE_ASR_MODEL`, `AUDIOHELPER_LIVE_TEXT_MODEL`. Скрипт печатает JSON-отчёт
и дополнительно фиксирует провенанс: блок `asr_contract` (dedicated/legacy, цена,
сколько dedicated и legacy моделей в каталоге) и блок `verification` с
`verified`/`verification_note` по всем трём профилям. Если выбранная модель окажется
legacy, скрипт печатает предупреждение в stderr. Секретов не печатает.

### На что смотреть в результате

- Каталог: `GET /models?provider=openrouter&task=asr` должен вернуть ~20 dedicated
  моделей (реальный дамп: `total_count: 20`, `links.next: null`) и следом legacy-кандидатов.
- `verified` у ASR становится `true` **только** после фактически успешной транскрипции
  на этой установке; при legacy-модели он не станет `true` никогда, это by design.
- Цена: у `qwen/qwen3-asr-1.7b` ожидается ~0.0000075 USD/сек; отчёт координатора
  должен зафиксировать фактическую стоимость прогона.
- Стоимость/токены в БД не сохраняются (см. ограничения), считать придётся по отчёту
  провайдера.

### Чего живой прогон ещё не покрывает

Физический микрофон, разрешения ОС и выбор устройства — только через Electron, это
не мой слой. Приёмка «реальная человеческая речь до окончания записи» требует
запуска desktop-приложения, а не только этого скрипта.

---

## Изменения контракта: только аддитивные

`docs/API.md` не редактировался (он не мой). Новое поле для координатора и UI:

| Поле | Где | Значение |
|---|---|---|
| `CatalogModel.asr_contract` | `GET /models?task=asr` | `"dedicated"` \| `"legacy"`. Для `task=agent`/`notes` — `null`. Пикер по умолчанию должен показывать `dedicated`. |

Ранее задокументированные аддитивные поля (`Profile.verified`,
`Profile.verification_note`, `AudioResponse.pending`, `AskContext.truncated`,
`CatalogModel.output_modalities/max_output_tokens/pricing/recommended/note`)
сохранены. Обязательные поля контракта не менялись, ничего не удалено.

## Что осталось непроверенным

1. **Живых вызовов не делал.** Выделенный OpenRouter STT-эндпоинт
   (`POST /api/v1/audio/transcriptions`) покрыт только mock-транспортом; реальный
   `qwen/qwen3-asr-1.7b` в этой сессии не вызывался. Формат запроса собран строго
   по документации и по реальному каталогу, но контракт ответа живьём не подтверждён.
   Пока ни одна модель не получит `verified: true` без фактического успешного вызова
   на этой установке.
2. **local-whisper по-прежнему не запускался** — веса не качались, `verified: false`
   честный. Каталожный баг (пустой список) починен, но сама транскрипция не проверена.
3. **OpenAI ASR и Anthropic chat** — только mock-транспорт, живых ключей нет.
4. **Качество ответа и конспекта** (связный смысл, отсутствие буллета из последнего
   слова) закреплено только на уровне промпта. Улучшение с живой моделью не измерено —
   нужен повторный прогон координатора. Замечание из `INTEGRATION-FINDINGS.md` про
   наивную нарезку на 5 секунд (`ask not But your country...`) **не адресовано**:
   VAD-выравнивание/перекрытие границ чанков не реализовано, это отдельная задача.
5. **usage/стоимость по-прежнему не сохраняются в БД** — поле `usage` из ответов
   парсится безопасно, но не персистится. Для бюджетов из `PRODUCT.md` это нужно.
6. **Стриминга нет** (по контракту v0).
7. **Поиск по теме** — FTS5 с префиксным усечением, без стемминга и эмбеддингов;
   на редких словоформах может промахнуться. Теперь это хотя бы честно сообщается
   модели как «нет лексического совпадения», а не как «темы не было».
8. Микрофон, разрешения ОС и Electron не трогал — зона фронтенд-исполнителя.
9. **WER/CER на русской и смешанной речи не измерялся.** `QUALITY.md` требует
   RU / EN / смешанную речь с ручной эталонной расшифровкой. Код к этому готов
   (`transcript_language: "auto"` не отправляет `language` провайдеру), но самой
   метрики нет — её может дать только живой прогон координатора.
10. **Гонка при загрузке чанков осталась недоказанной, потому что она недостижима**
    (см. §7): между `get_chunk` и `insert_chunk` нет `await`. Два добавленных
    HTTP-теста на конкурентность проходят и на старом коде — это покрытие инварианта,
    а не доказательство фикса. Доказательная смена поведения одна:
    `test_a_chunk_sequence_can_only_be_claimed_once` (на старом коде падает с
    `IntegrityError`).
