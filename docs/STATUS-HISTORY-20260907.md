# Состояние проекта

## Подтверждено
- Требования/архитектура/публичные границы тестирования сохранены. Пользователь подтвердил тестовые границы и Hermes/pi-композицию интерфейса.
- Настроен доступ исполнителей через Claude Code; реальные modelUsage: claude-opus-5 и claude-opus-4-8. Скрытого fallback нет.
- OpenRouter ключ пользователя успешно проверен; источник .env, переменная OPEN_ROUTER_KEY. Значение не хранится в документах или Git.
- Реальный backend ASR прогон на публичной речи выполнен. Провайдер Gemini2.5FlashLite, 5/5/1сек окна; сохранённую транскрипцию прочитали через API. Подробности: INTEGRATION-FINDINGS.md.
- Микрофонная проверка с участием пользователя разрешена, но запись ещё не запускалась. Обязательно предупредить непосредственно перед ней.

## Реализация в работе
- 2026-09-07 исправлен пустой экран в dev: причина не `tsconfig`, а CSP, блокировавший inline preamble React Fast Refresh. В обе CSP добавлен точный SHA-256 hash; общий `unsafe-inline` для скриптов не разрешён. Регрессионный тест добавлен. Проверено текущим оркестратором (`gpt-5.6-sol`): **100 frontend tests passed**, typecheck/build passed, **3 Electron smoke passed**, отдельный dev-runtime probe отрисовал `AudioHelper` без renderer `pageerror`. Физический микрофон этим не проверялся; backend-регрессии ниже остаются.
- Последний notes-процесс `proc_ce864b8ae994` остановился по лимиту Claude: сброс `1:20am (Europe/Moscow)` (01:20 MSK). Независимый pytest после остановки: **40 failed, 141 passed**. Незавершённое изменение `TranscriptContext` удалило/заменило `labels`, тогда как `agent/ask.py:117` и другие потребители ещё обращаются к нему; Q&A/notes сейчас регрессировали. Предыдущие 181 passed НЕ являются состоянием текущего кода. Полный лог ошибок: `/Users/all0b0y/.hermes/cache/terminal-output/out-1788802425-63347-6750.log`. Исполнители остановлены. До новых улучшений необходимо восстановить согласованный контракт контекста, затем полный pytest/lint/typecheck; не ослаблять тесты. Будущие итерации — меньшие законченные изменения и проверенный локальный снимок до изменений, чтобы лимит не оставлял основной код сломанным.
- Backend citations repair завершён и независимо проверен: **181 passed**, ruff passed, mypy backend/src passed. Live-прогон `.runtime/live-20260907-202858-42a4f0/report.json` подтвердил раскрытие диапазона S2-S3, но **конспект снова не принят**: отдельный пункт из Country с неподтверждённым расширением смысла. Прежние 11 падающих регрессий устранены; качество notes остаётся отдельным блокером. Opus 5 возобновлён как `proc_ce864b8ae994` на ограниченную доработку представления источников конспекта; никаких новых результатов пока не принято.
- Frontend `proc_be8e7ba152b4` завершился нормально. Оркестратор повторил `npm test && npm run typecheck && npm run smoke`: **99 tests passed**, typecheck passed, production build passed, **3 Electron smoke passed**. В `electron/quitController.ts` подтверждена отдельная фаза draining: повторный before-quit блокируется до завершения stopBackend; отклонение/синхронная ошибка stopBackend обрабатываются. Это не приёмка физического микрофона и не подтверждение готовности backend.
- После повторной OAuth-авторизации возобновлены: backend `proc_197f8d5ecb5c` / `claude-opus-5` и frontend `proc_be8e7ba152b4` / `claude-opus-4-8` в прежних сессиях. Точные model ID подтверждены init-событиями `.runtime/opus-backend-citations-resume.jsonl` и `.runtime/opus-frontend-final-review.jsonl`. Backend должен восстановить 11 регрессий цитирования без ослабления тестов; frontend проверяет повторный Cmd+Q при незавершённом shutdown и обработку отказа остановки. Новые результаты пока не приняты.
- Последний backend notes-процесс `proc_192fb6f7025a` остановился по лимиту Claude со сбросом 20:20 MSK. Оркестратор повторил `uv run --project backend pytest backend/tests acceptance -q --tb=short`: **152 passed, 11 failed**. Прежние 163 passed больше НЕ описывают текущий backend. Незавершённая переработка группировки источников затронула разрешение цитат и перенос первоисточников в follow-up; текущие тесты возвращают пустые citations. Не ослаблять тесты и не считать backend принятым. Оба исполнителя остановлены; следующий приоритет — восстановить проходящие регрессии перед новым live-прогоном. Сессия для продолжения: `8410603c-bf06-4508-8b95-a5c3050f2d48` на `claude-opus-5`.
- Frontend `proc_d94c87258eed` остановился по лимиту Claude: `resets 8:20pm (Europe/Moscow)` (20:20 MSK). После остановки оркестратор подтвердил **98 tests passed**, typecheck/build passed и **3 Electron smoke passed**; React act warnings в этом прогоне отсутствуют. Это не физический микрофон. Новые lifecycle/security модули сохранены, полное ревью ещё не завершено.
- 2026-09-07 после 15:20 MSK: лимит сбросился, контрольный Opus 5 вызов успешен. Возобновлены backend `proc_7cd3bb1570ac` и frontend `proc_d94c87258eed` с прежними session/model ID без fallback. Реальный прогон нового Qwen STT + Q&A + notes завершился успешно технически, но качество конспекта/полнота цитат не принято; детали и доказательства в `docs/LIVE-ACCEPTANCE.md`.

