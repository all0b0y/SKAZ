# Состояние AudioHelper — миграция Soniox

## Актуальный приоритет: Soniox, подтверждённая спецификация
- Разрешение получено: production build и2Electron smoke (save-on-quit с exact PCM после restart; native transport) passed. Full frontend379passed/1прежний polling failure LocalModelsBrowser:293; typecheck passed. Scoped backend118passed/2warnings и Ruff6files passed после import-order fix. Успешный quit-путь проверен, capture barrier timeout/fail-closed и полный review ещё не закрыты. Native writer/Record и Soniox UI остаются впереди; прежний approval blocker ниже снят.
- Текущий срез: tiny PCM tail сохраняется точно, consent при open до provider/key;118scoped backend passed. Save-on-quit подключён main/preload/store (Stop/drain до backend shutdown),47targeted frontend tests и typecheck passed. **Build/production smoke нового quit НЕ исполнены: approval timeout; повтор только после согласия.** Новый scripts/save-on-quit.smoke.spec.ts непроверен. Полное review/регрессии впереди; отдельная проверка capture barrier timeout обязательна. Native writer/Record и Soniox UI всё ещё не связаны. Детали/следующий шаг вверху HANDOFF; старые результаты ниже не новая приёмка.
- Native storage I/O вынесен в thread worker с ожиданием уже начатой операции при отмене; commit/offer/rotation сериализованы. Ошибка сохранения текста сообщается без следующего PCM. Stop ACK ждёт durable status и разрешает немедленный Resume. **115 scoped backend passed**,2dependency warnings; scoped Ruff/диагностический mypy3.12 passed4files. Это локальные API-тесты, не качество ASR.
- Разрешение установки получено; ws/@types/ws установлены. Main-owned bounded native WS + IPC/preload + renderer ApiClient подключены:21targeted frontend tests, typecheck/build и1production Electron→backend smoke passed (fixture PCM, null keyring, без API/микрофона). Record/capture/store/quit пока используют прежний путь: это следующий срез, не готовая UI-миграция. Полный lifecycle, legacy async DB contention, coalescing/reconciliation остаются; подробности HANDOFF.
- Повторные проверки: frontend372passed/1failed (прежний LocalModelsBrowser polling:293); typecheck/build passed; production native Electron smoke1passed; scoped backend115passed. Full backend collection ранее блокировал missing asr.OPERATION, целиком не повторён. Capture readiness/100ms и отмена pending permission проверены (recorder10passed), renderer NativeAudioWriter2passed; writer пока НЕ подключён к store/Record. Реальных API/микрофона/помощников/commit/push нет. Дальше — история, не текущая очередь.
- Локальный native PCM WebSocket реализован ASTRA без делегации: auth/peer/Origin/Host, bounded binary frames, durable ACK, pause/resume/replay и ошибки disk/SQLite. **103 backend scoped tests passed**, Ruff/mypy(3.12) passed;2dependency warnings. Soniox forwarding/Electron/frontend ещё НЕ подключены, UI-приёмка не заявляется. Контракт `SONIOX-LIVE-API.md`.
- ASTRA самостоятельно реализовал первый native-storage срез: versioned migration, sample clock/ASR connections, cross-block stable segments, persisted drafts/restart incomplete, legacy writer/intake guards, authenticated GET live snapshot. **89 backend tests passed**, scoped Ruff/mypy(диагностический3.12) passed. Контракт/ограничения `SONIOX-LIVE-STORAGE.md`; WebSocket и соединение runtime с Soniox ещё не подключены. Полная гарантия<=1s не принята.
- Реализация `SONIOX-MIGRATION-SPEC.md` разрешена; старые ASR/experimental пути подлежат удалению после интеграции замены, пользовательские данные сохраняются. Реальные API-прогоны проводит пользователь, агент не запускает.
- Проверен первый storage-срез: ошибки fsync не выдаются за сохранение, файл/каталоги синхронизируются; RED2→GREEN,49 backend playback/ingestion passed, Ruff passed. Полная гарантия аварийной потери ≤1s пока НЕ реализована; SQLite/capture cadence остаются в работе.
- Gateway и smoke локально проверены parent: **127 backend gateway/provider/privacy/storage tests passed**, scoped mypy/Ruff, TypeScript/build passed. Исправлены зависание END-send вне deadline и сохранение событий/таймкодов smoke. websockets15.0.1 установлен в проектный venv с разрешения пользователя. Backend native live/WS/migration срез не принят. SOL остановлен по команде пользователя; далее ASTRA работает один, без делегации.
- Исходный baseline: recorder8passed,TypeScript/build passed; full frontend363passed/1failed (local model polling), backend collection blocked missing asr.OPERATION. Snapshot, процессы и точные команды в HANDOFF. Весь релиз НЕ готов.

