# Native live storage — проверенный первый срез

Это контракт реализованного хранения, не завершённый live-аудиопуть. WebSocket-приём PCM и соединение runtime с Soniox ещё не подключены. Реальные API не запускались.

## Версионированная миграция

`migrations.py:migrate_native_live` применяется из Database при старте: запись `native_live_v1` в `schema_migrations`, отдельные таблицы `native_recordings`, `asr_connections`, `native_audio_blocks`, `native_asr_events`, `transcript_revisions`. Старые sessions/chunks/segments/notes/citations не удаляются. Повторное открытие не повторяет миграцию. SQLite: synchronous=FULL, fullfsync=ON.

## Хранение

`LiveStore.open(session_id, sample_rate, model)` закрепляет формат и начало подключения в общей sample-шкале. Только одно активное подключение на запись. Старую файловую запись с chunks не переводит в новый режим, потому что её sample-шкала ещё не мигрирована.

`append_audio(connection_id, sequence, start_sample, pcm)` принимает PCM16 mono, до 500ms за вызов. Последовательность и сэмплы строго непрерывны. Идентичный replay идемпотентен; конфликт отклоняется. Каждый принятый блок сохраняется как исходный WAV, затем фиксируется транзакция chunks/native_audio_blocks/sample watermark. Отдельный WAV на транспортный блок — ограничение первого среза, коалесцирование блоков ещё не реализовано. Нельзя объявлять готовой экономичность долгой записи или гарантию <=1s от захвата.

`audio_storage.write_audio_file` общий для старого ingestion и нового пути: file flush/fsync, Darwin F_FULLFSYNC, atomic rename, fsync каталогов. Ошибка не выдаёт ACK. Это не эксперимент с отключением питания и не доказательство аппаратной долговечности.

`save_event(connection_id, ordinal, SonioxEvent)` сохраняет final delta по стабильному UUID и ревизии1, partial отдельно как draft. Проверяются порядок, конфликтующий replay, processed ranges и полнота source ranges. Один segment может ссылаться на несколько chunks; существующие repository/FTS/audio manifest читают такие источники. Сегмент не пересоздаётся при повторном событии. Ручные правки и последующие ревизии ещё не подключены.

Старые final writers не могут писать в native-recording. Старый audio/store также отклоняет такую запись (409). Эти guards нужны до удаления старых путей.

`close` закрывает запись подключения, не удаляет draft. `recover_interrupted` вызывается Runtime один раз при запуске: оставшиеся active становятся incomplete с концом на saved_samples. Это восстановление метаданных; сверка всего архива с файловой системой и автоматический reconnect ещё впереди.

## Чтение через API

`GET /sessions/{session_id}/live` — стандартные HTTP loopback/origin/token guards. Возвращает `session_id`, `sample_rate`, `saved_samples`, `next_sequence`, `connections` (id/model/start/end/final/processed samples/status/ordinal/draft_json). Не возвращает файловые пути или ключи. Неизвестная/не-native запись —404, без авторизации —401. Поля draft_json служебные; UI-контракт ещё будет уточнён вместе с событийным WS.

## Проверки ASTRA, без делегации

Из backend:

`.venv/bin/python -m pytest tests/test_native_live_store.py tests/test_native_live_api.py tests/test_sessions_api.py tests/test_audio_playback_api.py tests/test_audio_ingestion.py tests/test_soniox_gateway.py -q` → **89 passed**, exit0.

Scoped Ruff новых модулей/тестов, ingestion/runtime → passed. Scoped strict mypy новых3модулей+2тестов с `--python-version 3.12 --follow-imports=silent` → passed5files. Стандартный target3.11 blocked установленными NumPy3.12 stubs; диагностический3.12 не подменяет полную проектную проверку.

RED→GREEN: отсутствие live_store; старый final writer не отклонял native; отсутствовало восстановление interrupted; отсутствовали Runtime.live_store/API snapshot. Дополнительно: старый DB без mode/таблицы миграций читается после двух открытий; cross-block source IDs сохраняются; replay/order/resume/late event/delete guards; draft не входит в final/FTS; HTTP auth и legacy intake guard.

## Следующий шаг

Нативный backend WebSocket: собственные WS authorization/origin/session guards, bounded binary PCM framing, приём/сохранение независимо от send/receive Soniox, явные gaps, bounded finish/shutdown/reconnect. Затем Electron bridge и frontend. Остальные незавершённые требования остаются в SONIOX-MIGRATION-SPEC.md, не считаются принятыми этим срезом.
