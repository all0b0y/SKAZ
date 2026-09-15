# Soniox — настройки и native read-model UI

## Текущий UI перевода
- Settings → System сохраняет режим и язык перевода для новых записей. Оригинал/перевод выбираются по immutable `snapshot.recording_mode`, а не по текущим preferences. Controls заблокированы при capture/pause/processing; cloud consent остаётся отдельным.
- В режиме translation `live_translation_projection.display_token_ids` задают основной текст монолога (перевод + none passthrough), оригинал доступен в закрытом «Показать оригинал». Citation раскрывает исходный segment. Нет подстановки оригинала при ожидании перевода, fake translation timings или source IDs.
- Replaceable tail обновляется без дублей; A/B/A не склеивается по speaker ID. Historical/unassigned перевод показывается отдельным блоком без ложной привязки; архивные originals остаются под раскрытием. Обычный transcription mode не меняется.
- Текущая проверка: 690 backend / 403 frontend tests, TypeScript/build, 4 production Electron smoke и отдельный UI-only fixture smoke — passed. Снимки translation-primary.png/translation-original.png просмотрены. Полные Ruff/mypy имеют замечания в не затронутых этим срезом Python-файлах; [STATUS](STATUS.md), [HANDOFF](HANDOFF.md). Реальная речь/перевод/микрофон не проверены.

## История первоначального read-model среза
Ниже — исходное описание до чистых монологов и подключения перевода; старые counts/blockers не являются текущим статусом.

## Реализованный контракт
- `GET /settings` и ответ `PUT /settings`: `soniox_has_api_key: boolean`. Это наличие ключа в backend SecretStore, **не успешная проверка провайдера**.
- `PUT /settings`: `soniox_api_key` — write-only строка; omission/null сохраняет, `""` удаляет. Backend использует SecretStr и не пишет ключ в settings JSON/SQLite/ответ. Ошибка secure storage возвращает санитизированный503. Сохранение не вызывает Soniox и не включает cloud consent.
- Soniox не добавляется в legacy enum ASR-профилей: native worker читает отдельный ключ `soniox`. Замена применяется к следующему подключению; удаление закрывает активный worker/handshake без остановки локального PCM. Запись настроек и закрытие защищены от отмены HTTP.
- Settings → API keys: отдельное masked поле Soniox, явное удаление, pending/saved/error, очищение draft после успешного сохранения. Только backend-confirmed boolean определяет «stored»; сам секрет не возвращается. Draft существует только в памяти открытого drawer, не в renderer storage.
- `Allow cloud processing` изменяет `cloud_consent` только по явному действию пользователя и Save. Наличие cloud-профилей/ключа не считается согласием. Предупреждение сообщает о передаче аудио/текста и оплате. Отзыв согласия не выключает локальное сохранение аудио. Старые записи не загружаются автоматически.

## Транскрипт
- Read-only `GET /sessions/{id}` + `GET /sessions/{id}/live` через existing trusted preload. Live metadata: sample_rate/saved_samples, transcription, connections и gaps; [storage contract](SONIOX-LIVE-STORAGE.md), [transport](SONIOX-LIVE-API.md).
- Подтверждённые segments отображаются в существующем transcript/player. Предварительный текст из persisted `draft_json` показан отдельно, не редактируется и не передаётся этим UI в Q&A/notes. Его timecode = start_sample подключения/sample_rate + provider-relative start_ms; закрытые incomplete drafts тоже остаются видимыми.
- Раздельно видны Soniox connecting/streaming/unavailable/inactive, durable audio watermark, incomplete finalization, ranges без полного подтверждённого покрытия. Gaps не объявляются тишиной; наличие gap не отрицает отдельных final-токенов внутри него.
- Poll цепочка последовательная, следующий запуск через1s после ответа. Пока local capture/processing активен либо provider ещё не inactive, polling продолжается. При inactive перечитывается final detail после barrier, чтобы не потерять последний final после Stop. Переключение записи/unmount не применяет поздние ответы; обновления не вызывают scrollIntoView.
- Ошибка чтения сохраняет видимый текст, явно помечает данные устаревшими; есть manual Refresh.404 у не-native архива не выдаёт пустую native-запись и оставляет legacy transcript доступным. Чтение не отправляет audio/ASR/accept/retry-команды.

## Проверка и ограничения
- Full frontend394passed/44files; native/storage/settings backend146passed,2dependency warnings. TypeScript/build/scoped Python Ruff+mypy passed.4Electron smoke passed; native smoke дополнен реальным UI/settings/HTTP и восстановленным offline snapshot после reload, с exact PCM playback.
- Снимки production build: `.runtime/soniox-migration/soniox-settings.png`, `.runtime/soniox-migration/soniox-native-status.png` — просмотрены. Provider заменён только в локальных unit/integration тестах; Electron smoke без ключа и cloud consent, в isolated userData/sessionData с null keyring. Реальная речь/модель/микрофон не проверены.
- Full backend collection блокируется прежним `test_activity_log_api.py` → отсутствует `gateways.asr.OPERATION`. Этот срез не исправляет старый log API и не означает полный lifecycle/security review.
- Legacy модели/режимы UI ещё требуют удаления. Native ручные правки/revisions, перевод, импорт/восстановление gaps, coalescing/reconciliation и долговременная/аварийная приёмка остаются отдельными незавершёнными требованиями.