## Исторические этапы до миграции (не текущая очередь)

## Текущий запрос: CRITIC-надёжность experimental
- Сейчас SOLhigh реализует protected fragments/Edit/Accept и tail finalization; ordinary continuation следующий пакет. Пользователь сам проводит реальные сравнения/30min, это не отменяет наши автотесты. Новый этап ещё не проверен; точный process/checkpoint в HANDOFF.
- Интервью завершено, исследование/исправления разрешены; критерии `EXPERIMENTAL-CRITICAL-SPEC.md`. Recovery-пакет реализован и проверен ниже; весь CRITIC-этап НЕ завершён, спикеры LOW.
- Последняя независимая проверка parent после finalfix:140backend passed/Ruff passed; frontend258passed/2failed (отсутствующие Edit/Accept); TypeScript/build passed;5изолированных Electron smoke passed включая recovery IPC/GET readback и refusal небезопасной изоляции. Микрофон/ASR quality этим не проверялись. Source-ended tail теперь явно finality_blocked, а НЕ успешно финализирован.
- Следующие незавершённые пункты: protected fragment edit/accept, настоящая финализация хвоста, явное ordinary continuation, сравнение на разрешённой реальной записи и30min-приёмка. Архитектурный draft `.runtime/experimental-fragment-plan.md` ещё требует parent-review. Full frontend suite остаётся красным; полной готовности нет.
- Parent baseline:24frontend lifecycle/notifier/transcript +55backend live draft/scheduler/finality passed. Это не проверка новых симптомов, качества речи или30min-прогона.
- Новые RED независимо повторены parent:6frontend failures/22passed и3backend failures/24passed. Запущен SOLhigh recovery batch (драфт/retry/stop/status/blank UI), ещё не принят. Edit/Accept, ordinary fallback и реальная приёмка — следующие незавершённые этапы.
- Recovery worker завершился; parent139backend/TS/build passed, frontend exit1. Source review выявил concurrency/restart и smoke isolation риски, SOLhigh исправляет отдельным review-пакетом. Срез пока НЕ принят; Electron parent не запускался из-за небезопасного catch sessionData в старом wrapper.
- Opus получил429quota без исполнения. Пользователь явно разрешил SOL5.6 HIGH; запущен единый диагностический пакет, runtime header подтверждает `gpt-5.6-sol/high`, workspace-write, session `01a090b1-51b3-7500-9f9a-799b441fe24f`. Результат ещё не принят; подробности и brief в HANDOFF.

## Текущий приоритет: безопасное удаление и прогресс скачивания
- Проверка GigaChat и подбор меньшей `ai-babai/gigachat-audio-mlx-q8-bf16` отложены пользователем. Experimental opt-in сохраняется; качество GigaChat не заявляется.
- Проверен ограниченный management-срез: удаление с подтверждением/предупреждением об общем кэше, отказ при активной установке/использовании, защита путей и соседних репозиториев, сброс ложного ready после частичной ошибки удаления. Исправлены двойной подсчёт байтов SDK и устаревшие ответы UI при смене модели.
- Parent независимо:232 связанных backend /241 frontend passed, TypeScript/build/Ruff passed,2 настоящих изолированных Electron smoke (отказ небезопасного запуска; decline/confirm deletion + GET readback + сохранение соседнего cache). Реальный публичный README:1998 скачанных =1998 показанных байт; веса не скачаны. Исполнитель actual `gpt-5.6-sol/high`, parent исправление CommonJS smoke — `gpt-6-astra`. Полный отчёт `.runtime/model-management-parent-verification.md`.
- Штатный full backend по-прежнему падает при collection `test_activity_log_api.py` (нет ASR OPERATION); штатный mypy blocked NumPy stub Python3.12 при target3.11, диагностический target3.12 проверяет36 source files. Полная установка больших весов/ASR и внешний security audit этим срезом не подтверждены; guards не блокируют другие приложения, использующие общий HF cache.

