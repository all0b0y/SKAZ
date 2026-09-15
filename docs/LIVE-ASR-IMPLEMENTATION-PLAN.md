# Контекстный live ASR — план реализации

Автор архитектуры: оркестратор GPT 6 ASTRA в основном чате. Внешний Codex ASTRA/high не стартовал: CLI0.149.1 отверг модель HTTP400 (нужна новая CLI). Его результатом этот план не является. Реализация по умолчанию SOL/medium, с отдельным parent-review.

## Проверенная текущая система
- `frontend/src/audio/recorder.ts`: независимые5s окна; `persistenceQueue.ts` сначала сохраняет WAV, `transcriptionQueue.ts` подаёт дисковые descriptors по одному на ASR.
- `backend/src/audiohelper/ingestion.py:IngestionService.ingest/_transcribe_chunk`: один chunk → один decode → `repository.replace_chunk_segments`.
- `repository.replace_chunk_segments` сразу пишет текст в `segments` и `segments_fts`; `list_segments/segments_in_range/search_segments` читают эти final-записи.
- `db.py:SCHEMA`, `schemas.py:Segment`: нет draft/revision/нескольких источников; `sequence` связывает segment только с одним исходным chunk.
- Persistence-only POST audio/store и manifest GET audio, player по original captured WAV уже есть. Pause/stop с `flush_transcription=false` не запускают скрытый ASR flush.
- Local presence gate opt-in: no speech → []; speech →полный массив, без VAD trimming. DefaultOFF. RU24 наблюдения не заменяют приёмку коротких речевых начал/естественной комнаты.
- Граф проекта generation2026-09-08T19:11:44Z устарел для dirty code; найденные символы сверены напрямую. Ниже новые сущности явно ПРЕДЛАГАЮТСЯ.

## Архитектурное решение
Архивный chunk — единица сохранения/повтора, ASR window — отдельный диапазон нескольких chunk. Не заменять архив на обрезанную VAD-копию.
Модуль `live_asr` (предлагается) скрывает сборку контекста, планирование/согласование гипотез, восстановление и provenance за небольшим interface: обработать новые сохранённые данные, получить snapshot, закрыть capture.
Первый adapter — local-whisper. Cloud pipeline остаётся legacy с явной меткой, без скрытого fallback или дополнительных платных запросов.
Кандидат window всегда привязан к исходным sample ranges/hash. Пробел/смена sample rate/повреждённый файл не склеиваются молча и не заменяются тишиной.

## Минимальная первая вертикаль: контекстный preview, ещё не live final
Предлагается authenticated `POST /sessions/{id}/asr/preview` с first_sequence/last_sequence для целых сохранённых source chunks.
- Только выбранный local-whisper профиль, явный вызов. Никаких автоматических cloud/weight downloads.
- Проверить существование сессии, диапазон, все chunks, временную непрерывность, формат и общий размер/длительность до decode.
- Использовать существующий лимит `max_chunk_seconds` как cap ASR window, НЕ как утверждение о конце фразы. Пока запрос больше cap явно отклоняется, не обрезается.
- Сборка PCM в sample order, проверка digest каждого файла; единый ресемплинг после сборки, а не отдельное изменение каждого куска. Sample precision отдельно от округлённых UI milliseconds.
- Ответ: state=draft, текст, snapshot model/language, доверенные window/source ranges/hash и original-captured/source transformation designation. Новый draft не получает citation segment_id.
- Не менять chunks.status, segments, FTS, notes, existing final transcript. Никакого вызова replace_chunk_segments.
- Полный ASR text в ответе — недоверенные данные, не инструкции. Некорректные model timestamps не используются для доказательства source boundary.
- Этот endpoint позволяет реально сравнить isolated5s и объединённое окно на одном аудио, не подменяя им итоговую транскрипцию пользователя.

## Дальнейший scheduler и фиксация
Предлагаемые state: capture epoch, received watermark, stable frontier, current window, latest draft revision, busy/lag/blocker. Хранить только активный PCM window и одну текущую decode; всё остальное на диске.
1. Новые подтверждённые записи отмечают watermark; пока decode занят, coalesce до последнего доступного watermark вместо очереди одинаковых устаревших распознаваний.
2. VAD speech probabilities помогают найти акустическую паузу и сохранить pre-roll/post-roll. Это не sentence detection; речевой интервал не равен законченному предложению.
3. При непрерывной речи расширять окно до cap; предыдущий контекст держать за stable frontier. Cap/cadence ограничивают ресурсы, но не превращают unstable tail в final.
4. Кандидат commit — совпадающий лексический префикс двух гипотез с РАЗНЫМ последующим аудиоконтекстом. Повтор того же запроса/хеша не считается независимым подтверждением.
5. Нужна монотонная привязка слов к времени/вхождениям; `word_timestamps` — оценка, не абсолютная истина. Повторяющиеся слова/нестабильный язык/некорректные offsets оставлять в draft, не dedupe глобальным поиском слова.
6. Не фиксировать хвост у текущего правого края; параметры guard/overlap/cadence измеряются. Фиксация текста не означает вставку точки/абзаца или конец предложения.
7. Если frontier не продвигается и cap достигнут — видимый stalled/backlog, оригинал продолжает сохраняться. Не растить RAM бесконечно, не выкидывать хвост. Такой случай блокирует live-приёмку и требует явной обработки более длинного интервала/ручной проверки.
8. Pause/stop после durable ACK прекращают получение микрофона, разрешают финальный decode хвоста, но не объявляют сомнительную гипотезу final только из-за stop. Нужная для ещё неустойчивого хвоста явная подтверждённая обработка остаётся видимой; auto-paid retry запрещён.

