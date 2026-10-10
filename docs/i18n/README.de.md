<div align="center">

<img src="../../icon/icon.png" alt="SKAZ" width="128" height="128">

# SKAZ

**Ein zweites Paar Ohren für Vorlesungen und Meetings.**

[![Release](https://img.shields.io/github/v/release/all0b0y/SKAZ?include_prereleases&label=release&color=2f7c72)](https://github.com/all0b0y/SKAZ/releases/latest)
![macOS Apple Silicon](https://img.shields.io/badge/macOS-Apple_Silicon-111111)
![Alpha](https://img.shields.io/badge/status-alpha-orange)
[![MIT](https://img.shields.io/badge/license-MIT-blue)](../../LICENSE)

[English](../../README.md) · [Русский](README.ru.md) · [Español](README.es.md) · **Deutsch** · [简体中文](README.zh-CN.md)

<br>

<img src="../images/skaz-demo.webp" alt="Kurzer Rundgang durch SKAZ: Live-Transkript, Antworten mit Quellen, Suchbereich, Notizen und Sprachanbieter" width="880">

<sub>Kurzer Rundgang · Demoprofil mit vorbereiteten Daten · <a href="../images/skaz-demo.mp4">Video in Full HD (MP4, 34 s)</a></sub>

</div>

SKAZ ist eine macOS-Desktop-App, die Sprache in ein lesbares Transkript verwandelt,
beim Wiederfinden verpasster Inhalte hilft und Fragen und Notizen neben der Quelle bereithält.

> **Alpha / Early Access.** Fehler und inkompatible Änderungen sind möglich, auch am
> Datenformat. Sichere wichtige Exporte. Zielplattform ist derzeit macOS auf Apple Silicon;
> Windows, Linux und Intel-Macs sind nicht verifiziert. Die Oberfläche ist bislang nur auf Englisch verfügbar.

## Ein Blick in die App

<table>
<tr>
<td width="50%"><img src="../images/transcript.webp" alt="Live-Transkript"><br><b>Live-Transkript</b><br>Sprache wird zu lesbarem Text, nach Sprechern gegliedert, daneben der Sitzungschat.</td>
<td width="50%"><img src="../images/sources.webp" alt="Antworten mit Quellen"><br><b>Antworten mit Quellen</b><br>Ein Quellenverweis öffnet genau die Zeile im Transkript.</td>
</tr>
<tr>
<td width="50%"><img src="../images/scope.webp" alt="Suchbereich"><br><b>Suchbereich</b><br>Frag zu einer Sitzung, einer Gruppe oder der ganzen Bibliothek.</td>
<td width="50%"><img src="../images/notes.webp" alt="Bearbeitbare Notizen"><br><b>Bearbeitbare Notizen</b><br>Markdown-Notizen in Tabs, bereit zum Export.</td>
</tr>
<tr>
<td width="50%"><img src="../images/providers.webp" alt="Freie Anbieterwahl"><br><b>Freie Anbieterwahl</b><br>Soniox, OpenAI oder Local Whisper direkt auf diesem Mac.</td>
<td width="50%"><img src="../images/light.webp" alt="Hell und dunkel"><br><b>Hell und dunkel</b><br>Folgt deinem Mac – oder wähle selbst.</td>
</tr>
</table>

Das sind Aufnahmen der laufenden App, keine Entwürfe. Transkripte, Antworten und Notizen sind
eigens verfasste Demodaten, keine echte Spracherkennung oder KI-Ausgabe; der Rundgang oben wurde
mit [Remotion](https://www.remotion.dev) aus denselben Aufnahmen erstellt.

## Warum SKAZ?

Kurz den Faden verloren? Frage nach dem verpassten Inhalt, statt eine ganze Aufnahme
durchzugehen. Lies das Transkript, folge den Quellenverweisen und halte wichtige Punkte
in Notizen fest. KI kann Fehler machen: Quellenlinks erleichtern die Prüfung, garantieren aber keine Richtigkeit.

## Funktionen

- **Live-Transkription und Übersetzung:** Den Spracherkennungsdienst wählst du unter
  **Settings → Transcription** — Soniox (Cloud-Streaming, volle Sprechertrennung,
  Übersetzung), **Local Whisper** (faster-whisper auf diesem Mac, funktioniert ohne Netz;
  ungefähre Sprechertrennung, Übersetzung nur ins Englische) oder OpenAI. Text nach
  Sprechern gegliedert, Original bei Übersetzungen verfügbar. Kein stiller Anbieterwechsel.
- **Mikrofon und Systemaudio:** Mikrofon auswählen und optional den Ton des Macs
  einbeziehen. Systemaudio benötigt macOS 14.2+ und die entsprechende Systemberechtigung.
- **Fragen mit Kontext:** eine Sitzung, eine Gruppe oder die ganze Bibliothek abfragen
  und über Zeitverweise zum Transkript zurückkehren.
- **Bearbeitbare Notizen:** Notizen erzeugen, Markdown in Tabs bearbeiten und exportieren.
- **Lokale Bibliothek:** Sitzungen gruppieren und Texte optional in einen gewählten
  Ordner spiegeln, etwa für Obsidian.
- **Medienimport (experimentell):** lokale Audio-/Videodateien und YouTube-Inhalte.
  Verarbeite nur Material, für das du die nötigen Rechte hast; Verfügbarkeit und Formate variieren.
- **Getrennte Modellwahl:** Assistant und Notes unabhängig über die Codex-Kontoanmeldung
  oder API-Profile von OpenAI, Anthropic und OpenRouter konfigurieren. Live-Sprache verarbeitet der gewählte Transkriptionsdienst.

## Installation und erster Start

Lade das neueste DMG von [GitHub Releases](https://github.com/all0b0y/SKAZ/releases/latest)
herunter (Apple Silicon, macOS 13 oder neuer), öffne es, ziehe SKAZ nach Applications und
starte die App. Alpha-Builds sind noch nicht notarisiert: Folge beim ersten Start den Schritten
in den Release-Notes (**Privacy & Security → Open Anyway**). Schalte die Schutzmechanismen von
macOS nicht systemweit aus. Den aktuellen Code startest du über die [Entwicklungsanleitung](../../CONTRIBUTING.md).

Beim ersten Start:

1. Wähle die Sprachen aus, die du voraussichtlich hören wirst.
2. Öffne **Settings → API keys**, trage deinen Soniox-Schlüssel ein, stimme der Cloud-Verarbeitung zu und speichere —
   oder wähle, damit Audio auf dem Mac bleibt, **Local Whisper** unter **Settings → Transcription**
   und lade ein Modell (die Größe wird vorher angezeigt; kein Schlüssel und keine Cloud-Zustimmung nötig).
3. Wähle unter **Settings → Transcription** Transkription oder Übersetzung und die Zielsprache.
4. Richte **Assistant** und **Notes** getrennt ein. Für Codex installierst du die
   offizielle [Codex CLI](https://developers.openai.com/codex/cli/) und meldest dich
   über die Codex-Einstellungen in SKAZ an; eine automatische Installation gibt es
   nicht. Alternativ richtest du einen API-Anbieter mit Schlüssel und Modell ein.
   Zugangsbedingungen, Limits und Gebühren des Anbieters gelten.
5. Erstelle eine Sitzung, wähle Audioquellen, erteile die nötigen macOS-Berechtigungen
   und drücke **Record**. Pausiere oder stoppe bei Bedarf; unter **Notes** arbeitest du mit den Notizen zum Transkript.

Hole vor der Aufnahme anderer Personen die erforderliche Zustimmung ein. Soniox und
Textmodelldienste haben eigene Preise; ihre Nutzung ist nicht in der MIT-Lizenz enthalten.

## Datenschutz und Daten

- Transkripte, Notizen und Chats werden lokal gespeichert. Es gibt kein dauerhaftes
  Live-Audioarchiv zur Wiedergabe; temporäres Audio kann zur Verarbeitung oder Wiederherstellung verwendet werden.
- Mit Soniox oder OpenAI geht Audio nach Zustimmung an diesen Anbieter; mit Local Whisper
  wird es auf diesem Mac erkannt und nie gesendet. Assistant und Notes senden
  Kontext an den gewählten Dienst. Dessen Speicher- und Trainingsrichtlinien gelten:
  **lokale Speicherung bedeutet nicht Offline-Verarbeitung**.
- API-Schlüssel liegen in einer verschlüsselten Datei, der Verschlüsselungsschlüssel
  daneben. Dateiberechtigungen bilden die wesentliche Schutzgrenze, nicht Schutz vor
  Prozessen unter deinem Benutzerkonto. Sichere auch Exporte und Backups ab.
- Das Python-Backend lauscht nur auf Loopback und verwendet bei jedem Start einen neuen
  Token. Grenzen und den aktuellen Meldekanal beschreibt [Security](../../SECURITY.md).

## Aufbau

```text
Mikrofon / Systemaudio / Medien → Electron → Python → Soniox | Local Whisper | OpenAI
                                    ↓         ↓
                                React UI   Lokale Bibliothek
                                              ↕
                                   Assistant-/Notes-Anbieter
```

| Ebene | Technik |
|---|---|
| Desktop | Electron |
| Oberfläche | React, TypeScript, CodeMirror |
| Lokales Backend | Python, FastAPI, SQLite |

## Entwicklung und Projektstand

[Contributing](../../CONTRIBUTING.md) beschreibt Einrichtung, Tests und PRs;
[Packaging](../PACKAGING.md) den Installer-Bau. Änderungen werden in
[GitHub Releases](https://github.com/all0b0y/SKAZ/releases) dokumentiert, ohne separates
Changelog. Kleine Korrekturen können direkt als PR kommen; größere Änderungen bitte vorher besprechen.

Prioritäten sind signierte und notarisierte Releases, zuverlässige Wiederherstellung
langer Sitzungen und weitere Erprobung im Alltag. Experimenteller Import und Websuche
sind kein Versprechen von Produktionsreife; die native Codex-Websuche ist derzeit deaktiviert.

[Verhaltensregeln](../../CODE_OF_CONDUCT.md) · [Sicherheit](../../SECURITY.md) · [MIT-Lizenz](../../LICENSE)

*Skaz* (сказ) ist ein russisches Wort für eine mündlich geprägte Erzählung.
Der ursprüngliche Arbeitstitel war SKAZ. Copyright © 2026 all0b0y.