## UI opt-in experimental — первый срез проверен
- Реальный parent offline replay через Settings API (оба env/config flagsOFF): cachedsmall обработал publicRU42.373s за11.575s; stable28.980s, draftlag13.393s,2finals. Все invariantspassed, tempDB, без скачивания/микрофона. `.runtime/local-optin-real-replay/report.json`; complete≠весь текстfinal, это не измерение WER/livep95.
- Settings → Experimental contextual local mode → Save теперь явно сохраняет `contextual_local_enabled` (default OFF); с local-whisper разблокируется запись contextual_local без env flags. Legacy/cloud семантика сохранена. Изменение opt-in повышает ASR revision и отклоняет устаревший decode после off→on.
- Parent ASTRA независимо:217 выбранных backend tests + Ruff,229 frontend tests, TypeScript/build,3 изолированных Electron opt-in smoke — exit0. Frontend имеет act warnings в новом SettingsPanel test; исправление передано исполнителю. Это проверка включения/защит, не качества речи/физического микрофона. Полный backend по-прежнему имеет старые activity/languages/mypy blockers.
- Инцидент тестирования: первые2 executor smoke не были изолированы и могли создать2 пустые сессии/переключить opt-in в реальном профиле; пользователь уведомлён. Не выполнялась самостоятельная очистка. Исправленный wrapper `scripts/optin-smoke/main.cjs` делает app.setPath до production main; parent повторил3 smoke с проверкой реальных путей и DB под temp. Подробности HANDOFF и `.runtime/local-models-opus5-stage1.md`.
- В работе requested GPT SOL5.6/high с явного разрешения пользователя после Opus429quota: точная GigaChat MLX, удаление моделей, прогресс установки. Пока не приняты; BF16 аппаратно ограничена на текущем16GiB Mac, веса не скачиваются автоматически.

## Экспериментальный контекстный режим: готов к ручному сравнению
- Режим local contextual подключён к UI, source-first записи и автоматическому scheduler. Старые сессии/режим legacy сохранены; новый режим и speech gate/finality flags по умолчанию OFF. Контракт `LOCAL-CONTEXT-MODE.md`.
- Parent ASTRA независимо проверил writer-guard:311 backend-тестов выбранного regression target/Ruff,225 frontend-тестов, TypeScript, production build,4 Electron smoke (включая real WAV decoding) — exit0. Guards защищают immutablefinals/FTS/source links от противоположного writer в той же SQLite-транзакции; contextual lifecycle не вызывает legacyflush.
- Полный backend suite имеет прежние orphan/type blockers, не объявлен зелёным. Реальная запись из микрофона и качество live-ASR не приняты. Последний isolatedpublicRU scheduler replay: обработано42.373s, stable28.980s, draftlag13.393s; complete означает обработанное доступное аудио, не весь final. Следующий шаг — явное включение для ручного сравнения и проверка тихой речи/тишины/пауз. Диаризация пока не реализована.

## Диагностическое аудио: первый срез
- Подтверждён `AUDIO-DIAGNOSTICS-SPEC.md`: приоритет — всё исходное аудио/тишина, плеер, привязка текста к chunk; сегментация и постпроверка позже.
- Backend persistence-only POST audio/store + paginated GET audio manifest реализованы SOL. Оркестратор независимо прочитал diff ingestion/routes/repository и запустил targeted playback/ingestion/settings/session:72passed, Ruff passed/exit0.
- Contract `AUDIO-PLAYBACK-API.md`: source_kind=original_captured_wav, НЕ преобразованный вход модели. По исходной DB-связи возвращаются segment_ids, missing files остаются видимыми.
- Реализованы плеер и отдельная renderer persistence queue. Pause/stop после локального ACK передают flush_transcription=false: не вызывают старый ASR flush/retry. ASR descriptor queue ограничена вместе с failed/known, consent перепроверяется непосредственно перед upload. Отказ storage останавливает capture и требует явного retry, отставание ASR не блокирует local save.
- Последняя независимая проверка ASTRA: npm test/typecheck/smoke →**213 frontend**, types/build, **4 Electron tests включая real WAV decode** прошли exit0; backend playback/ingestion/sessions **55 passed**, scoped Ruff exit0. Полные backend pytest/mypy имеют ранее описанные посторонние блокеры. Реальный микрофон/пользовательская запись не проверены; первый технический срез готов к ручному фидбеку, качество ASR не принято.

## ASR eval acceptance correctness — 2026-09-10
- Закрыты ложные PASS из-за `NaN` CLI-порогов, неподдерживаемой версии манифеста и отсутствующей /
  несогласованной разметки critical terms. Harness/tests/docs: `scripts/asr_eval.py`,
  `acceptance/test_asr_eval.py`, `docs/ASR-EVAL.md`.
