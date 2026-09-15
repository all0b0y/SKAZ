# Native recording configuration

Локально проверенный API/transport-срез. UI выбора режимов и отображения перевода ещё не реализован; реальные Soniox API/микрофон не использовались.

## Предпочтения и запись
- `used_languages`: null до явного выбора; PUT принимает непустой список уникальных ISO-кодов из `supported_languages` в GET settings. Omission/null сохраняют выбор; [], повторы и неподдерживаемые коды отклоняются422 атомарно. Каталог основан на https://soniox.com/docs/stt/concepts/supported-languages, не требует ключа/сети.
- Settings → System → «Используемые языки»: dropdown с checkbox и «Выбрать все». Первый desktop Record блокируется до выбора/сохранения, до создания сессии/захвата. Старые RU/EN fragment switches и поле auto в настройках заменены этим выбором; legacy transcript_language остаётся только в совместимом API.
- Additive `native_languages_v6`: used_languages фиксируются при первом open и сохраняются при Pause/Resume/rotation/restart; GET live возвращает parsed список, не storage JSON. Старые записи остаются с null без приписанного ограничения. Для обратной совместимости прямой WS с ещё не заданными preferences допускает null; обязательный onboarding исполняется desktop store, не является новым auth-ограничением WS.
- Gateway при непустом выборе отправляет `language_hints` + `language_hints_strict: true`. При историческом null сохраняет прежний auto-contract без hints. По https://soniox.com/docs/stt/concepts/language-restrictions это best-effort, identification остаётся технически активным; абсолютный запрет других языков не обещается.
- GET/PUT `/settings`: `native_recording_mode` и `translation_target_language` — предпочтения следующей записи. Сохранение само по себе не запускает сеть, обработку или cloud consent.
- При первом успешном native `open` SQLite фиксирует `recording_mode` и `translation_target_language` в `native_recordings`, в одной транзакции с созданием connection. Даже без первого PCM конфигурация уже принадлежит записи.
- Subsequent open (Pause/Resume, restart, provider rotation) продолжает прежнюю запись с её режимом, языком и sample clock. Изменение settings не изменяет эту конфигурацию. WS hello не принимает overrides.
- GET `/sessions/{id}/live` возвращает оба поля рядом с saved_samples/connections. Клиентские поля optional для совместимости с прежними snapshot fixtures; текущий backend возвращает их для каждой native записи.
- Миграция `native_recording_config_v4` additive: существующие native записи получают `transcription`/`ru`, а не актуальные preferences. Старым оригиналам не приписывается режим перевода; `ru` в transcription — сохранённый default, не утверждение о языке речи.

## Выполнение
| Режим | Soniox | Сохранение |
|---|---|---|
| transcription | Только при consent и ключе; translation отсутствует в config | Исходное аудио и распознанный оригинал |
| translation | Только при consent и ключе; `translation={type:one_way,target_language:<stored target>}` | Исходное аудио, оригинал и отдельные untimed translation tokens |
| audio_only | Ключ Soniox не читается, provider worker/socket не создаётся | Только исходное аудио |

Настройки/open/key lookup сериализованы с отзывом consent. Consent остаётся динамическим разрешением, не частью immutable конфигурации: отзыв закрывает provider, сохраняя локальную запись. Изменение preferences не разрешает скрытую обработку пропущенного аудио.

`stream.opened.transcription=disabled` означает намеренное audio_only; Electron transport принимает его как нормальное открытие. GET во время capture тоже disabled, после закрытия inactive. Диагностика использует recording_mode и после reload не выдаёт намеренное отсутствие ASR за ошибку финализации.

## Полнота и границы
- `transcription_complete` остаётся флагом подтверждённого ASR coverage всей записи. Для audio_only он false, а не выдуманное завершение распознавания. Durability подтверждается audio.saved/stream.stopped, не этим флагом.
- Закрытые audio_only connections пока имеют ASR status=incomplete/gaps — диапазоны без подтверждённой транскрипции, НЕ потеря аудио. Они доступны в диагностике; чистая лента не показывает уведомление о сбое/пропуске для audio_only.
- Для translation `transcription_complete` не является отдельным доказательством полноты перевода. Раздельное completion/recovery впереди.
- Translation tokens не получают выдуманные timestamps/segment IDs. Ассистент и конспекты продолжают использовать оригинал.
- Mixed order/original-vs-none сохраняются; добавлена консервативная final-only проекция ссылок на монологи (SONIOX-TRANSLATION-STORAGE.md). Перевод-primary, provisional projection и раскрытие оригинала ещё не реализованы. Текущая лента показывает оригинал; нельзя объявлять перевод в UI готовым.
- Post-recording обработка audio_only и ручной backfill остаются следующим этапом. Нет новых кнопок, обещающих эти действия.

## Проверки
`backend/tests/test_native_recording_config.py`: HTTP/WS lifecycle, no-key-read/no-socket audio_only с consent+fixture key, pause/restart всех режимов после смены preferences, Soniox config и original/translation HTTP readback, v3→v4 migration/reopen и playback. Внешняя сеть заменена fixture, production gateway/storage/routes исполняются.

`test_native_soniox_ws.py`: delayed connect/rotation и sample replay при изменённых preferences. `frontend/src/security/nativeLive.test.ts`: main transport disabled handshake. `scripts/native-live.smoke.spec.ts`: production preload/main/backend audio_only, PCM durable ACK и reload диагностики.

Последние результаты и точные команды — HANDOFF/STATUS. Полная backend collection блокируется прежним missing gateways.asr.OPERATION. Тесты/fixtures не являются реальной ASR-приёмкой.
