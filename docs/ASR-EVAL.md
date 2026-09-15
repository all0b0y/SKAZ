# ASR-eval: измерительный harness (`scripts/asr_eval.py`)

Инструмент считает WER/CER, ключевые термины, latency и потери слов на границах окон по
**сохранённым WAV-файлам** и **ручным эталонным расшифровкам**.

Текущая схема принимает происхождение WAV/эталона как внешнее утверждение и сама его не проверяет;
поэтому `evidence_class` говорит только о supplied reference и явно фиксирует непроверенный
provenance, а не объявляет файл человеческой речью.

Что это НЕ доказывает:
- это **offline replay** записанных файлов, а не захват с физического микрофона;
- latency берётся только из эталонной разметки, предоставленной человеком; длительность HTTP-запроса
  никогда не выдаётся за end-to-end latency;
- семантический вердикт ставит человек, harness его не выводит;
- синтетические фикстуры в `acceptance/test_asr_eval.py` проверяют механику кода, а не качество ASR.

Все числа в этом документе — **иллюстративные примеры формата**, а не измеренные результаты.

## Команды

```bash
# 1. Оценить заранее записанные гипотезы (без запуска ASR).
# Манифест кейсов создаётся отдельно, вместе с аудио и ручными расшифровками; в репозиторий
# личные записи не попадают, поэтому готового манифеста здесь нет.
python3 scripts/asr_eval.py --manifest <manifest> --report artifacts/asr-eval/report.json

# 2. Offline replay через продакшн-адаптер local-whisper. Нужен установленный extra local-asr
# (faster-whisper/numpy) — без него --offline-replay всегда вернёт "unavailable". Веса при этом
# всё равно не скачиваются (allow_download=False); модель должна быть подготовлена заранее.
uv run --project backend --extra local-asr python3 scripts/asr_eval.py \
    --manifest <manifest> --report .runtime/asr-baseline/report.json \
    --offline-replay --model small --language ru --window-seconds 5

# Тесты harness
python3 -m unittest acceptance.test_asr_eval -v
uv run --project backend ruff check scripts/asr_eval.py acceptance/test_asr_eval.py
```

Отчёты писать в gitignore-каталог (`artifacts/`, `.runtime/`): в JSON попадают тексты транскрипций,
личные записи и их расшифровки в репозиторий не коммитятся.

Коды выхода: `0` — все кейсы PASS; `1` — есть FAIL или INCOMPLETE; `2` — манифест отклонён до запуска
(нет файла, неподдерживаемая версия схемы, дублирующийся id,
нецелое/отрицательное/NaN/Infinity время или CLI-порог, неизвестное поле,
нечитаемый/не-PCM16-mono/слишком длинный WAV, отсутствуют `--model/--language` для replay). При коде
2 отчёт не пишется вообще.

Ключи: `--max-wer`, `--max-latency-ms`, `--window-seconds`, `--max-audio-seconds` переопределяют пороги
манифеста. stdout печатает только id, статус и коды причин; тексты и секреты — никогда.

## Схема манифеста

Пути внутри манифеста разрешаются относительно каталога самого манифеста.

```json
{
  "version": 1,
  "thresholds": { "max_wer": 0.05, "max_final_latency_ms": 3000, "window_ms": 5000 },
  "cases": [
    {
      "id": "meeting-ru-01",
      "audio": "audio/meeting-ru-01.wav",
      "reference": "text/meeting-ru-01.ref.txt",
      "hypothesis": "text/meeting-ru-01.hyp.txt",
      "language": "ru",
      "duration_ms": 61200,
      "keywords": ["не", "42", "Kubernetes"],
      "phrases": [
        { "phrase_end_ms": 12400, "final_text_ms": 14100 }
      ],
      "reference_word_timestamps": [
        { "word": "не", "start_ms": 11800, "end_ms": 12000 }
      ],
      "semantic_verdict": { "status": "unchecked", "note": "" }
    }
  ]
}
```

