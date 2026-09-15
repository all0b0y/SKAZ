# Состояние AudioHelper — миграция Soniox

## Реализовано
- Все прежние бордовые/красные UI-акценты заменены на базовый `#20202A`; тёмная тема использует его контрастный оттенок `#A4A4B2`. Красная ткань в empty-state иллюстрации перекрашена в ту же графитово-синюю гамму с сохранением фактуры.
- Native capture/storage/lifecycle; отзыв consent завершает provider, не локальное сохранение. Ошибки сохранения/overflow/retry видимы; штатное Saving locally убрано.
- Чистая лента speaker turns, replaceable tail, источники и управляемая прокрутка. Используемые языки выбираются в Settings перед первой desktop-записью; Soniox получает strict language hints (best-effort).
- Settings → System: режим новой записи (транскрипция / транскрипция и перевод / только аудио), язык перевода. Save не включает consent. Режим/target/языки фиксируются при первом native open и сохраняются через Pause/Resume/rotation/restart; старым записям новые настройки не приписываются. Audio-only без ключа/сети; postprocessing UI пока нет.
- **Перевод — основной текст, оригинал свёрнут под «Показать оригинал».** Live projection сохраняет порядок перевода/none, заменяемый хвост и speaker turns. При ожидании перевода оригинал не подставляется. Переход по источнику раскрывает оригинал. Historical/ambiguous перевод виден отдельно без выдуманной привязки к реплике/таймкодов.
- Bounded `/logs`: технические HTTP chat/legacy ASR attempts без payload/secrets, изоляция установок. Только память процесса; durable history/Soniox WS/UI журнала пока нет. HTTP200 ASR error больше не считается пустым успехом.

## Последняя проверка
- После замены палитры: **403 frontend tests / 44 files**, TypeScript и build passed; visual Electron smoke **1 passed**. Light shell/search/settings и dark screenshot просмотрены: красных/бордовых акцентов и визуальных дефектов не найдено.
- Удалён согласованный устаревший `test_languages_api.py`: 35 cases старого `/languages`/model-specific catalogs. Текущие Soniox language/config/provider проверки сохранены, без skip/ignore.
- Полный backend pytest: **690 passed**, 2 dependency warnings.
- Полный frontend: **403 passed / 44 files**, TypeScript и build passed.
- **4 production Electron smoke + 1 UI-fixture smoke passed**. Первый проверяет выбор translation/target через UI→settings→immutable recording, Pause/Resume и exact PCM. Последний проверяет перевод/скрытый оригинал/раскрытие/reload в собранном renderer; не является проверкой реального ASR.
- Полные Python quality gates пока красные: Ruff 2 замечания (`db.py`, `routes/sessions.py`), mypy 5 (`live_fragments.py`, `test_local_models_stage2_api.py`). Эти файлы не менялись в UI-срезе. Точные команды и логи — [HANDOFF](HANDOFF.md).
- Screenshots перевода/раскрытого оригинала просмотрены, наложений нет. Реальные API/микрофон не запускались; fixtures не подтверждают качество речи/перевода.

## Остаётся общей миграции
1. Translation completeness, ручное восстановление пропусков, импорт/audio-only postprocessing, speaker editing/undo/revisions, компактный общий плеер.
2. Bounded/incremental snapshot, coalescing/reconciliation, quit/sleep UX, lifecycle review и измерение аварийной потери ≤1s.
3. Legacy ASR/UI cleanup; устранение общих lint/type замечаний; реальная ASR/перевод/30min приёмка после локальной проверки. Микрофон требует отдельного разрешения.

**Продукт целиком не готов.** Запрошенный translation-primary UI реализован. Работа самостоятельно, без помощников, commit/push. [Спецификация](SONIOX-CLEAN-UI-SPEC.md).