### Предыдущие проверки и остановки
- Backend `proc_43bd7808a00a` также остановился: лог подтверждает лимит Claude со сбросом в 15:00 MSK, session `8410603c-bf06-4508-8b95-a5c3050f2d48`. После остановки оркестратор выполнил `uv run --project backend pytest backend/tests acceptance -q --tb=short`: **159 passed**, exit 0. Это детерминированная проверка, не доказательство качества реальной речи/ответов. Оба исполнителя теперь остановлены; актуального работающего процесса разработки нет.
- Проверка оркестратора 2026-09-07 10:25 MSK: frontend 69 тестов passed, typecheck/build passed. Повторный frontend review-fix `proc_d9b8f0b1792d` остановлен лимитом Claude: `resets 3pm (Europe/Moscow)` — ожидаемый сброс 15:00 MSK. Ошибки Cmd+Q/доверенного источника media/валидации captureState IPC ещё не приняты как исправленные; React act warnings остаются. Backend `proc_43bd7808a00a` на момент проверки ещё running. Модели не заменены.
- Последнее указание пользователя: вернуть Opus 5 (backend) и Opus 4.8 (frontend/Electron). Авторизация Claude восстановлена; оба контрольных вызова успешны, modelUsage подтверждает точные ID. Изменения остановленных по usage limit Codex-процессов не откатываются.
- Текущий backend: `claude-opus-5`, session `8410603c-bf06-4508-8b95-a5c3050f2d48`, process `proc_43bd7808a00a`.
- Текущий frontend: `claude-opus-4-8`, session `02e17d1f-8541-4847-9c70-5e0a4bf31a24`, process `proc_f4a85b6aab54`.
- Для обоих: `--permission-mode acceptEdits --allowedTools Read,Write,Edit,Glob,Grep,Bash --max-turns 100 --output-format stream-json --verbose`, без fallback. Инициализация проверена в `.runtime/opus-return-*.jsonl`. Завершение и качество новых изменений пока не проверены.

### История предыдущего запуска (не текущие процессы)
- Пользователь заменил исполнителей Opus 4.8/5 на GPT SOL 5.6 medium. Дальнейшие задачи запущены через Codex CLI с явными `-m gpt-5.6-sol -c 'model_reasoning_effort="medium"'`; контрольный вызов завершился успешно.
- Backend: Codex thread `01a07835-c1be-7520-a0eb-9287f79c0a9a`, процесс `proc_59572f8b8646`. Исправление приёмочных регрессий и настоящий OpenRouter STT API.
- Frontend/Electron: Codex thread `01a07835-c265-7923-bf67-ae7e381eb6cf`, процесс `proc_38b5f87f35c1`. Жизненный цикл записи, сохранность очереди и безопасность IPC.
- Предыдущие исполнители Opus завершились; скрытого переключения назад нет. Новые исполнители прочитали проект и начали работу, что подтверждено JSONL-событиями.
- Логи/промпты/аудио/отчёты в ignored .runtime/; сохранённые идентификаторы сессий позволяют продолжение.

## Последняя независимая проверка (промежуточная)
- `uv run --project backend pytest backend/tests -q`: 52passed,16failed; незавершённый /ask.
- `npm test`:45passed.
- `npm run typecheck`: ошибки test bridge типов.
- `npm run build`: Electron main/preload собраны; React entry ещё отсутствовал.
- `uv run --project backend python scripts/live_smoke.py --asr-only`:passed (реальные внешние запросы), .runtime/live-20260906-201908/report.json.

Эти результаты — snapshot до продолжения исполнителей, не финальная приёмка.

## Открыто
- Завершить агент, конспект, UI и сквозную desktop-интеграцию.
- Исправить/оценить границы аудиоокон: в коротком JFK fixture2ошибки на22слова, хотя цельное аудио распознаётся точно.
- Не считать HTTP200 с произвольным текстом доказательством ASR-совместимости.
- Проверить реальные Q&A/конспекты, микрофон и RU/смешанную речь; локальную ASR ещё не запускали.
- Полные тесты/typecheck/build и независимое ревью. Коммит только по отдельному запросу пользователя.

Статус продукта: **не готов**; отдельные работающие части не заменяют критерии PRODUCT.md.
