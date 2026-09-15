# Native WebSocket — локальное сохранение PCM

## Актуальное дополнение: конфигурация записи
Первый native open фиксирует режим/язык из settings; Pause/Resume, provider rotation и перезапуск сохраняют их. `audio_only` не читает ключ Soniox и не создаёт сетевой worker; active `transcription=disabled`, после закрытия `inactive`. Translation передаёт сохранённый target в gateway. Подробности и границы: [SONIOX-RECORDING-CONFIG.md](SONIOX-RECORDING-CONFIG.md).

Native Record/store, save-on-quit, ключ Soniox и отзыв consent уже подключены; исторические результаты ниже не являются текущим статусом. Последние проверки — в STATUS/HANDOFF. UI выбора трёх режимов и показ перевода ещё не реализованы.

Статус: backend PCM → durable storage → production SonioxGateway подключён и проверен ASTRA через fake внешнюю сеть. Electron main-owned transport, narrow preload и renderer ApiClient подключены и проверены production smoke на fixture PCM; UI Record/capture/store пока не переключены. Реальные API и качество речи не проверялись. При отсутствии ключа Soniox запись остаётся локальной. Ключ читается из backend SecretStore по имени soniox; UI настройки этого ключа ещё впереди.

## Текущий промежуточный срез
- Обновление проверки: пользователь разрешил build/smoke; production build и2Electron smoke прошли, включая штатный Quit с PCM-tail/barrier/reentry и exact playback после restart текущего Record. Это успешный путь, не проверка capture barrier timeout. Full frontend379passed/1прежний polling failure; typecheck/Ruff passed, scoped backend118passed. Ограничения native writer/store ниже сохраняются; approval blocker снят.
- При open cloud_consent=false не читается ключ и не создаётся Soniox provider; local PCM сохраняется. Отзыв consent в уже открытом потоке ещё не реализован.
- Непустой хвост даже в1сэмпл сохраняется без padding/потери. Native sample clock точен; целочисленные display start_ms/end_ms у субмиллисекундного блока могут совпасть. API regression проверяет побайтный playback и продолжение шкалы.
- Main/preload/store save-on-quit подключён к существующему Record: prepare/ACK,30s deadline с отказом (не успешным сохранением), cancel/discard при неудаче. Targeted47tests и typecheck прошли; build/Electron verification заблокированы approval timeout. Native writer ещё не подключён к store; штатный native lifecycle этим не принят.

## Endpoint и доступ

`WS /sessions/{session_id}/live/stream` на loopback backend. Авторизация Bearer per-run token проверяется внутри WS-route, независимо от HTTP middleware. Дополнительно проверяются loopback peer, Host, разрешённый Origin и существование сессии. Отказ до accept:1008. Токен остаётся в Electron main; renderer использует только openNative/sendNativeAudio/endNative и onNativeFailure. Main проверяет trusted top-level sender; URL/порт/заголовки не принимаются от renderer.

## Electron / renderer

Production bridge: openNative(sessionId,sampleRate), sendNativeAudio(sessionId,{sequence,startSample},pcm), endNative(sessionId,action), onNativeFailure(callback). Ответы обёрнуты в JsonResponse; ApiClient снимает envelope. Main сохраняет собственную копию PCM, ограничивает очередь64packets/2sPCM, отправляет следующий блок после durable ACK. Open/save timeout5s, end timeout15s; timeout — ошибка с необходимостью проверить saved coverage, не успешное сохранение. Повторный end возвращает первый результат; pause→resume требует нового open. Ошибки санитизированы.

NativeAudioWriter для frontend хранит sample clock и проверяет ACK/reopen; AudioRecorder поддерживает onReady и100ms windows. **Их соединение со store, живой Record и save-on-quit пока не выполнено.** Production smoke проходит через реальный preload/main/backend на fixture PCM с null keyring, проверяет pause/resume/repeated stop и побайтный playback. Это не проверка микрофона/ASR quality.

## Протокол

Первое сообщение — JSON text до4096bytes, срок ожидания5s:
`{"type":"open","sample_rate":16000}`. Необязательные `audio_format:"pcm_s16le"`, `num_channels:1`; другие поля отвергаются. Частота8–48kHz, неизменна внутри записи. Ответ `stream.opened`: connection_id, sample_rate, saved_samples, next_sequence, transcription=disabled для audio_only, иначе connecting при consent+ключе либо unavailable без них. Режим и язык не принимаются в WS hello: конфигурация принадлежит записи.

Каждое аудиосообщение — binary:
- первые8bytes: unsigned64 sequence, network/big-endian;
- следующие8bytes: unsigned64 start_sample, big-endian;
- следующие4bytes: unsigned32 sample_count, big-endian;
- остаток: ровно sample_count*2bytes PCM16 little-endian mono.

Максимум500ms аудио за блок, общее ограничение сообщения48020bytes. Индексы ограничены signed64 для SQLite. Порядок/непрерывность/конфликтующий replay проверяются LiveStore. Ответ `audio.saved`: sequence, saved_samples, duplicate. Он отправляется только после успешного сохранения WAV и транзакции metadata. Идентичный повтор не дублирует аудио.

