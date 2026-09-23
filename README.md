<div align="center">

<img src="icon/icon.png" alt="SKAZ" width="120" height="120">

# SKAZ

**Your second pair of ears for lectures and meetings.**

SKAZ listens along with you, writes a live transcript, translates on the fly,<br>
answers questions about what was just said and keeps notes — every answer backed by the recording itself.

[![macOS](https://img.shields.io/badge/macOS-Apple%20Silicon-111111?logo=apple&logoColor=white)](#getting-started)
[![Electron](https://img.shields.io/badge/Electron-React%20%2B%20TypeScript-47848F?logo=electron&logoColor=white)](#how-it-works)
[![Python](https://img.shields.io/badge/backend-Python%203.11%2B-3776AB?logo=python&logoColor=white)](#how-it-works)
[![Status](https://img.shields.io/badge/status-early%20development-orange)](#project-status)

**English** &nbsp;·&nbsp;
[Русский](docs/i18n/README.ru.md) &nbsp;·&nbsp;
[Español](docs/i18n/README.es.md) &nbsp;·&nbsp;
[Deutsch](docs/i18n/README.de.md) &nbsp;·&nbsp;
[简体中文](docs/i18n/README.zh-CN.md)

</div>

---

## Why SKAZ

You drift off for two minutes in a lecture, and the speaker is already somewhere else.
A colleague says your name in a meeting, and you have no idea what the question was.
Recording everything and rewatching it later does not help *now*.

SKAZ is built for that moment. It runs on your Mac next to the conversation and keeps
a searchable, timestamped record of what was said, so you can ask **"what did I just
miss?"** and get an answer in seconds — with links back to the exact words.

The one rule SKAZ never breaks: **it does not invent what was not said.** If the
recording does not contain the answer, it tells you so, and anything the model adds
from general knowledge is kept apart from what the speakers actually said.

## Features

**🎙️ Live transcript**
Streaming speech recognition from the microphone you choose. Speech is grouped into
monologues by speaker (A → B → A), so the transcript reads like a conversation, not
a wall of words.

**🌍 Live translation**
Pick the languages you expect and get a translation next to the speech as it happens.
The original is always one click away.

**💬 Ask about the recording**
Ask during the session or after it: *"What did I miss?"*, *"What was the definition
of X?"*, *"What did we decide about the budget?"*. Search one session, a group of
sessions or your whole library. Answers cite their sources as footnotes that jump to
the transcript.

**📝 Notes that stay grounded**
Generate structured notes from the transcript. Every point is tied to the speech it
came from, and SKAZ flags notes that fell behind a transcript that kept growing.
Edit them in an Obsidian-style Markdown editor with tabs.

**📂 Your library, as plain files**
Organise sessions into groups and mirror them to a folder of your choice as readable
Markdown, so they work with your own tools — Obsidian, git, Finder search.

**📥 Import recordings**
Drop in an existing audio file and get the same transcript, questions and notes as
for a live session.

**🧩 Bring your own models**
Choose the model for each job independently: transcription, assistant, notes and
search. Supported providers include Soniox (speech), OpenRouter, OpenAI and Anthropic.
There is no silent fallback: if a model cannot do the job, SKAZ says so.

## Privacy by design

- **No audio archive.** Audio is streamed to speech recognition and discarded; SKAZ
  keeps the text, not the recording.
- **Local first.** Transcripts, notes and chats stay on your Mac. Text leaves the
  machine only when you send it to a provider you have configured.
- **Keys stay on the device.** Provider API keys are stored encrypted in the app's
  data folder with owner-only permissions — never in the repository, logs or the UI.
- **Closed backend.** The Python backend listens on loopback only and requires a
  fresh random token on every launch.
- **Speech is data, not commands.** Text heard in the room is never treated as an
  instruction to the assistant.

## How it works

```
 Microphone ──► Electron main ──► Python backend ──► Speech recognition (Soniox)
                     │                  │
                     │                  ├──► SQLite + Markdown library
                     ▼                  └──► Language models (assistant, notes)
              React interface
```

| Layer | Technology | Responsibility |
|---|---|---|
| Desktop shell | Electron | Window, microphone permissions, secure IPC, backend lifecycle |
| Interface | React + TypeScript, Zustand, CodeMirror 6 | Recorder, transcript, assistant, notes, settings |
| Backend | Python 3.11+, FastAPI, SQLite | Audio streaming, recognition, library, assistant, notes |

## Getting started

> SKAZ is in early development and targets **macOS on Apple Silicon**. Other
> platforms have not been tested.

**Requirements:** Node.js 20.19+, Python 3.11+, [uv](https://docs.astral.sh/uv/),
and an API key for at least one supported provider.

```bash
# 1. Install dependencies
npm install
uv sync --project backend

# 2. Run the app in development mode
npm run dev
```

On first launch, open **Settings → API keys**, add your provider keys, then pick the
languages you speak and press **Record**.

### Useful commands

| Command | What it does |
|---|---|
| `npm run dev` | Start the app with hot reload |
| `npm test` | Frontend unit tests (Vitest) |
| `npm run typecheck` | TypeScript checks |
| `uv run --project backend pytest` | Backend tests |
| `npm run dist:mac` | Build `SKAZ.app` and a DMG installer — see [Packaging](docs/PACKAGING.md) |

## Project status

SKAZ is a working prototype under active development. Live transcription, translation,
the assistant, notes, session groups and import already work locally. Still ahead:

- [ ] Notarized, signed release builds
- [ ] Assistant that reads across the library step by step
- [ ] Manual speaker editing
- [ ] Hardened handling of sleep, quit and network loss during long sessions

Expect rough edges and breaking changes until the first release.

## Name

*Skaz* (сказ) is a Russian word for a spoken story — a narrative told in the voice of
the one who speaks it. The repository keeps its original working name, `AudioHelper`.
