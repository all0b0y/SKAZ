# Встроенный перевод: gateway и хранилище

Реализован backend-срез. `NativeStream` использует сохранённый режим/язык конкретной записи; preferences фиксируются при первом open (см. SONIOX-RECORDING-CONFIG.md). UI выбора и перевод в монологах ещё не подключены. Сохранение preferences само по себе не включает cloud consent и не запускает платную обработку.

## Протокол

`SonioxConfig.translation_target_language` — optional language code. Если задан, gateway отправляет `translation: {type: "one_way", target_language: ...}`. Используемые исходные языки задаются сохранённым used_languages (strict hints, см. SONIOX-RECORDING-CONFIG.md). Валидация target проверяет форму кода, не подтверждает доступность языка у провайдера.

`SonioxEvent.final_tokens/partial_tokens` остаются только оригинальной речью. Новые `final_translation_tokens/partial_translation_tokens` содержат `SonioxTranslationToken`: text, confidence, is_final, language, source_language, speaker. У этого типа нет timestamps. Последующие partial-массивы заменяют хвост, final-массивы являются дельтами.

Перевод без запрошенной конфигурации и неизвестный translation_status отклоняются. Ошибки метаданных санитизированы без выдачи текста или ключа. Маркеры и finished обрабатываются прежним протоколом; ASR watermark не превращается в самостоятельное доказательство завершения перевода.

## Долговечность

Additive migration `native_translation_v3`:
- `native_translation_events`: final translated tokens по connection_id/ordinal; FK к native_asr_events с cascade.
- `asr_connections.translation_draft_json`: последний replaceable translated tail.

Пишутся в той же транзакции, что оригинал и digest события. Повтор event ordinal идемпотентен, конфликтующий текст отклоняется. Digest original-only событий сохраняет прежний формат. Translation tokens получают отдельный стабильный ID; speaker_number общий с оригиналом внутри подключения. Одинаковый provider speaker ID разных подключений не означает одного человека.

GET native snapshot дополнен `final_translation_tokens` и `partial_translation_tokens`. Хвосты незавершённых соединений сохраняются; при отображении нужно учитывать connection status, не выдавать их за подтверждённую речь. Таблицы segments/FTS и источники ассистента содержат только оригинал. Переводу не назначаются segment_id или фиктивные sample/word timestamps.

## Не сделано

Перевод в UI с раскрытием оригинала, recovery jobs и отдельная полнота перевода. Final/live ссылки ниже — консервативные проекции, не word alignment и не доказательство полноты. Нельзя zip-ить original/translation arrays или искать ближайший монолог только по speaker ID. Snapshot пока полный и дублирует данные в совместимых проекциях; long-session readiness не заявляется.

## Смешанный порядок — additive v5

Gateway сохраняет `SonioxEvent.token_order`: последовательность `SonioxTokenRef(translation_status, is_final, position)` до разделения типизированных массивов. `position` относится только к соответствующему final/partial original/translation массиву. `none` и `original` различаются; отсутствие provider status нормализуется в `none`, как прежде. Маркеры не являются словами и не участвуют в проекции. Номера новых спикеров назначаются по первому появлению в смешанном потоке, не по порядку обхода раздельных массивов.

Migration `native_stream_order_v5` добавляет `native_stream_events` и `asr_connections.stream_draft_json`. В одной транзакции с исходными событиями сохраняются:
- `final_stream_tokens` в GET `/sessions/{id}/live`: final delta words в порядке connection → event → provider position, оригинал и перевод вместе; стабильные IDs совпадают с прежними массивами.
- `partial_stream_tokens`: полный заменяемый mixed tail каждого подключения в порядке подключений. Новый event заменяет его целиком, в том числе пустым массивом. Tail не источник ассистента; после прерывания сохраняется для read model и требует учёта статуса соединения.
- Каждый элемент дополнен `translation_status`; оригинал сохраняет source ID и audio samples, перевод по-прежнему без source ID/таймингов.

Это два логических потока (durable finals + replaceable tail), не архив сырых WS-пакетов. Граница event не считается границей фразы/монолога. Порядок `A original → A translation → B none → A original → A translation` сохраняется и при разбиении между ответами; неравное количество слов не создаёт соответствия1:1. `none` значит provider не переводил этот текст, а не ошибку перевода; UI-политика для него ещё не реализована.