- Независимая проверка оркестратора GPT 6 ASTRA: `python3 -m unittest acceptance.test_asr_eval -v` →45 тестов, OK, без skips; scoped Ruff exit0. Самоотчёт исполнителя о wider suite не заменяет parent-проверку. Полный backend-прогон имеет прежние блокеры.
- Исполнитель `gpt-5.6-sol medium`; отдельный parent-review выполняется в этом чате. Реальная речь, микрофон и API в проверке harness не использовались. Происхождение WAV, связь recorded hypothesis с provider/model/run и достаточность выборки latency отдельно не подтверждены.
- Первый production local ASR smoke выполнен и независимо повторён оркестратором: `small`, публичный JFK11s, whole и fixed5 WER0/22. Отчёт `.runtime/asr-first-local/parent-report.json`; статус INCOMPLETE (семантика/live-latency/границы не приняты). Fixed5 ошибочно завершает фрагмент «ask not!» — нулевой WER не скрывает этот дефект пунктуации. Это English smoke, не RU/live-приёмка.

## Последняя независимая проверка
- UI подготовки локальной модели и индикатор подключены. Индикатор использует sample-weighted RMS/dBFS, sample peak, длительность аудио для предупреждения о тихом сигнале; VAD явно недоступен. Это не проверка физического микрофона.
- Оркестратор повторил `npm test && npm run typecheck && npm run smoke`: **159 frontend-тестов**, TypeScript, production build и **3 Electron smoke** прошли, exit0. Исполнитель UI/индикатора: подтверждённый `gpt-5.6-sol`, medium; оркестратор `gpt-6-astra`.
- Backend целиком НЕ зелёный: ранее выявлены collection error activity-log и 35 languages failures. Реальная ASR-приёмка, сегментация/VAD и исправления harness ещё впереди. Бюджет ASR API $3 не расходовался в этих UI-срезах.

## Предыдущий проверенный срез (исторические результаты ниже)

## Проверенный срез: каталог и выбор моделей
- Неизвестные модальности не выдаются за text; явный non-text запрещён для текстовых задач. Каталог сохраняет точные ID. Отсутствующий пользовательский OpenRouter ID допускается как непроверенный.
- Поиск по имени/ID; сохранённый выбор виден при пустом/недоступном каталоге. Сохранённая несовместимая модель видна, но disabled, с однозначной причиной.
- Ошибки chat/ASR и каталога не пересылают тело ответа/текст сетевого исключения. Полный независимый security-review ещё не принят.
- Последние проверки оркестратора: **384 backend/acceptance**, **116 frontend**, **3 Electron smoke** passed. Ruff, mypy (31 файл), TypeScript и production build passed.
- UI: actual `claude-opus-4-8`, backend начального среза actual `claude-opus-5`; последующие исправления оркестратора `gpt-6-astra/openai-codex` отделены в HANDOFF. Повторная авторизация Claude подтверждена успешным UI-запуском.

## Сейчас в работе
- Реализованы и проверены локальными тестами повторы chat/notes (не более2 попыток, только429/502/503/504/529) с общим deadline и техническими JSON-логами без payload/ключей. Actual claude-opus-5 дошёл до max_turns; оркестратор добавил wall-clock timeout и исправил незавершённый тест. Транспортные таймауты и некорректные успешные ответы не повторяются. Повтор HTTP-запроса не гарантирует отсутствие повторной тарификации.
- Это не завершение всего models-этапа. UI-журнал, реальная проверка проблемных моделей и полная независимая приёмка впереди.
- Реальные API-тесты расширения ещё не запускались; общий согласованный бюджет **$3**. Стоимость разработки не смешивается с этим бюджетом.

## Далее по подтверждённому плану
Надёжность моделей → импорт/очередь/плеер/правки транскрипции и выбираемые языки → конспекты/экспорт MD/Obsidian → универсальный Session State → память проектов → проактивные подсказки. Спецификация: `SESSION-STATE-SPEC.md`; подтверждение не означает реализацию.

## Не закрытые критерии реальной приёмки
- RU-ответы/конспекты ещё оставляют английские цитаты и могут смягчать смысл. Старые прогоны JFK/replay не прошли полную семантическую приёмку.
- ASR latency spike90s; неполнота сохранённых ссылок длинных notes (cap24); RU/смешанная реальная речь, полная лекция и локальная ASR не приняты.
- Физический микрофон требует отдельного непосредственного согласия. Smoke и mocked transport не заменяют real ASR/API.

**Продукт не готов.** Commit/push/микрофон не выполнялись. История, точные команды и авторство: `HANDOFF.md`, `SEMANTIC-EVAL-20260908.md`, `STATUS-HISTORY-20260907.md`.