| Поле | Обязательное | Проверка при загрузке |
| --- | --- | --- |
| `id` | да | непустая строка, уникальна в манифесте |
| `audio` | да | файл WAV существует; в отчёт пишется sha256 и размер |
| `reference` | да | UTF-8 файл ручной расшифровки существует |
| `hypothesis` | нет | если указан — файл существует; иначе кейс INCOMPLETE |
| `language` | нет | строка; фиксируется в отчёте |
| `duration_ms` | нет | число, конечное, ≥ 0 |
| `keywords` | для PASS | список непустых строк (отрицания, числа, имена); отсутствие оставляет кейс INCOMPLETE |
| `phrases[]` | нет | `phrase_end_ms` ≥ 0 и конечное; `final_text_ms` ≥ `phrase_end_ms` |
| `reference_word_timestamps[]` | нет | `word` непустое, `start_ms`/`end_ms` ≥ 0, `end_ms` ≥ `start_ms` |
| `semantic_verdict.status` | нет | `unchecked` (по умолчанию) / `pass` / `fail` |

Неизвестные поля (опечатка вроде `critical_terms` вместо `keywords`, или `phrase_end_ms` на
верхнем уровне кейса вместо массива `phrases`) **отклоняют манифест** ещё до запуска — молчаливого
игнорирования непонятных ключей нет ни на одном уровне (манифест целиком, кейс, `thresholds`,
элемент `phrases[]`, элемент `reference_word_timestamps[]`, `semantic_verdict`). Так требование,
которое исполнитель считал проверяемым (например ключевые термины), не может незаметно выпасть из
проверки из-за опечатки в названии поля.

Поддерживается только целочисленная версия манифеста `1`; отсутствующая, логическая или другая
версия отклоняется, чтобы новая схема не интерпретировалась по старым правилам. CLI-переопределения
порогов также должны быть конечными неотрицательными числами; размер окна и максимальная длина
аудио — конечными положительными числами. `NaN`/`Infinity` не могут отключить сравнение с порогом.

Каждый `audio` дополнительно проверяется как настоящий читаемый PCM16 mono WAV (через тот же
`parse_wav`, что использует бэкенд) прямо при загрузке манифеста — независимо от того, указан ли
`--offline-replay`. Не WAV-файл, стерео, не 16-битный PCM или файл длиннее `--max-audio-seconds`
отклоняют манифест целиком до какого-либо scoring/model work.

`phrase_end_ms` и `final_text_ms` — точки **одной общей аудио-шкалы** (0 = начало файла):
конец эталонной фразы и момент, когда финальный текст стал доступен. Если `final_text_ms` не задан,
latency для этой фразы остаётся неизвестной, а не нулевой.

## Поля отчёта

Верхний уровень: `schema`, `generated_at`, `manifest`, `mode`
(`score-recorded-hypotheses` | `offline-replay`), `evidence_class`, `runner`
(provider/model/language/`allow_download: false`/`local_runner_available`/версия Python),
`thresholds`, `partial_log`, `cases`, `aggregate`, `exit_status`, `limitations`.

Кейс: `id`, `audio`, `audio_sha256`, `audio_bytes`, `hypothesis_source`, `language`, `duration_ms`,
`text_metrics`, `keywords`, `semantic`, `latency`, `boundary`, `replay`, `status`, `reasons`
(+ `windowed_text_metrics`, если replay выполнялся).

- `text_metrics`: `word_edits`, `reference_words`, `char_edits`, `reference_chars`, `wer`, `cer`,
  `hallucinated_words`. При пустом эталоне `wer`/`cer` = `null` (деления на ноль нет), а придуманные
  слова считаются в `hallucinated_words`.
- `keywords`: `status` (`pass`/`fail`/`unknown`/`not-declared`), `checked`, `missed`,
  `absent_from_reference`. Считается отдельно от WER: пропуск одного «не» в длинной фразе почти
  не двигает WER, но даёт `keyword-missed`. Необъявленный список даёт
  `keywords-not-declared`/INCOMPLETE; термин, которого нет в ручном эталоне, даёт
  `keyword-reference-mismatch`/INCOMPLETE. Поэтому отсутствие или опечатка разметки не становятся
  ложным PASS.
- `latency`: `status` (`measured`/`unknown`), `definition`, `samples_ms`,
  `phrases_without_final_text`, `p95_ms` (nearest-rank, не среднее), `max_ms`, `over_threshold`.
