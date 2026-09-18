<div align="center">

<img src="icon/icon2.png" alt="SKAZ icon" width="128" height="128">

# 🗣️ SKAZ

**A desktop companion for lectures and meetings that listens, transcribes, translates and takes notes — grounded in what was actually said.**

[![Platform](https://img.shields.io/badge/platform-macOS-lightgrey)](#)
[![Stack](https://img.shields.io/badge/stack-Electron%20%2B%20React%20%2B%20Python-blue)](#)
[![Status](https://img.shields.io/badge/status-active%20development-orange)](#)

**[English](#english)** · **[Русский](#русский)**

</div>

---

<a id="english"></a>

## English

> Codename of the repository and internal paths is `AudioHelper`; the actual product name is **SKAZ**.

SKAZ is a desktop assistant for lectures and meetings: it listens to a selected microphone,
produces a live transcript, and helps you understand what is happening *right now* —
without ever inventing what wasn't said.

**Status:** active development. Requirements and architecture are agreed, part of the
feature set is implemented and covered by local tests. The app is **not** release-ready
and has **not** yet been accepted on real speech / paid APIs. There is no end-user
launch command yet.

### ✨ What's already implemented and locally verified
- **Live ASR on Soniox** — a continuous monologue feed (A/B/A by speaker), no
  timestamps/status noise in the main stream, diagnostics tucked away on demand.
- **Language selection & speech-to-speech translation** with the original always
  revealable.
- **Three recording modes per session** — transcription / translation / audio-only,
  locked in on first open and never silently changed afterwards.
- **Independent notes** — create/edit, 30-day history & restore, staleness detection
  tied to the source, monologues as the unit of citation.
- **Provider-scoped API keys** stored in the OS Keychain (per provider, not per profile/task).
- **Optional (off by default) Markdown session projection** — conflict-safe publishing,
  startup crash recovery, ownership-aware delete, explicit preservation of conflicting
  folders, and a configurable Markdown root (Settings → Files).
- **Backend activity log** and a live backend-status indicator in the UI.
- White/graphite UI redesign.

Exact commands and test results for every slice live in [docs/HANDOFF.md](docs/HANDOFF.md);
a short rollup is in [docs/STATUS.md](docs/STATUS.md).

### 🧭 Planned features (not implemented yet / not finished)

**Notes editor**
- Tabbed frontend notes editor (spec stage 2 — tests green, Electron smoke still failing
  due to disabled native audio + UI redesign).
- Trash & multi-select for sessions (stage 3).
- Export notes as monologues (stage 4).
- Collapsible assistant sources block (spec decision 14/15) — untouched so far.

**File-backed sessions & storage**
- Physical session groups wired into backend navigation; deleting a group moves
  sessions to Ungrouped.
- Physical audio layout inside sessions, safe group/session/root moves, multi-root
  lifecycle.
- Full DB + audio delete/recovery lifecycle (today only Markdown has a recovery path;
  audio does not).
- `Documents/SKAZ` as a default folder — currently only suggested, never auto-enabled;
  needs a full integration/security pass before it can be turned on.
- Resilience against concurrent writes to the same inode, hostile same-user renames,
  multi-process access and power loss — not guaranteed yet.

**CLI & external agents**
- CLI adapters (Claude Code / Codex-style) for an independent Assistant/Notes choice,
  with official auth and explicit install consent.
- A tightly scoped CLI-agent sandbox: session/group only, no audio, no shell, no
  arbitrary disk writes or network.

**ASR / audio**
- Translation completeness & recovery.
- Audio-only post-processing.
- Manual speaker editing with undo (speaker revisions).
- Bounded live snapshots instead of a full snapshot on every poll (needed for long
  sessions).
- Correct quit/sleep handling with measured audio loss.
- Open decision: bring back `retain_native_audio` or rewrite the smoke tests for the
  no-audio-retention policy.

**Security & quality**
- Bind the Keychain ACL to the signed app bundle instead of the Python interpreter
  (currently another process of the same OS user can read the keys without a prompt).
- Outstanding Ruff/mypy debt in files untouched by recent slices (full Python quality
  gates aren't green yet).
- Legacy cleanup after migrations (e.g. fully removing unused experimental config fields).

The always-current next step and exact open edits live at the top of
[docs/HANDOFF.md](docs/HANDOFF.md).

### 📚 Documentation
| Doc | Purpose |
|---|---|
| [docs/PRODUCT.md](docs/PRODUCT.md) | Requirements & acceptance criteria |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System architecture |
| [docs/PROVIDERS.md](docs/PROVIDERS.md) | Providers & their constraints |
| [docs/QUALITY.md](docs/QUALITY.md) | Quality/test boundaries |
| [docs/STATUS.md](docs/STATUS.md) | Current state (short) |
| [docs/HANDOFF.md](docs/HANDOFF.md) | Full slice-by-slice history |
| [IDEA.md](IDEA.md) | Original idea (source of truth, not to be edited) |

### 🧱 Stack
macOS-first · Electron + React (renderer) · a separate Python backend process.
Other OSes are unsupported until independently verified.

---

<a id="русский"></a>

## Русский

> Кодовое имя репозитория и внутренних путей — `AudioHelper`; фактическое название
> продукта — **SKAZ**.

SKAZ — desktop-помощник для лекций и встреч: слушает выбранный микрофон, ведёт
живую транскрипцию и помогает понять, что происходит *сейчас* — не придумывая
того, чего не было сказано.

**Статус:** активная разработка. Требования и архитектура согласованы, часть
функций реализована и покрыта локальными тестами. Приложение **ещё не готово**
к релизу и **не проходило** приёмку на реальной речи и платных API. Команды
запуска для конечного пользователя пока нет.

### ✨ Что уже реализовано и проверено локально
- **Live-ASR на Soniox** — непрерывная лента монологов (A/B/A по спикерам), без
  служебных таймкодов/статусов в основном потоке, диагностика скрыта по умолчанию.
- **Выбор языков записи и перевод** speech-to-speech с возможностью раскрыть оригинал.
- **Три режима записи на сессию** — транскрипция / перевод / только аудио,
  фиксируются при первом открытии и не меняются задним числом.
- **Независимые заметки (Notes)** — создание/правка, история 30 дней и restore,
  детекция устаревания относительно источника, монологи как единица цитирования.
- **Ключи провайдеров** хранятся в Keychain на уровне провайдера, а не профиля/задачи.
- **Опциональная (выключена по умолчанию) файловая проекция сессий в Markdown** —
  conflict-safe публикация, восстановление после сбоя при старте, ownership-aware
  удаление, явное сохранение конфликтных папок и выбор корня Markdown
  (Settings → Files).
- **Журнал активности бэкенда** (Logs) и индикатор статуса бэкенда в интерфейсе.
- Белый/графитовый UI-редизайн.

Точные команды и результаты тестов по каждому срезу — в [docs/HANDOFF.md](docs/HANDOFF.md),
краткая сводка — в [docs/STATUS.md](docs/STATUS.md).

### 🧭 Планируемые функции (ещё не реализованы или не завершены)

**Редактор заметок**
- Фронтенд-редактор заметок с вкладками (этап 2 спеки — тесты зелёные, но
  electron-smoke ещё падает из-за отключения native-аудио и UI-редизайна).
- Корзина и множественный выбор сессий (этап 3).
- Экспорт заметок монологами (этап 4).
- Свёрнутый блок источников у ассистента (решение 14/15 спеки) — не тронут.

**Файловые сессии и хранилище**
- Физические группы сессий и их связь с backend-навигацией; удаление группы с
  переносом сессий в Ungrouped.
- Физический layout аудио внутри сессий, безопасные перемещения групп/сессий/корней,
  multi-root lifecycle.
- Полный жизненный цикл удаления/восстановления БД и аудио (сейчас recovery
  покрывает только Markdown, аудио — нет).
- `Documents/SKAZ` как каталог по умолчанию — пока только предложение, не включено;
  требует полной интеграционной и security-проверки перед включением.
- Устойчивость к конкурентной записи в тот же inode, враждебным переименованиям
  тем же пользователем, multi-process доступу и потере питания — пока не
  гарантируется.

**CLI и внешние агенты**
- CLI-адаптеры (в духе Claude Code / Codex) для независимого выбора Assistant/Notes
  с официальной авторизацией и явным согласием на установку.
- Технически ограниченный scope для CLI-агента: доступ только к сессии/группе,
  без аудио, shell-команд, произвольной записи на диск и произвольной сети.

**ASR / аудио**
- Полнота и восстановление перевода (translation completeness/recovery).
- Постобработка аудио для режима audio-only.
- Ручное редактирование спикеров с undo (speaker revisions).
- Ограниченные по размеру снапшоты живой сессии вместо полного снапшота на
  каждый poll — нужно для длинных сессий.
- Корректная обработка quit/sleep с измерением потери аудио.
- Открытое решение: вернуть `retain_native_audio` или переписать smoke-тесты
  под политику без сохранения аудио.

**Безопасность и качество**
- Привязка Keychain ACL к подписанному бандлу приложения, а не к интерпретатору
  Python (сейчас чужой процесс того же пользователя может прочитать ключи без
  запроса).
- Долги по Ruff/mypy в файлах, не затронутых последними срезами (полные
  Python quality gates ещё не зелёные целиком).
- Legacy-очистка после миграций (например, полный снос неиспользуемых
  экспериментальных полей конфигурации).

Актуальный ближайший шаг и точные незавершённые правки — всегда в верхней части
[docs/HANDOFF.md](docs/HANDOFF.md).

### 📚 Документация
| Документ | Назначение |
|---|---|
| [docs/PRODUCT.md](docs/PRODUCT.md) | Требования и критерии приёмки |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Архитектура системы |
| [docs/PROVIDERS.md](docs/PROVIDERS.md) | Провайдеры и их ограничения |
| [docs/QUALITY.md](docs/QUALITY.md) | Границы проверки качества |
| [docs/STATUS.md](docs/STATUS.md) | Текущее состояние (кратко) |
| [docs/HANDOFF.md](docs/HANDOFF.md) | Полная история срезов |
| [IDEA.md](IDEA.md) | Исходная идея (источник истины, не редактируется) |

### 🧱 Стек
Первый целевой runtime — macOS · Electron + React (renderer) · отдельный
Python-процесс бэкенда. Другие ОС не поддерживаются до отдельной проверки.
