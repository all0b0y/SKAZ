# Markdown projection — проверенный backend-срез, не готовый файловый продукт

## Включение и границы

Проекция **выключена по умолчанию**. Settings→Files предлагает OS Documents/SKAZ
или другую папку через native picker. Выбор — только кандидат; отдельное подтверждение
сохраняет настройку в SQLite, затем UI читает её обратно. Сам выбор не создаёт папок,
не переносит аудио/файлы и не импортирует внешний текст. Documents/SKAZ — предложение,
не автоматическое включение полного файлового режима. Физические группы/audio ещё впереди.
`AppConfig.session_files_root` / `AUDIOHELPER_SESSION_FILES_ROOT` остаётся read-only override
сохранённой настройки, не стирает её. Нет второго постоянного audio storage path.
Пользовательские каталоги в ходе разработки не менялись.

Текущий layout: `<root>/Ungrouped/<session-id>/Transcript.md`,
`Note-<note-id>.md`. UUID-идентичности, не title/транскрипция, определяют пути.
`Ungrouped` здесь пока единственный backend-каталог; UI-группы ещё не связаны с ним.
Аудио, DB и первичное состояние остаются в прежнем application data directory.

### Контракт выбора корня
- `GET /storage/root` читает `root`, `suggested_root`, `managed`, `change_locked`,
  `mode: markdown_projection`. Electron передаёт системный Documents path, standalone
  backend использует `~/Documents`; `SKAZ` добавляет backend. Нет mkdir или сканирования.
- `PUT /storage/root` требует `root` и `expected_root`, оба string|null. CAS по предыдущему
  значению под общим projection/preserve/delete lock; SQLite commit до смены effective root.
  При неизвестном исходе PUT интерфейс блокирует новый write до явного GET; сырые ошибки скрыты.
- Manifest, publication intent (в том числе неудачная первая запись) или preservation
  блокируют смену/отключение. Read-only startup audit без публикации не блокирует.
  Это отказ до безопасного переноса, не реализованный multi-root move. После удаления
  всех сессий оставшиеся внешние/сохранённые папки не сканируются и не удаляются.
- Абсолютные пути без нормализации пользовательского ввода, dot/traversal/control characters,
  symlinks в существующих компонентах и пересечение private data directory отклоняются.
  OS aliases известного private directory разрешаются только для проверки пересечения;
  выбранный root никогда не resolve-ится с обходом ссылок. Существующие чужие файлы не присваиваются.
- Проверка при выборе не доказывает writability или неизменность inode в будущем.
  Публикация повторяет no-follow traversal. Hostile same-user замена обычного каталога,
  multi-process writers и power-loss по-прежнему не покрыты. `expected_root` — сравнение
  значения, не монотонная ревизия (не защита от ABA).
- Проверены HTTP/disk/restart, invalid paths/private alias/links, конкурирующий выбор,
  SQLite failure, failed publication intent и реальный os._exit до/после preference commit.
  Electron smoke проходит UI picker→confirmation→GET→projection→restart, сохраняя external
  root-level fixture. Только OS dialog возвращает fixture-path; native dialog interaction
  пользователя этим smoke не проверено. UserData, sessionData и Documents изолированы.

## Запуск проекции

- Native Pause/Stop: закрыть provider tail → durable session status → файловая
  проекция → `stream.stopped`. Файловая ошибка не означает потерю сохранённого PCM.
- Legacy PATCH paused/stopped: после штатного flush, если он не отключён клиентом.
- Успешные Notes create/replace/manual edit/history restore: после сохранения в DB.
- `POST /sessions/{id}/files`: повторить проекцию без вызова модели.
- `GET /sessions/{id}/files`: прочитать последний результат, без файловых writes.
  Существующая общая backend-аутентификация обязательна; отсутствующая сессия404.
  Оба endpoint доступны через renderer IPC allowlist; произвольные файловые
  операции/имена файлов не добавлены; выбор корня имеет отдельный узкий контракт выше.
- При startup выполняется off-loop проверка существующих каталогов известных DB-сессий.
  Она обновляет только служебный status в DB, не создаёт каталогов, не генерирует Notes,
  не меняет Markdown. Неизвестные сессии/другие корни не сканируются.

