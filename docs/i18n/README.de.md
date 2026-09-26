<div align="center">

<img src="../../icon/icon.png" alt="SKAZ" width="120" height="120">

# SKAZ

![macOS Apple Silicon](https://img.shields.io/badge/macOS-Apple_Silicon-111111)
![Alpha](https://img.shields.io/badge/status-alpha-orange)
[![MIT](https://img.shields.io/badge/license-MIT-blue)](../../LICENSE)

[English](../../README.md) · [Русский](README.ru.md) · [Español](README.es.md) · **Deutsch** · [简体中文](README.zh-CN.md)

</div>

**Ein zweites Paar Ohren für Vorlesungen und Meetings.**

SKAZ ist eine macOS-Desktop-App, die Sprache in ein lesbares Transkript verwandelt,
beim Wiederfinden verpasster Inhalte hilft und Fragen und Notizen neben der Quelle bereithält.

> **Alpha / Early Access.** Fehler und inkompatible Änderungen sind möglich, auch am
> Datenformat. Sichere wichtige Exporte. Zielplattform ist derzeit macOS auf Apple Silicon;
> Windows, Linux und Intel-Macs sind nicht verifiziert. Die Oberfläche ist bislang nur auf Englisch verfügbar.

## Ein Blick in die App

![Transkript und Assistent in SKAZ](../images/transcript.png)
*Nach Sprechern gegliederter Text, daneben eine Frage, eine Antwort und ein Quellenverweis.*

![Notiz-Editor in SKAZ](../images/notes.png)
*Bearbeitbare Markdown-Notizen neben dem Sitzungschat.*

Diese Screenshots stammen aus der laufenden App, nicht aus einem Designentwurf.
Transkript, Antwort und Notizen wurden für die Demonstration verfasst; sie sind keine
Ergebnisse echter Spracherkennung oder KI-Ausgaben. Das isolierte Demoprofil hat keine
API-Schlüssel, daher zeigen die Aufnahmefunktionen einen Einrichtungshinweis.

## Warum SKAZ?

Kurz den Faden verloren? Frage nach dem verpassten Inhalt, statt eine ganze Aufnahme
durchzugehen. Lies das Transkript, folge den Quellenverweisen und halte wichtige Punkte
in Notizen fest. KI kann Fehler machen: Quellenlinks erleichtern die Prüfung, garantieren aber keine Richtigkeit.

## Funktionen

- **Live-Transkription und Übersetzung:** Spracherkennung mit Soniox, nach Sprechern
  gegliederter Text und Zugriff auf das Original bei Übersetzungen.
- **Mikrofon und Systemaudio:** Mikrofon auswählen und optional den Ton des Macs
  einbeziehen. Systemaudio benötigt macOS 14.2+ und die entsprechende Systemberechtigung.
- **Fragen mit Kontext:** eine Sitzung oder einen größeren Bibliotheksbereich abfragen
  und über Zeitverweise zum Transkript zurückkehren.
- **Bearbeitbare Notizen:** Notizen erzeugen, Markdown in Tabs bearbeiten und exportieren.
- **Lokale Bibliothek:** Sitzungen gruppieren und Texte optional in einen gewählten
  Ordner spiegeln, etwa für Obsidian.
- **Medienimport (experimentell):** lokale Audio-/Videodateien und YouTube-Inhalte.
  Verarbeite nur Material, für das du die nötigen Rechte hast; Verfügbarkeit und Formate variieren.
- **Getrennte Modellwahl:** Assistant und Notes unabhängig über die Codex-Kontoanmeldung
  oder API-Profile von OpenAI, Anthropic und OpenRouter konfigurieren. Live-Sprache verarbeitet Soniox.

## Installation und erster Start

**Der vorgesehene Downloadkanal ist [GitHub Releases](https://github.com/4IPE/SKAZ/releases).**
Es gibt noch keine veröffentlichten Releases und dort noch kein fertiges Installationspaket.
Um den aktuellen Code auszuprobieren, nutze die [Entwicklungsanleitung](../../CONTRIBUTING.md).

Sobald ein DMG für macOS auf Apple Silicon veröffentlicht wird, öffne es, ziehe SKAZ
nach Applications und starte die App. Beachte die Installations- und Signaturhinweise
des jeweiligen Releases. Alpha-Builds sind nicht zwangsläufig notarisiert; schalte
die Schutzmechanismen von macOS nicht systemweit aus.

Beim ersten Start:

1. Wähle die Sprachen aus, die du voraussichtlich hören wirst.
2. Öffne **Settings → API keys**, trage deinen Soniox-Schlüssel ein, stimme der Cloud-Verarbeitung zu und speichere.
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
- Nach Zustimmung geht Audio zur Erkennung an Soniox. Assistant und Notes senden
  Kontext an den gewählten Dienst. Dessen Speicher- und Trainingsrichtlinien gelten:
  **lokale Speicherung bedeutet nicht Offline-Verarbeitung**.
- API-Schlüssel liegen in einer verschlüsselten Datei, der Verschlüsselungsschlüssel
  daneben. Dateiberechtigungen bilden die wesentliche Schutzgrenze, nicht Schutz vor
  Prozessen unter deinem Benutzerkonto. Sichere auch Exporte und Backups ab.
- Das Python-Backend lauscht nur auf Loopback und verwendet bei jedem Start einen neuen
  Token. Grenzen und den aktuellen Meldekanal beschreibt [Security](../../SECURITY.md).

## Aufbau

```text
Mikrofon / Systemaudio / Medien → Electron → Python → Soniox
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
[GitHub Releases](https://github.com/4IPE/SKAZ/releases) dokumentiert, ohne separates
Changelog. Kleine Korrekturen können direkt als PR kommen; größere Änderungen bitte vorher besprechen.

Prioritäten sind signierte und notarisierte Releases, zuverlässige Wiederherstellung
langer Sitzungen und weitere Erprobung im Alltag. Experimenteller Import und Websuche
sind kein Versprechen von Produktionsreife; die native Codex-Websuche ist derzeit deaktiviert.

[Verhaltensregeln](../../CODE_OF_CONDUCT.md) · [Sicherheit](../../SECURITY.md) · [MIT-Lizenz](../../LICENSE)

*Skaz* (сказ) ist ein russisches Wort für eine mündlich geprägte Erzählung.
Der ursprüngliche Arbeitstitel war AudioHelper. Copyright © 2026 all0b0y.