## Draft/final/provenance
Предлагаются отдельные `live_asr_state`/draft snapshot и `segment_sources` (segment_id, session_id, sequence, sample offsets/hash). Конкретная SQLite migration идёт отдельным тестируемым срезом.
Старые `segments` остаются final; immutable final IDs сохраняют citations. Старые sequence-based источники остаются legacy source, история model/input не выдумывается.
Транзакция commit одновременно добавляет final segment, FTS и source links, продвигает frontier, заменяет draft revision. Дубликат request/revision не вставляет текст повторно.
Обычные repository range/FTS/agent/notes читают только final таблицу; draft не смешивается со списком Segment даже временно.
Manifest/player должны поддержать несколько source ranges для нового final; UI явно показывает окно ASR против исходных архивных кусков.
Preview из первой вертикали без сохранения не требует migration; durable draft/commit появляется только во второй.

## UI и восстановление
- Единый поток: final prefix + визуально отличимый revisable draft. Никаких абзацев по5s. Определение участника отдельно позже.
- Для нового local live режима не вызывать одновременно legacy per-chunk decoder: это двойная работа и два противоречащих транскрипта.
- Persisted state/epoch + source digests восстанавливаются после перезапуска. Старый in-flight результат с иной epoch/model/language/revision отбрасывается.
- Смена модели/языка требует завершения/отмены старой epoch; данные уже подтверждённых сегментов не переписываются. Очереди не наследуют новые настройки молча.
- Pause gap не превращается в искусственные записанные samples; missing source gap останавливает сборку. Удаление сессии отменяет pending work, stale reply не воскрешает DB.
- UI latency показывает captured/processed/stable watermarks раздельно; batch inference seconds не выдаются за p95 phrase latency.

## Четыре SOL-среза (каждый parent проверяет до следующего)
1. **Preview нескольких источников**: read-only оконная сборка+endpoint+реальный local replay.
   RED: два сохранённых chunks дают единый decoder input; missing/gap/hash mismatch/oversize rejected; draft отсутствует в session final/FTS/agent, файлы неизменны; cloud отвергнут до сети.
   GREEN: targeted API/ingestion/source tests, Ruff, types; runtime replay на public RU+JFK. Не заявлять готовый live.
2. **State/commit/finality seam**: durable epoch/draft/revisions/source mapping + scheduler/local-agreement.
   RED: многократное replay без нового аудио не продвигает frontier; повтор слов не удаляется; source links точны; atomic commit/idempotence/restart/cancel; draft не попадает Q&A/notes.
   Сначала state machine с контролируемыми decoder hypotheses, затем реальная локальная речь. Никаких broad schema refactors.
3. **Local live integration/UI**: persistence ACK →coalescing scheduler, snapshot → единый поток, source-range playback; ручной opt-in для нового режима.
   RED: live uploads продолжают сохраняться при slow ASR, fixed archive boundary не final boundary, draft rewrites без дублей; pause/stop/model switch/long-monologue cap не теряют original. Existing cloud legacy работает отдельно.
4. **Приёмка и настройка**: сравнить old/new на одинаковых source hashes; натуральная/контролируемая тишина, short/quiet onset, паузы внутри фразы, длинная речь без пауз, слова на5s границе, RU+английские термины.
   WER + смысл/слова на стыках + тишина + p95 от реального phrase end, длина очереди/RAM. Ни синтетическая речь, ни source-reference proxy не gold acceptance.

## Команды
`backend/.venv/bin/python -m pytest <новые tests> backend/tests/test_audio_playback_api.py backend/tests/test_audio_ingestion.py backend/tests/test_sessions_api.py -q`
`backend/.venv/bin/ruff check <изменённые backend файлы>`
`npm test && npm run typecheck && npm run smoke` при UI/IPC изменениях.
Mypy с target3.11 сейчас имеет optional NumPy stub blocker; actual3.12 diagnostic отдельно, не скрывать full backend activity-log/languages RED.
Все новые SOL briefs требуют собственный MCP+coverage и список вызовов, direct source, точные execution evidence. Приватное аудио/микрофон требуют отдельного согласия; runtime network/weights/cloud API не разрешаются самим планом.

## Что не обещаем
Local agreement не доказательство истинности ASR; две одинаковые галлюцинации возможны. Presence gate и реальные silence tests независимы.
Пение/TV/background source identity, overlap speakers, diarization НЕ покрываются VAD. Они остаются отдельными утверждёнными последующими требованиями.
Первая вертикаль полезна для диагностики, но старый live-путь не исправится до срезов2–3. Никаких меток «готово» всему этапу по одному endpoint.