Транскрипт включает стабильные исходные segments, их timestamps и anchors по ID.
Partial/draft и перевод не превращаются в первичный источник. Notes сохраняют свой
Markdown и appendix со ссылками на источник. При конфликте Transcript ссылки новых
Notes указывают на сохранённую app-копию, а не внешний файл без исходных anchors.
Это не новая генерация заметки и не доказательство полноты ASR.

## Результат API

`state`: `disabled`, `pending`, `ready`, `conflict` или `error`.
После попытки проекции: `directory` (относительный), `files` и `conflicts`.
`source_version` — непрозрачный fingerprint исходного snapshot (title, source revision,
IDs/revisions/provenance Notes), не номер ревизии и не доказательство владения файлом.
При restart изменение snapshot до export, отсутствующий файл или расхождение с manifest
снимает прежний `ready`: `pending`, либо `conflict`, если найдены сохранённые версии.
Элемент: `{name, path, state}`; состояния файла:
- `written` / `unchanged`: canonical содержит версию приложения;
- `conflict`: canonical внешний, `path` — полная app-копия;
- `conflict_recovered`: внешний файл заменился в момент atomic exchange;
  canonical содержит app-версию, `path` сохраняет вытесненную внешнюю версию.
- `recovery_required` (в `conflicts`): обнаружен ранее не зарегистрированный
  `*.recovery-*.md` или `*.conflict-*.md`. Имя не доказывает происхождение/полноту.
  Startup не читает содержимое этих artifacts, не присваивает их приложению и не удаляет.

При OS/path failure: `error: file_projection_failed`, без сырых путей/исключений.
`files` может содержать уже опубликованные документы: атомарность **на файл**, не
транзакция всех файлов с DB. DB остаётся источником истины; retry восстанавливает
проекцию, а не повторяет Notes-generation. Конфликты остаются в status после retry,
пока соответствующие конфликтные файлы существуют. Явное разрешение описано ниже.

## Desktop: статус и явный повтор

Общая панель над RecorderBar видна на вкладках Transcript и Notes, только если
проекция включена или её статус прочитать не удалось. `disabled` скрывает панель
и останавливает периодический опрос; настройки включения не меняются.

- Последовательный GET через 3 секунды после ответа; дополнительное чтение после
  изменения detail/Notes, Pause/Stop, генерации или подтверждённого чтения настройки root
  (это также обновляет ранее disabled-панель). Во время незавершённого запроса
  обновления объединяются в одно последующее чтение. Нет фоновых POST/model calls.
- Явная кнопка «Повторить сохранение файлов» вызывает POST без тела/путей. На время
  запроса, записи/processing и генерации Notes она заблокирована. Повтор не разрешает
  конфликты и не удаляет аварийные версии; предупреждение сохраняется.
- При transport failure результат неизвестен: UI предлагает read-only проверку,
  не повторяет POST автоматически и не показывает сырые тексты исключений.
- Панель обозначает **результат последнего сохранения**, не актуальный audit папки
  и не подтверждение сохранности аудио. GET не замечает новые внешние правки на диске.
- В details отображаются относительный каталог и сохранённые conflict/recovery names
  как инертный текст, без file-links/HTML. Длинные имена переносятся, список прокручивается.
  Поздние ответы после переключения сессии/закрытия панели не применяются.

Проверено: UI через реальный ApiClient и fixture IPC; production Electron smoke
настоящим кликом retry обнаруживает созданный после GET recovery-файл, сохраняет
внешний canonical и conflict copy, читает результат через main/backend и показывает
предупреждение в обеих tabs. Модель и микрофон не вызываются.

## Защита и устойчивость

### Явное сохранение всех версий и восстановление

`POST /sessions/{id}/files/preserve` доступен через узкий IPC route без произвольных
путей/имён и без модели. В details панели пользователь открывает подтверждение:
вся прежняя Markdown-папка сохраняется рядом как
`Ungrouped/<session-id>.preserved-<operation-id>`, затем приложение заново создаёт
canonical Transcript/Notes из БД. Это не импорт, объединение или удаление внешних правок.
Сначала нужно закрыть файлы в других редакторах. Архивы не удаляются вместе с сессией;
пользователь проверяет их и управляет ими самостоятельно вне SKAZ.