Исторические события без token_order не получают выдуманного порядка: старые final/translation arrays и sources доступны, новые stream arrays могут покрывать только новые события. Пустой stream array не доказывает отсутствие транскрипции/перевода. Перед отображением исторических монологов надо проверять покрытие IDs, не скрывать старые данные. Replay original-only/none сохраняет прежний digest и не дописывает проекцию к историческому событию; replay с иным mixed order/status конфликтует. Между независимыми подключениями порядок и speaker identity остаются раздельными.

## Проверка

### Final-only проекция монологов
GET live содержит `final_translation_projection`:
- `monologues`: id (первый original token ID), connection_id, speaker_number, original_token_ids, translation_token_ids, passthrough_token_ids, display_token_ids. Последнее поле сохраняет смешанный порядок перевода и none внутри turn; нельзя отображать два отдельных массива подряд.
- `unassigned_translation_token_ids`: сохранённый перевод без надёжной привязки, не потерянный/удалённый.
- `order_unavailable_connection_ids`: подключения с неполным историческим mixed order; их перевод не связывается догадкой.

Соседние original-токены одного speaker внутри connection образуют turn; A/B/A остаётся тремя turns. Порядок — provider original order, не сортировка по выдуманным translation timestamps. Последовательный original chunk → translation chunk связывается только если весь original chunk принадлежит одному known-speaker turn и весь перевод имеет того же спикера. Чанк через несколько turns, неизвестный/несовпадающий speaker или неполное покрытие ordered IDs оставляют перевод unassigned. Границы provider responses не считаются границами chunks. `none` отмечается passthrough, а не ожидающим переводом.

Это ссылки на массивы токенов, НЕ точное соответствие слов/таймингов, не флаг полноты и не новые источники ассистента. Partial/tail не входят в эту проекцию и остаются в существующих полях. Старые segments без token metadata остаются в прежнем detail/архивном UI, не скрываются этой дополнительной проекцией. UI ещё её не использует.

### Live-проекция, включая заменяемый хвост
GET live дополнен `live_translation_projection`: те же поля монологов/непривязанного перевода/недоступного порядка плюс `original_tokens` и `translation_tokens`, на которые ссылаются IDs. Для каждого connection отдельно собирается final prefix + последний mixed tail; старый interrupted tail не переносится за финальные слова нового подключения. Проекция read-only: пересчитывается целиком, не записывает segments/FTS и не изменяет final-only связи.

Final IDs сохранены. IDs вида `{connection}:tail:original:{index}` и `{connection}:tail:translation:{index}` — только слоты текущего snapshot, не стабильные источники или идентификаторы правок. `is_final=false` остаётся false после прерывания/reopen; потребитель обязан учитывать status connection и не считать такой хвост завершённым/доверенным материалом. У partial original `segment_id=null`, sample bounds вычисляются по исходному request anchor; перевод по-прежнему без segment_id/timestamps.

При новом событии хвост заменяется, включая пустой; уточнение speaker меняет границы/объединяет соседние turns. Перед восстановлением позиционных tail refs проверяется совпадение обоих упорядоченных подмассивов с отдельными сохранёнными хвостами (метаданные и порядок, не только количество). Исторические хвосты без mixed order остаются в token arrays, перевод unassigned; никакого guessed ownership. Перевод без оригинала также сохраняется unassigned. Отсутствие assigned display text не разрешает подставлять ожидающий перевода original в основную ленту. UI пока не использует новую проекцию; архивный fallback/раскрытие оригинала остаются следующим этапом.

Тесты `test_native_translation_order_api.py` (WS→gateway→HTTP→restart, unequal counts/A/B/A/none, разбиение по событиям), `test_native_translation_projection.py` (ambiguous/unknown/different speaker, old/mixed historic order, multiple chunks/один turn, tail speaker replacement/merge/clear/replay/reopen, historical/orphan/interrupted/request isolation) и `test_native_translation_tail_api.py` (живой HTTP/WS snapshot, mixed none+перевод внутри одного turn, replacement→final, Pause/новые speaker numbers, original-only sources, restart).

Локальные тесты gateway с внешним socket fixture и публичного persistence seam: отсутствие времён, original isolation, delayed translation после final original, replacement partial, final и partial после DB reopen, replay/conflicting replay, санитизация и конфигурация. Это проверка приложения, не качества речи/перевода Soniox.

Финальные результаты/команды — HANDOFF.md. Реальные API/микрофон не запускались.

Официальные источники, проверенные при реализации:
- https://soniox.com/docs/api-reference/stt/websocket-api
- https://soniox.com/docs/translation/stt-translation
- https://soniox.com/docs/translation/stt-translation/rt-translation
