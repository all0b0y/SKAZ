# Audio playback backend API — slice 1

Этот контракт описывает только локальное сохранение и чтение диагностического аудио. Он не означает готовность frontend-плеера и не меняет VAD, post-check или выбор ASR-модели.

Все маршруты требуют обычный bearer-токен локального backend и проверяют принадлежность данных указанной сессии. Ответы не содержат путей на диске, ключей, provider/model history или текста внутренних ошибок файловой системы.

## Сохранить исходный WAV без запуска ASR

`POST /sessions/{session_id}/audio/store?sequence={n}&start_ms={ms}&end_ms={ms}`

- Тело — один mono PCM WAV, с теми же ограничениями формата, длительности и размера, что у `POST /sessions/{session_id}/audio`.
- `sequence >= 0`, `start_ms >= 0`, `end_ms > start_ms`.
- Маршрут синхронно валидирует и атомарно сохраняет весь WAV. Он не создаёт background task, не ждёт очередь транскрипции, не строит ASR provider и не проверяет cloud consent/API key.
- Новая запись возвращает `201`; повтор идентичных bytes и диапазона — `200` с `duplicate=true`; повтор sequence с другими bytes или диапазоном — `409`.
- Ошибка WAV — `400`, слишком большое тело — `413`, неверный диапазон — `422`, неизвестная сессия — `404`. Ошибка локального диска — безопасный `500`; новая незавершённая DB-claim откатывается, поэтому тот же запрос можно повторить.

```json
{
  "sequence": 12,
  "start_ms": 24000,
  "end_ms": 26000,
  "status": "pending",
  "available": true,
  "duplicate": false,
  "source_kind": "original_captured_wav"
}
```

`status` — фактический статус chunk в БД: `pending`, `failed` или `done`. Успешное сохранение означает только доступность исходного аудио, а не успех транскрипции. Оно расширяет `session.duration_ms` до максимального сохранённого `end_ms`.

Существующий `POST /sessions/{session_id}/audio` сохраняет прежний контракт транскрипции. Он использует ту же persistence-операцию, после чего отдельно проходит ASR/backpressure path.

## Пауза и остановка после локального сохранения

`PATCH /sessions/{session_id}` принимает необязательное поле `flush_transcription`.

- Поле по умолчанию равно `true`: старые клиенты сохраняют прежнее поведение, при котором `paused` и `stopped` вызывают flush транскрипции, ждут ASR и могут повторить ранее failed chunks.
- Renderer persistence-first пути передают `flush_transcription=false` только после завершения физического pause/stop и получения локальных ACK для всего хвоста. Backend тогда меняет capture status без построения ASR provider, flush, upload или автоматического повтора failed chunks.
- `pending` и `failed` chunks при `false` остаются без изменений и доступны для последующего явного retry. Успешный PATCH означает только смену capture status, а не полноту транскрипции.

```json
{
  "status": "stopped",
  "flush_transcription": false
}
```

## Манифест сохранённых chunks

`GET /sessions/{session_id}/audio?after_sequence={n}&limit={count}`

- Стабильный порядок по `sequence` по возрастанию.
- `after_sequence` — необязательный exclusive cursor (`>= 0`).
- `limit` — `1..200`, default `100`.
- В манифест попадают `pending`, `failed`, `done` и chunks без transcript segments, включая реальную тишину.
- `available` отражает наличие обычного файла сейчас; отсутствующий файл остаётся видимым как разрыв.
- `segment_ids` строится только по фактической DB-связи `(session_id, sequence)`, а не по совпадению таймкодов.

```json
{
  "chunks": [
    {
      "sequence": 12,
      "start_ms": 24000,
      "end_ms": 26000,
      "status": "done",
      "available": true,
      "segment_ids": ["segment-id"],
      "source_kind": "original_captured_wav"
    }
  ],
  "next_after_sequence": null
}
```

`next_after_sequence` равен последнему возвращённому sequence только когда есть следующая страница; иначе `null`.

## Получить bytes одного chunk

`GET /sessions/{session_id}/audio/{sequence}` остаётся бинарным маршрутом. Он возвращает сохранённые bytes с `Content-Type: audio/wav`. Неизвестный chunk и отсутствующий файл дают безопасный `404`; backend не генерирует заменяющую тишину.

## Что именно считается исходником

`source_kind=original_captured_wav` означает WAV bytes, полученные backend от recorder и сохранённые побайтово. Это не утверждение о побайтовой идентичности входу ASR: локальный ASR может ресемплировать/преобразовать аудио в памяти, а облачный adapter формирует собственный provider request. Этот срез не сохраняет преобразованный model input. Для старых записей известен только сохранённый captured chunk; provider, model, settings и точное преобразование исторического ASR считаются неизвестными, если отдельного доказательства нет.