Перенос использует held parent FD и native no-replace rename целой папки, без
обхода её содержимого: неизвестные файлы, вложенные каталоги и ссылки сохраняются
как entries, цели ссылок не читаются и не меняются. Сам путь session/root не может
проходить через symlink. Никогда не использованная внешняя папка не переносится.
Повтор для полностью owned/неизменной папки не создаёт новый архив.

Перед rename сохраняется SQLite intent с dev/inode и destination. После rename
проверяется фактически захваченная identity, fsync(parent), затем одной DB-транзакцией
подтверждается перенос и снимается старый manifest. Pending-операция блокирует
обычный project/delete; только явный preserve повторяет её. При неизвестном ответе
desktop предлагает GET, не повторяет запись. `preserved_directories` содержит
относительные пути зарегистрированных операций; при `preservation_pending=true`
это также планируемые пути, не доказательство существования каждого архива.
После успешного завершения `preservation_pending=false`; архивы не аудируются при GET.

Проверены реальные process deaths после intent commit, rename+fsync и final commit,
отказ fsync, поздний файл, занятый destination и подмена source на syscall boundary.
При подмене ни исходная, ни захваченная внешняя папка не удаляются; identity mismatch
остаётся fail-closed и требует ручного вмешательства. Это не inode-CAS rename,
не multi-process/power-loss гарантия. Архив — перемещённый каталог, не immutable backup:
уже открытый внешним редактором inode может продолжать меняться.

- Все компоненты пути открываются через directory FD + O_NOFOLLOW. Symlinks,
  hardlinked canonical files и non-regular files отклоняются без чтения содержимого.
- Полный temporary file, fsync/F_FULLFSYNC на macOS, sync directory; no-clobber
  публикация новых файлов, persistent digest manifest в DB после publication.
- Перед файловыми writes сохраняется `pending`, до финального status commit.
  Новые файлы публикуются native no-replace rename, не link+unlink: смерть процесса
  между link/unlink оставляла два hardlink и блокировала безопасный retry.
- Хеш проверяется до и после медленной записи. Для существующего canonical:
  atomic exchange (macOS renameatx_np / Linux renameat2), затем проверка вытесненного
  объекта; неожиданная версия сохраняется, не удаляется. Нет unsafe replace fallback.
  В этом запуске реальный syscall проверен **на macOS**, не на Linux/Windows.
- Повторный неизменный конфликт использует ту же content-addressed app-копию.
  Внешние правки этой копии не затираются.
- Disk I/O выполняется не на event loop; внутренние exports сериализованы,
  snapshot снимается после writer lock. Удаление сессии ждёт активного export.
- Обычная история Notes остаётся только в DB. При аварии/неизвестной ошибке после
  exchange `*.recovery-*.md` намеренно остаётся; это аварийное сохранение, не история.
- Startup и каждый retry находят такие artifacts через directory FD без следования
  ссылкам; regular single-link файлы включаются в сохраняемый список конфликтов.
  Symlink/hardlink/non-regular artifacts дают sanitized error, без удаления/чтения цели.
  Отсутствующий ownership manifest не восстанавливается только по совпавшему тексту:
  retry сохраняет app-копию отдельно, даже если canonical уже содержит те же bytes.
- Проверены реальные `os._exit(73)` в дочернем backend-процессе: после file fsync,
  первой публикации, exchange, публикации conflict, manifest commit и Note commit до
  вызова projection. После restart — статус, нетронутые bytes, явный retry, повторный
  restart; без повторной генерации. Это process crash, **не** испытание потери питания.

## Удаление сессии

`DELETE /sessions/{id}` сначала завершает native stream и ждёт writer lock. Для
включённой проекции проверяет **все** имеющиеся entries: только canonical имена,
записанные в manifest, regular single-link и совпадающий digest допускают cleanup.
Unknown files, внешние правки, conflict/recovery versions, symlinks/hardlinks и
каталоги дают409 до начала cleanup. Имя или совпадение с текущим DB-текстом сами
по себе не дают владения. Новых каталогов для удаления не создаётся.

