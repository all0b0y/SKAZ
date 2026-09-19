# Исходный профиль нагрузки (Задача 1 ТЗ)

Зафиксировано 2026-09-19. Это исходный замер ДО каких-либо оптимизаций;
все последующие сравнения ведутся от него.

## Что именно профилировалось

Установленное приложение `/Applications/SKAZ.app` (сборка 12:32) соответствует
коммиту `aa54b26` — HEAD ветки `main`, рабочее дерево чистое. Версия в
`Info.plist` и `package.json` — `0.1.0`.

Данные — реальные сессии пользователя из
`~/Library/Application Support/skaz/data/skaz.sqlite3`:

| сессия | режим | длительность | ASR-событий | аудиоблоков | сегментов |
|---|---|---|---|---|---|
| `e4c96eec…` | translation | 60,1 мин | 15 409 | 36 059 | 1 413 |
| `dece1a3a…` | transcription | 56,5 мин | 18 164 | 33 905 | 1 631 |

Замеры выполнялись на **копии** базы (`/tmp/skaz_probe.sqlite3`); рабочая база
не изменялась. «Минута M» эмулируется усечением append-only журнала
`native_asr_events` (и связанных token/stream/translation таблиц) до первых
M/total событий — это ровно то состояние, в котором приложение находилось на
M-й минуте.

Скрипты: `/tmp/skaz_baseline_profile.py` (backend), `/tmp/skaz_render_bench2.cjs`
(parse + IPC + проекция), `frontend/src/components/transcript/nativeMonologues.bench.test.tsx`
(React). Срезы снимков — `/tmp/skaz_baseline/`.

## Результат: цена одного цикла живого опроса

Опрос выполняется **раз в секунду** (`useNativeTranscript`, `setTimeout(…, 1000)`).

| сим. минута | payload | backend `snapshot()` | JSON.parse (main) | IPC-клон main→renderer | `project()` | React re-render | DOM `<span>` | итого CPU/цикл |
|---|---|---|---|---|---|---|---|---|
| 10 | 5,74 MiB | 45 ms | 15 ms | 33 ms | 3 ms | 36 ms | 5 613 | ~132 ms |
| 30 | 17,34 MiB | 135 ms | 50 ms | 88 ms | 11 ms | 99 ms | 16 884 | ~383 ms |
| 60 | 34,53 MiB | 277 ms | 105 ms | 169 ms | 24 ms | 201 ms | 33 478 | ~776 ms |

(режим translation; для transcription на 30-й минуте — 13,61 MiB и ~225 ms без
учёта React)

Зависимость линейна по длительности записи. На 120-й минуте ожидается ~69 MiB и
~1,5 с на цикл при периоде 1 с — цикл перестаёт укладываться в собственный
интервал. Это согласуется с наблюдавшимся ростом 40% → 118% CPU и последующим
падением приложения.

## Куда уходит процессорное время

### 1. Бэкенд пересобирает всю историю каждую секунду

`LiveStore.snapshot()` (`backend/src/audiohelper/live_store.py:336`) на 60-й минуте:

```
read_tokens originals       118 ms
read_tokens translations     76 ms
read_tokens stream          113 ms
project_final_translation    35 ms
project_live_translation     38 ms
json.dumps                  121 ms
```

Состав ответа (60 мин, translation):

| поле | размер | читает ли renderer |
|---|---|---|
| `live_translation_projection` | 12,01 MiB | да |
| `final_stream_tokens` | 10,51 MiB | **нет** |
| `final_tokens` | 4,89 MiB | нет (в режиме translation) |
| `final_translation_tokens` | 4,49 MiB | да |
| `final_translation_projection` | 2,63 MiB | **нет** |

Один и тот же токен передаётся 3–4 раза: в `final_tokens`, в
`final_stream_tokens` (та же структура плюс поле `translation_status`) и внутри
обеих проекций.

**Поля, которые не читает ни renderer, ни electron** (проверено grep по
`frontend/src` и `electron`, исключая тесты): `final_stream_tokens`,
`final_translation_projection`, `partial_stream_tokens`. В режиме транскрипции
дополнительно не нужны все переводные поля.

Отсечение неиспользуемого даёт:

| режим | сейчас | только читаемое | выигрыш |
|---|---|---|---|
| translation, 60 мин | 34,53 MiB | 16,50 MiB | −52% |
| transcription, 30 мин | 13,61 MiB | 3,57 MiB | −74% |

Эти поля используются backend-тестами (`test_native_stream_order_store.py`,
`test_native_translation_projection.py`, `test_native_translation_order_api.py`,
`test_native_recording_config.py`, `test_import_store.py`) — преимущественно
через `store.snapshot()`, то есть форму хранения менять нельзя, сокращать надо
именно ответ живого роута.

### 2. Electron платит за payload дважды

`electron/ipc.ts:171` — `res.text()` + `JSON.parse` (105 ms), затем
структурированное клонирование через IPC в renderer (169 ms). 274 ms/с на
перекладывание неизменившихся данных.

### 3. Скрытая диагностика продолжает работать

`TranscriptView.tsx:259` — `<div hidden={!diagnosticsOpen}>`: элемент намеренно
остаётся смонтированным (чтобы не обрывать воспроизведение). Следствия:
`DiagnosticAudioPlayer` при записи перечитывает полный манифест каждые 2 с
(`DiagnosticAudioPlayer.tsx:142`) и держит `<li>` на каждый чанк — 36 059
скрытых элементов на данной сессии.

### 4. События аудиоочереди пересобирают текст

`PersistenceQueue.run()` вызывает `emit()` ~4 раза на чанк, чанки идут каждые
100 мс (`recorder`, `windowSeconds: 0.1`) → ~40 обновлений `set({ queue })` в
секунду. `TranscriptView` подписан на `s.queue` (строка 97); каждое обновление
пересоздаёт массив `segments` через `.filter()` (строка 139), что ломает
`useMemo([snapshot, segments, translation])` в `NativeMonologues` и вызывает
полную перепроекцию и реконсиляцию. Подтверждено чтением кода; отдельным
счётчиком ре-рендеров в секунду не измерялось.

### 5. Монолог — один неограниченный блок

`NativeMonologues` рендерит `<span>` на каждый токен (строки 110–117). Для
`dece1a3a…` (один спикер) это 11 «монологов» на 19 976 спанов.

## Оговорки к методике

- React-замеры сделаны в jsdom — это **верхняя граница**; Chromium быстрее по
  абсолютным значениям. Линейность роста и соотношение mount/re-render от этого
  не зависят.
- Живая трассировка Chrome DevTools на работающем приложении не снималась
  (окно закрылось до начала работы). Разбивка «script / layout / GC» не
  измерялась — цифры получены покомпонентно по конвейеру.
- Сравнение состояний «открыта транскрипция / открыты заметки / окно свёрнуто»
  (требование Задачи 1) **не выполнено** — требует повторного длительного
  прогона на живом приложении.
- Аудиозахват как источник нагрузки исключён: `skaz-backend` за 3 ч 25 мин
  накопил 12:54 CPU-времени.
- Итоговый порог успешности (раздел 4 ТЗ) согласуется после этого замера;
  зафиксированный здесь абсолютный бюджет — исходная точка отсчёта.
