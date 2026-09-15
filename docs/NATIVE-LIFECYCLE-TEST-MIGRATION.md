# Native lifecycle — перенос проверок

## Граница
`frontend/src/state/store.native.test.ts` исполняет production store, AudioRecorder, NativeAudioWriter и PersistenceQueue. Подменены только browser audio input и Electron IPC. Прежний mock AudioRecorder из `store.lifecycle.test.ts` удалён после переноса сценариев; оставшиеся 12 тестов проверяют архивные contextual read/retry и изоляцию session/Q&A/notes.

## Соответствие прежним инвариантам
| Прежняя проверка | Native-проверка / актуальная граница |
|---|---|
| Capture incomplete остаётся sticky при повторном Quit/новой записи | `keeps incomplete capture sticky…`; production save-on-quit timeout smoke |
| Quit ждёт capture/lifecycle, запрещает Record до Cancel | `keeps Record blocked…`, `saves 100ms PCM…` |
| Не подтверждать Quit при failed Stop | `blocks Quit on failed Stop…` |
| Выбранный contextual mode управлял новым Record | Контракт изменён спецификацией: `creates a distinct native recording…` проверяет native без legacy advance/upload даже при старой contextual настройке |
| Slow contextual advance/ASR не блокирует запись | Backend `test_connect_delay_does_not_block_storage_or_backfill_audio`, `test_network_stall_never_blocks_audio_ack_and_stop_is_incomplete` (connect/send/finish) — provider теперь backend-owned |
| Сохранение без cloud consent | Backend `test_native_cloud_consent_gates_provider_but_not_local_saving` (false/true), native store fixture consent=false |
| Не дописывать архив при новом Record | `creates a distinct native recording…` |
| Поздний ASR-ответ не попадает в другую сессию | `never installs a late transcript read…`; native transcript приходит через GET, не legacy upload reply. Будущий polling snapshot требует отдельных tests |
| Pause/Stop не открывают Record/+ до drain | `blocks new sessions and Record throughout %s capture drain` |
| Initial status ACK до Stop | `waits for an in-flight open on Quit…`; native open заменил PATCH recording |
| Stop опережает Pause drain | `does not resurrect Pause…` |
| Deferred Pause ACK и deferred retry перед более новым failed Stop | `serializes delayed Pause ACK…` (retry=false/true) |
| Session ID до async Pause boundary | `finishes the recording session captured…` |
| Хвост сохранён до stopped | `waits for durable tail persistence…`, `saves 100ms PCM…` |
| Failed Stop видим и retry исходной сессии | `blocks Quit on failed Stop…` |
| Failed Pause видим и retry без capture | `keeps failed native finalization retryable…` |
| Startup status fail освобождает capture | `releases the transport listener when opening fails…`, `closes an opened transport when browser capture setup fails` |
| Local storage failure останавливает capture, сохраняет retry | `protects PCM after a lost ACK…`; actual storage failure покрывается backend native storage tests. Отдельный uncommitted IPC failure требуется дополнительно |
| Signal diagnostics, reset после Stop | `publishes capture signal diagnostics…`; подробная throttling/dB математика остаётся в meter.test.ts |
| Restore автоматически разбирал pending chunks | Контракт изменён: `never automatically retranscribes pending or failed archived audio…` — открытие архива GET-only, без fetch/upload/POST |

Дополнительно: повторный Stop, Stop во время Resume/open, failure-listener cleanup/late events, durable Stop ACK при failed read-model refresh, sample clock через Pause/Resume.

## Проверено в этом срезе
- `npm test -- frontend/src/state/store.lifecycle.test.ts frontend/src/state/store.native.test.ts && npm run typecheck`: 36 passed, types exit0.
- `npm test`: 384 passed / 1 прежний LocalModelsBrowser polling failure; без прежних unhandled rejections. React act warnings остаются.
- Из backend `.venv/bin/python -m pytest tests/test_native_capture_boundaries.py tests/test_native_soniox_ws.py tests/test_native_soniox_failures.py -q --tb=short`: 10 passed, 2 dependency warnings.
- Это локальные fixture-прогоны, не реальная речь/API. Soniox UI, active consent revoke и полный review ещё не завершены.
