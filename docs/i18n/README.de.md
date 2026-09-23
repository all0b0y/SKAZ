<div align="center">

<img src="../../icon/icon.png" alt="SKAZ" width="120" height="120">

# SKAZ

**Ein zweites Paar Ohren für Vorlesungen und Meetings.**

SKAZ hört mit, erstellt ein Live-Transkript, übersetzt in Echtzeit,<br>
beantwortet Fragen zum gerade Gesagten und schreibt Notizen — jede Antwort gestützt auf die Aufnahme selbst.

[![macOS](https://img.shields.io/badge/macOS-Apple%20Silicon-111111?logo=apple&logoColor=white)](#erste-schritte)
[![Electron](https://img.shields.io/badge/Electron-React%20%2B%20TypeScript-47848F?logo=electron&logoColor=white)](#so-funktioniert-es)
[![Python](https://img.shields.io/badge/backend-Python%203.11%2B-3776AB?logo=python&logoColor=white)](#so-funktioniert-es)
[![Status](https://img.shields.io/badge/status-early%20development-orange)](#projektstatus)

[English](../../README.md) &nbsp;·&nbsp;
[Русский](README.ru.md) &nbsp;·&nbsp;
[Español](README.es.md) &nbsp;·&nbsp;
**Deutsch** &nbsp;·&nbsp;
[简体中文](README.zh-CN.md)

</div>

---

## Warum SKAZ

Zwei Minuten abgelenkt in der Vorlesung — und der Vortrag ist schon beim nächsten
Thema. Im Meeting fällt Ihr Name, aber die Frage haben Sie verpasst. Alles aufzunehmen
und später anzusehen hilft *jetzt* nicht.

SKAZ ist für genau diesen Moment gemacht. Die App läuft auf Ihrem Mac neben dem
Gespräch und führt ein durchsuchbares Protokoll mit Zeitstempeln. So können Sie
**„Was habe ich gerade verpasst?“** fragen und bekommen in Sekunden eine Antwort — mit
Verweisen auf den genauen Wortlaut.

Die eine Regel, die SKAZ nie bricht: **Es erfindet nichts, was nicht gesagt wurde.**
Enthält die Aufnahme keine Antwort, sagt SKAZ das. Was das Modell aus Allgemeinwissen
ergänzt, bleibt klar getrennt von dem, was tatsächlich gesagt wurde.

## Funktionen

**🎙️ Live-Transkript**
Streaming-Spracherkennung vom Mikrofon Ihrer Wahl. Die Sprache wird nach Sprechern
in Monologe gegliedert (A → B → A) und liest sich wie ein Gespräch.

**🌍 Live-Übersetzung**
Wählen Sie die erwarteten Sprachen, und die Übersetzung erscheint direkt neben dem
Gesprochenen. Das Original ist immer nur einen Klick entfernt.

**💬 Fragen an die Aufnahme**
Während der Sitzung oder danach: *„Was habe ich verpasst?“*, *„Wie wurde X
definiert?“*, *„Was wurde zum Budget entschieden?“*. Suchen Sie in einer Sitzung, einer
Gruppe oder der ganzen Bibliothek. Antworten belegen ihre Quellen mit Fußnoten, die
direkt ins Transkript springen.

**📝 Notizen mit Quellenbezug**
Strukturierte Notizen aus dem Transkript. Jeder Punkt ist mit der Stelle verknüpft,
aus der er stammt, und SKAZ markiert Notizen, die hinter einer weiterlaufenden
Aufnahme zurückliegen. Bearbeitung in einem Markdown-Editor mit Tabs im Stil von
Obsidian.

**📂 Ihre Bibliothek als normale Dateien**
Ordnen Sie Sitzungen in Gruppen und spiegeln Sie sie als lesbares Markdown in einen
Ordner Ihrer Wahl — für Obsidian, git oder die Finder-Suche.

**📥 Aufnahmen importieren**
Fügen Sie eine vorhandene Audiodatei hinzu und erhalten Sie dasselbe Transkript,
dieselben Fragen und Notizen wie bei einer Live-Sitzung.

**🧩 Eigene Modelle**
Wählen Sie das Modell für jede Aufgabe einzeln: Transkription, Assistent, Notizen und
Suche. Unterstützt werden Soniox (Sprache), OpenRouter, OpenAI und Anthropic. Kein
stiller Ersatz: Wenn ein Modell die Aufgabe nicht kann, sagt SKAZ es.

## Datenschutz von Grund auf

- **Kein Audioarchiv.** Audio wird an die Spracherkennung gestreamt und verworfen;
  SKAZ behält den Text, nicht die Aufnahme.
- **Lokal zuerst.** Transkripte, Notizen und Chats bleiben auf Ihrem Mac. Text geht
  nur an einen Anbieter, den Sie selbst eingerichtet haben.
- **Schlüssel bleiben auf dem Gerät.** API-Schlüssel liegen verschlüsselt im
  Datenordner der App, nur für den Besitzer lesbar.
- **Abgeschottetes Backend.** Das Python-Backend lauscht nur auf Loopback und verlangt
  bei jedem Start ein neues Zufallstoken.
- **Sprache ist Datum, kein Befehl.** Im Raum Gehörtes wird nie als Anweisung an den
  Assistenten behandelt.

## So funktioniert es

```
 Mikrofon ──► Electron main ──► Python-Backend ──► Spracherkennung (Soniox)
                   │                  │
                   │                  ├──► SQLite + Markdown-Bibliothek
                   ▼                  └──► Sprachmodelle (Assistent, Notizen)
           React-Oberfläche
```

| Schicht | Technologie | Aufgabe |
|---|---|---|
| Desktop-Hülle | Electron | Fenster, Mikrofonrechte, sicheres IPC, Backend-Lebenszyklus |
| Oberfläche | React + TypeScript, Zustand, CodeMirror 6 | Aufnahme, Transkript, Assistent, Notizen, Einstellungen |
| Backend | Python 3.11+, FastAPI, SQLite | Audio-Streaming, Erkennung, Bibliothek, Assistent, Notizen |

## Erste Schritte

> SKAZ befindet sich in einer frühen Phase und zielt auf **macOS mit Apple Silicon**.
> Andere Plattformen wurden nicht getestet.

**Voraussetzungen:** Node.js 20.19+, Python 3.11+, [uv](https://docs.astral.sh/uv/)
und ein API-Schlüssel für mindestens einen unterstützten Anbieter.

```bash
# 1. Abhängigkeiten installieren
npm install
uv sync --project backend

# 2. App im Entwicklungsmodus starten
npm run dev
```

Öffnen Sie beim ersten Start **Settings → API keys**, tragen Sie Ihre Schlüssel ein,
wählen Sie Ihre Sprachen und drücken Sie **Record**.

### Nützliche Befehle

| Befehl | Funktion |
|---|---|
| `npm run dev` | App mit Hot Reload starten |
| `npm test` | Frontend-Unit-Tests (Vitest) |
| `npm run typecheck` | TypeScript-Prüfung |
| `uv run --project backend pytest` | Backend-Tests |
| `npm run dist:mac` | `SKAZ.app` und DMG bauen — siehe [Packaging](../PACKAGING.md) |

## Projektstatus

SKAZ ist ein funktionierender Prototyp in aktiver Entwicklung. Live-Transkription,
Übersetzung, Assistent, Notizen, Sitzungsgruppen und Import funktionieren bereits
lokal. Noch offen:

- [ ] Signierte, notarisierte Release-Builds
- [ ] Ein Assistent, der die Bibliothek schrittweise durchliest
- [ ] Manuelles Bearbeiten von Sprechern
- [ ] Robustes Verhalten bei Ruhezustand, Beenden und Netzverlust in langen Sitzungen

Bis zum ersten Release sind Ecken, Kanten und inkompatible Änderungen zu erwarten.

## Der Name

*Skaz* (сказ) ist ein russisches Wort für eine mündliche Erzählung, vorgetragen mit
der Stimme des Erzählenden. Das Repository trägt weiterhin den Arbeitsnamen
`AudioHelper`.