Каждый canonical сначала атомарно переносится в случайное recovery-имя, затем
повторно проверяется digest фактически перемещённого объекта. Неожиданная версия
возвращается только через no-replace rename; если canonical уже занят, сохраняются
оба объекта. Лишь подтверждённая версия удаляется. Directory fsync и pending status
предшествуют завершению. Пустой использованный session directory удаляется через
rmdir относительно удерживаемого parent FD, после сверки inode с открытым каталогом.
Recursive cleanup не используется; появившийся перед rmdir файл даёт отказ ОС.
Никогда не использованный пустой внешний каталог, Ungrouped и root не удаляются.
Сверка stat→rmdir не является inode-CAS: hostile same-user подмена на другой пустой
каталог в этом окне пока не исключена; нельзя заявлять защиту от всех rename races.

При файловом отказе DB, Notes, аудио и manifest сессии сохраняются; клиент получает
sanitized409 без сырых путей. Часть **принадлежащих приложению** Markdown могла уже
удалиться до поздней ошибки — явный POST files восстанавливает проекцию без модели.
Внешние версии не удаляются автоматически. Старый использованный root нельзя обойти
отключением/сменой настройки; недоступный прежний каталог требует восстановления
доступа. Read-only startup status для никогда не использованного root не блокирует
удаление. Работа с несколькими действительно использованными roots ещё не реализована.

После успешного Markdown cleanup выполняется прежнее удаление DB и application-audio.
Это не общая crash-atomic транзакция: смерть после DB commit до audio cleanup ещё
может оставить audio orphan. Полная переработка audio lifecycle впереди. Проверенная
смерть процесса после Markdown rename+fsync сохраняет DB и recovery; startup показывает
conflict, повтор DELETE отказывает, POST files восстанавливает canonical и сохраняет
artifact. Дополнительно проверена смерть после rmdir+parent fsync: первичная сессия
остаётся в DB, startup не показывает ready, DELETE409 до явного POST files, который
восстанавливает проекцию без модели; затем удаление можно повторить. Recovery artifacts
автоматически не чистятся. Это не автоматическое завершение прерванного удаления.

Настоящий Electron-клик Delete с внешним Transcript и conflict/recovery файлами
проверяет409 в dialog, сохранность сессии и исходного PCM. Затем настоящий UI-клик
подтверждает сохранение всех версий отдельно, backend восстанавливает canonical
Markdown; GET подтверждает путь архива, повторный Delete удаляет сессию и owned
Markdown, не трогая архивные bytes. Ручного fixture-переноса файлов больше нет.
Проверка в temp-root, не изменение пользовательских файлов. Ограничения ongoing
open-inode/multi-process writers сохраняются.

## Непринятые критерии / следующий этап

Это **не** полная security/lifecycle-приёмка файлового хранилища:
- Реализованы консервативное обнаружение незавершённой проекции/сохранённых versions
  и безопасный явный retry, **не** автоматическое разрешение конфликтов/cleanup.
  Recovery artifacts сохраняются до ручного решения; исторические stranded hardlinks
  старого link-based writer остаются fail-closed, автоматически не разрываются.
- Не проверены power-loss durability, все возможные межоперационные гонки и запуск
  нескольких writer-процессов в один root/DB. Startup audit пока без отдельного
  latency-бюджета на большое число файлов; проекция остаётся opt-in.
- внешний редактор, продолжающий запись через уже открытый inode во время/после
  обмена, не координируется с приложением; абсолютная защита такого сценария не доказана;
- ownership-aware canonical Markdown cleanup и rmdir пустой использованной папки
  подключены; crash-atomic DB/audio delete, перенос roots/groups и multi-root cleanup не готовы;
- picker и предложение Documents/SKAZ подключены только для явной Markdown-проекции;
  default полного файлового режима, группы/moves/audio layout и CLI adapters/security не готовы.
  UI предупреждения, явный retry и недеструктивное разрешение конфликтов подключены.

До закрытия этих пунктов не включать проекцию по умолчанию и не объявлять весь
SESSION-FILES-CLI-SPEC реализованным. Проверки:60 HTTP/WS/filesystem cases,
включая13новых preservation cases с3новыми process-death boundaries;
Electron native/quit smoke с явно изолированным root проверяет реальные файлы,
повторное открытие, внешний conflict и сохранность PCM. Это не речь/платная API-приёмка.