- `boundary`: `status` (`measured`/`unknown`), `window_ms`, `words_crossing_window`,
  `words_lost_at_boundary`, `lost_words`, `loss_method`. Без `reference_word_timestamps` —
  `unknown` и `null`, никогда не `0`. Потеря конкретного слова определяется **позиционным
  выравниванием** (Levenshtein-бэктрейс) эталона и гипотезы, а не проверкой «слово встречается
  где-то в тексте» — иначе более раннее верно распознанное вхождение того же слова маскирует
  реальную потерю на границе окна. Выравнивание доступно только когда `reference_word_timestamps`
  совпадает 1:1 (по составу и порядку) с токенами `reference` — иначе `words_lost_at_boundary` =
  `null`, `loss_method` начинается с `unknown:`, а `words_crossing_window` (геометрический факт)
  всё равно считается отдельно. При `--offline-replay` для границы окна берётся именно
  `windowed_text` (нарезанный прогон), а не текст всего файла целиком — целый файл не пересекает
  ни одной границы окна и не может свидетельствовать о потере на нарезке.
- `replay`: `not-requested` | `ok` | `unavailable` (со `stage` и текстом ошибки). Успешный replay
  заменяет гипотезу кейса собственным текстом; ручной `semantic_verdict` и `phrases` из манифеста
  были зафиксированы человеком именно для гипотезы манифеста, поэтому для replay-прогона они не
  переносятся как доказательство — `semantic.status` принудительно становится `unchecked`, а
  `latency.status` — `unknown`, пока нет отдельного поля, явно привязывающего разметку к
  replay-прогону.

`aggregate` — **микро-усреднение**: `wer = sum(word_edits) / sum(reference_words)`,
`cer = sum(char_edits) / sum(reference_chars)`. Среднее по процентам кейсов не считается никогда.
Пример формы (иллюстрация, не измерение): кейсы 1/1 и 0/20 ошибок дают `wer = 1/21 ≈ 0.048`,
а не `0.5`. Там же: счётчики `pass/fail/incomplete`, пул latency-семплов с общим `p95_ms`,
`cases_unknown` для latency и boundary, счётчики ключевых терминов и семантических вердиктов.

## Статусы и коды причин

`FAIL` > `INCOMPLETE` > `PASS`: доказанная ошибка важнее неполноты, неполнота исключает PASS.

FAIL: `wer-above-threshold`, `hallucination-on-silence`, `keyword-missed`, `semantic-failed`,
`latency-above-threshold`, `boundary-word-cut`.

`latency-above-threshold` срабатывает от **p95 по кейсу** выше `max_final_latency_ms` (критерий —
«p95 ≤ 3с в 95% случаев»), а не от единственного семпла-выброса: один медленный ответ среди многих
быстрых не проваливает кейс, если p95 в пределах порога. Счётчик `latency.over_threshold`
(количество отдельных семплов выше порога) остаётся в отчёте как справочная информация и не
управляет статусом.

INCOMPLETE: `hypothesis-missing`, `run-not-executed`, `semantic-unchecked`, `latency-unknown`,
`latency-incomplete`, `boundary-unknown`, `keywords-not-declared`,
`keyword-reference-mismatch`. Кейс с любым из них **не может** быть PASS — непроверенный
критерий не считается выполненным. `latency-incomplete` — часть фраз имеет `phrase_end_ms`, но не
имеет `final_text_ms` (`latency.phrases_without_final_text > 0`): раз итоговый текст для этой фразы
так и не пришёл, latency по кейсу остаётся неполным измерением, даже если по остальным фразам
`p95_ms` укладывается в порог.

## Устойчивость к сбою

Каждый кейс сразу дописывается строкой JSON в `<report>.partial.jsonl` с flush — при падении
посередине прогона уже посчитанные кейсы сохраняются. Итоговый JSON пишется в конце; путь к
частичному логу указан в отчёте (`partial_log`).

## Offline runner

`--offline-replay` строит транскрайбер продакшн-адаптером
`build_transcriber(provider="local-whisper", model=<явно>, allow_download=False)` и прогоняет каждый
файл дважды: целиком и фиксированными окнами `--window-seconds` (по умолчанию 5 с) по той же
аудио-шкале. Гипотезой кейса становится текст целого файла; окна дают
`windowed_text_metrics` для сравнения потерь на нарезке.

Веса никогда не скачиваются. Если `faster-whisper`/`numpy` не установлены или веса отсутствуют,
runner возвращает `{"status": "unavailable", "stage": ..., "error": ...}`, кейс получает
`run-not-executed` и INCOMPLETE, прогон завершается кодом 1. Это ожидаемый честный результат, а не
успешное измерение.

Текущее окружение репозитория: `faster-whisper` не установлен, поэтому `--offline-replay` здесь
всегда даёт `unavailable`. Реальные цифры качества этим harness ещё не измерялись.