Завершение: `{"type":"end","action":"stop"}` либо action=pause. Ответ `stream.stopped`: saved_samples, transcription_complete, status=stopped/paused; отправляется после сохранения статуса и освобождения owner, поэтому можно сразу открыть новое подключение той же сессии. Complete требует сохранённого finished:true и final watermark на всём сохранённом аудио, а не одного закрытого socket. Сетевое ожидание drain/finish ограничено10s плюс bounded transport cleanup; завершение уже начатого disk I/O может дополнительно задержать ответ, чтобы не оставить запись после удаления/закрытия БД. При повторном открытии session_id продолжает sample clock и sequence без времени паузы. Прерванное подключение остаётся incomplete.

Ошибки: `stream.error` code=invalid_stream/storage_failed, затем close. Не передаются тело ошибочного сообщения, пути, токены или exception text. Ошибка SQLite учитывается наряду с fsync/OSError. Ошибка provider event persistence отслеживается параллельно socket.receive: не требуется следующий PCM/end для уведомления клиента. Если БД отказала и при cleanup, активная строка остаётся для startup recovery; ложный ACK не посылается.

## Ограничение памяти на уровне сервера

`__main__.py` запускает uvicorn с ws=websockets, ws_max_size=48020, ws_max_queue=8, compression off. Это защищает до получения полного сообщения route. Другие embedding-запуски uvicorn обязаны использовать те же лимиты. Native disk I/O выполняется через to_thread, не в event loop; route последовательно ждёт одну запись, provider receive — одно сохранение события. Commit/offer/rotation сериализованы общим async lock. Отмена ждёт уже начатый I/O до delete/DB close; физически зависший диск не бросается по timeout. Коалесцирование и полная reconciliation ещё не реализованы. Session list/create/detail/native snapshot/delete также off-loop; другие legacy async DB callers ещё требуют аудита shared-lock contention. Provider send/receive работают независимо: очередь PCM максимум64пакета и2s аудио (плюс один отправляемый блок), очередь gateway8events с лимитом ответа1MiB. Overflow разрывает непрерывный provider clock, а не пропускает пакет посередине него.

## Soniox и наблюдаемое состояние

- Сеть получает только уже сохранённые блоки; local ACK не ждёт Soniox. При подключении/reconnect anchor снимается с текущего saved_samples; прошлый звук автоматически не догоняется. Повтор PCM в том же local WS остаётся идемпотентным даже после смены ASR connection.
- GET live содержит transcription=connecting/streaming/unavailable во время local WS, inactive после него; persisted connections и gaps. Gaps — диапазоны final_sample..end_sample закрытых подключений без подтверждённого покрытия, не доказательство отсутствия любых отдельных final-токенов. Active draft/lag видны в metadata, не объявляются окончательными gaps.
- Partial сохраняется как draft, final сохраняется с source links; чтение через существующие GET session/live. Push transcript events пока не реализован.
- DELETE ждёт освобождения provider-задач до удаления БД/аудио. Lifespan вызывает stop_native до закрытия БД. Это аварийная отмена с incomplete; штатный Electron quit с capture barrier/finish ещё не подключён.
- Проверки нового wiring: tests/test_native_soniox_ws.py и test_native_soniox_failures.py —7tests. Общая регрессия native WS/store/gateway/session/playback/ingestion:110passed,2dependency warnings. Scoped Ruff passed; strict mypy diagnostic3.12/follow-imports=silent passed7files.

## Проверка off-loop storage/lifecycle

115 scoped backend tests passed, включая5новых tests/test_native_storage_lifecycle.py: stalled fsync + health, snapshot/delete contention, durable pause status перед ACK + immediate resume, ошибка сохранения transcript без нового PCM. Scoped Ruff и strict diagnostic mypy3.12 passed4files. Точная команда/ограничения в HANDOFF. Electron/frontend заблокированы отсутствующим разрешением на установку ws/@types/ws; в этом заходе не изменялись и не проверялись.

## Предыдущие проверки локального transport

Из backend:
`.venv/bin/python -m pytest tests/test_native_live_ws.py tests/test_native_live_ws_errors.py tests/test_native_ws_server_limits.py tests/test_native_live_api.py tests/test_native_live_store.py tests/test_sessions_api.py tests/test_audio_playback_api.py tests/test_audio_ingestion.py tests/test_soniox_gateway.py -q` → **103passed**, exit0,2dependency deprecation warnings (Starlette httpx/anyio).

Scoped Ruff и strict mypy(диагностический target3.12/follow-imports=silent) route/security/entrypoint+3tests →passed6files. Последняя правка после103tests — перенос длинной строки теста, runtime не менялся.

RED→GREEN: отсутствующий WS endpoint; binary hello вызывал KeyError; отсутствовали server queue/size limits; SQLite readonly вызывал необработанную ошибку и падение cleanup. Проверены valid/offline capture, playback bytes, replay/resume, auth/Origin/Host, неправильный порядок/длина/размер/overflow, ошибки fsync/SQLite, существующие storage/session/gateway regressions. TestClient ASGI boundaries, не реальный микрофон и не реальный Soniox. TestClient websocket_connect игнорирует base_url и использует ws://testserver для относительного пути: тесты используют абсолютный ws://127.0.0.1, production security не ослаблена.
