<div align="center">

<img src="../../icon/icon.png" alt="SKAZ" width="128" height="128">

# SKAZ

### Vorlesungen, Meetings und Dokumente als Wiki, das du fragen kannst

Aufnehmen oder Quelle hinzufügen · fragen mit genauen Belegen · ein Wiki, das sich selbst aktuell hält

[![Release](https://img.shields.io/github/v/release/all0b0y/SKAZ?include_prereleases&label=release&color=2c2e31)](https://github.com/all0b0y/SKAZ/releases/latest)
![macOS Apple Silicon](https://img.shields.io/badge/macOS-Apple_Silicon-111111)
![Alpha](https://img.shields.io/badge/status-alpha-orange)
[![MIT](https://img.shields.io/badge/license-MIT-blue)](../../LICENSE)

[English](../../README.md) · [Русский](README.ru.md) · [Español](README.es.md) · **Deutsch** · [简体中文](README.zh-CN.md)

<br>

<img src="../images/skaz-tour.webp" alt="Rundgang durch SKAZ: eine Vorlesung aufnehmen, mit Fußnote danach fragen, eine Änderung des Agenten erlauben, Karteikarten aus der Vorlesung lernen" width="880">

<sub>Produkt-Rundgang · Demoprofil mit vorbereiteten Daten · <a href="../images/skaz-tour.mp4">Der ganze Rundgang in Full HD (MP4, 80 s)</a></sub>

<br><br>

[**Installation**](#-installation) · [**Funktionen**](#-funktionen) · [**Datenschutz**](#-datenschutz-und-daten) · [**Aufbau**](#-aufbau) · [**Mitmachen**](../../CONTRIBUTING.md)

</div>

---

SKAZ ist eine macOS-App für alles, was du hörst und liest. Nimm eine Vorlesung oder ein Meeting
auf oder füge ein PDF, einen Artikel, einen Videolink oder eine Datei hinzu. SKAZ legt jede Quelle
in deinem eigenen Ordner mit Markdown-Dateien ab, baut daraus ein Wiki und beantwortet Fragen mit
Links auf die genaue Stelle oder Seite.

> [!WARNING]
> **Alpha / Early Access.** Rechne mit Fehlern und inkompatiblen Änderungen, auch an gespeicherten
> Daten. Sichere wichtige Exporte. SKAZ ist für macOS auf Apple Silicon gedacht; Windows, Linux und
> Intel-Macs sind nicht geprüft. Die Oberfläche gibt es vorerst nur auf Englisch.

## 💡 Warum SKAZ

Eine Vorlesung, das Meeting von letzter Woche, ein gelesenes Kapitel: Sie landen an verschiedenen
Orten, und nichts verbindet sie. SKAZ hält sie zusammen. Jede Quelle bekommt Notizen und
Begriffsseiten in einem Wiki, sodass dieselbe Idee aus Vorlesung und Lehrbuch auf einer Seite
landet. Frag *„Was hat sie zum zweiten Hauptsatz gesagt?"* und folge der Fußnote zu der Sekunde,
in der es gesagt wurde.

KI kann sich irren. Belege helfen, eine Antwort zu prüfen; sie garantieren nicht, dass sie stimmt.

## 👀 So sieht es aus

<table>
<tr>
<td width="50%"><img src="../images/tour-record.webp" alt="Eine Vorlesung in einen Ordner aufnehmen"><br><b>In einen Ordner aufnehmen</b><br>Ordner wählen, Record drücken – das Transkript erscheint beim Sprechen, nach Sprecher und Zeit.</td>
<td width="50%"><img src="../images/tour-ask.webp" alt="Eine Antwort mit Fußnoten"><br><b>Antworten mit Belegen</b><br>Jede Aussage hat eine Fußnote. Öffne sie, und SKAZ springt zum Zitat in der Quelle.</td>
</tr>
<tr>
<td width="50%"><img src="../images/tour-edit.webp" alt="Ein Agent fragt, bevor er eine Wiki-Seite ändert"><br><b>Agenten fragen zuerst</b><br>Ein Agent ändert das Wiki nur über SKAZ, und du siehst die Änderung, bevor sie passiert: Allow oder Deny.</td>
<td width="50%"><img src="../images/tour-cards.webp" alt="Karteikarten und ein Test aus einer Vorlesung"><br><b>Karteikarten und Tests</b><br>Bitte um Karten oder einen Test zu einer Vorlesung. Jede Antwort ist durch ein geprüftes Zitat belegt; Karten kommen mit verteilter Wiederholung zurück.</td>
</tr>
<tr>
<td width="50%"><img src="../images/tour-web.webp" alt="Eine Websuche erlauben und eine gefundene Seite in die Bibliothek aufnehmen"><br><b>Websuche, mit deinem OK</b><br>Du siehst die genaue Anfrage, bevor sie gesendet wird. Eine gefundene Seite kommt mit einem Klick in die Bibliothek.</td>
<td width="50%"><img src="../images/tour-diagram.webp" alt="Ein Diagramm in einer Antwort, in voller Größe geöffnet"><br><b>Diagramme</b><br>Antworten können ein Diagramm zeichnen, gerendert auf deinem Mac. Öffne es in voller Größe und zoome hinein.</td>
</tr>
<tr>
<td width="50%"><img src="../images/tour-wiki.webp" alt="Eine Begriffsseite im Wiki und ihre Verbindungen"><br><b>Ein Wiki, das sich selbst schreibt</b><br>Begriffsseiten aus all deinen Quellen, miteinander verbunden und gekennzeichnet: was zitiert ist und was der Agent gefolgert hat.</td>
<td width="50%"><img src="../images/tour-theme.webp" alt="Wechsel zum dunklen Design"><br><b>Hell und dunkel</b><br>Folgt deinem Mac, oder wähle ein Design unter <b>Settings → Appearance</b>.</td>
</tr>
</table>

<sub>Erstellt aus der eigenen Oberfläche von SKAZ 0.3.1 (ihrem HTML und CSS) mit <a href="https://github.com/heygen-com/hyperframes">HyperFrames</a>.
Vorlesung, Folien, Antworten, Karten und Web-Ergebnisse sind vorbereitete Demodaten, keine echte
Spracherkennung, keine echten KI-Ausgaben und keine echte Suche.</sub>

## ✨ Funktionen

| | |
|---|---|
| 🎙️ **Live-Aufnahme** | Mikrofon, auf Wunsch zusammen mit dem Ton des Macs (Zoom, Videos; macOS 14.2+ und Systemberechtigung nötig). Erkennung mit **Soniox** (Cloud-Streaming, Sprechertrennung, Übersetzung) oder **Whisper auf diesem Computer** (funktioniert offline). SKAZ wechselt den Dienst nie stillschweigend. |
| 📚 **Jede Quelle** | PDF, Dokumente, Text- und Markdown-Dateien, Audio- und Videodateien, Webartikel (bereinigt), eingefügter Text beliebiger Länge und Videolinks von YouTube, VK Video, RuTube und Vimeo. Verwende nur Material, das du verarbeiten darfst. |
| 🧠 **Ein lebendiges Wiki** | Notizen zu jeder Quelle, eine Seite pro Begriff über alle Ordner hinweg und gespeicherte Analysen. Jede Aussage ist gekennzeichnet: Zitat aus einer Quelle, vom Agenten gefolgerte Verbindung oder Erklärung des Agenten. Widersprechen sich Quellen, werden beide Fassungen gezeigt, und du entscheidest. |
| 💬 **Chats mit Fußnoten** | Frag zur ganzen Bibliothek; der Agent weiß, was geöffnet ist und ob gerade aufgenommen wird. Fußnoten öffnen die genaue Stelle einer Aufnahme oder die Seite eines Dokuments. Mit **@** verweist du auf eine Seite, ein Material oder einen Chat. Antworten können Diagramme mit einer Vollbildansicht enthalten. |
| 🃏 **Karteikarten und Tests** | Bitte um Karteikarten oder einen Test zu einer Seite, einem Material oder einem Chat. Jede richtige Antwort ist durch ein geprüftes Zitat belegt. Karten werden mit FSRS-Wiederholung gelernt; Stapel und Tests lassen sich im Wiki speichern. |
| 🌐 **Websuche, mit deinem OK** | Bevor etwas deinen Mac verlässt, siehst du die genaue Anfrage und wählst Allow once, Allow in this chat oder Deny. Gesendet wird nur die Anfrage. Eine gefundene Seite lässt sich mit einem Klick in die Bibliothek aufnehmen. |
| 🤖 **Dein Agent** | **Codex**, **Claude Code**, **Hermes Agent** oder **OpenCode**, mit deinem eigenen Abo oder Schlüssel; SKAZ kann sie für dich installieren. Agenten lesen die Bibliothek über SKAZ-Werkzeuge und ändern Wiki-Seiten nur, wenn du es erlaubst, mit Undo; deine eigenen Notizen bleiben unberührt. Wähle ein Modell pro Chat und markiere Favoriten mit einem Stern. Kleine Ablageentscheidungen können ein lokales Modell oder OpenRouter übernehmen. |
| ✍️ **Erkennungskorrekturen** | Eine optionale Prüfung findet wahrscheinliche Erkennungsfehler, korrigiert die sicheren und markiert die zweifelhaften nur. Jede Korrektur lässt sich rückgängig machen. |
| 🗂️ **Normale Dateien** | Die Bibliothek ist ein Ordner mit `.md`-Dateien. Öffne ihn in **Obsidian** oder exportiere alles als Markdown mit Quellen als Fußnoten. Deine eigenen Änderungen an Wiki-Seiten sind vor dem Agenten geschützt. |
| 🔄 **Updates** | SKAZ prüft GitHub-Releases beim Start und einmal am Tag und installiert ein geprüftes Update über **Settings → About**. |

## 📦 Installation

Füge das ins Terminal ein (Apple Silicon, macOS 13 oder neuer):

```bash
curl -fsSL https://raw.githubusercontent.com/all0b0y/SKAZ/main/install.sh | bash
```

Das [Skript](../../install.sh) lädt das neueste Release, prüft die SHA-256-Prüfsumme und die
Signatur von SKAZ, installiert SKAZ in „Programme" und öffnet es. Zum Aktualisieren denselben
Befehl erneut ausführen – Bibliothek und Einstellungen bleiben erhalten. SKAZ ist noch nicht von
Apple notarisiert; so installiert öffnet sich die App ohne die Warnung „Apple konnte nicht
überprüfen …".

<details>
<summary><b>Stattdessen per DMG oder PKG installieren</b></summary>
<br>

Lade `SKAZ-<version>-arm64.dmg` (oder das `.pkg`-Installationsprogramm) von
[GitHub Releases](https://github.com/all0b0y/SKAZ/releases/latest), öffne es und ziehe SKAZ in
„Programme". Beim ersten Start meldet macOS, dass SKAZ nicht überprüft werden konnte: Klicke auf
**Fertig**, nicht auf „In den Papierkorb legen". Öffne dann **Systemeinstellungen → Datenschutz &
Sicherheit** und klicke neben der Meldung zu SKAZ auf **Dennoch öffnen**. Das ist einmal pro
heruntergeladenem Build nötig. Schalte die Schutzfunktionen von macOS nicht global ab.

</details>

Lieber den aktuellen Code ausführen? Siehe [Entwicklungs-Setup](../../CONTRIBUTING.md).

### 🚀 Erster Start

1. **Agent.** Wähle Codex, Claude Code, Hermes Agent oder OpenCode und melde dich mit deinem eigenen Konto
   an. SKAZ kann den Agenten für dich installieren. Es gelten Bedingungen, Limits und Kosten des
   Anbieters.
2. **Sprache.** Füge einen Soniox-Schlüssel hinzu und erlaube das Senden von Audio an Soniox –
   oder wähle **Whisper on this computer** und lade ein Sprachmodell (die Größe wird vorher
   angezeigt; kein Schlüssel nötig).
3. **Bibliothek.** Wähle, wo sie liegt; SKAZ schlägt einen Ordner in „Dokumente" vor.
4. **Loslegen.** Drücke **Record** (der Ordner wird daneben gewählt) oder **+ Material**, um
   eine Datei, einen Link oder Text hinzuzufügen. Frag im Chat; öffne **Wiki**, um zu lesen, was
   SKAZ aufgebaut hat.

Alles lässt sich später unter **Settings** ändern.

> [!IMPORTANT]
> Hol die Zustimmung ein, bevor du andere Menschen aufnimmst. Soniox, die Agenten und OpenRouter
> haben eigene Preise und Richtlinien; die MIT-Lizenz deckt deren Nutzung nicht ab.

## 🔒 Datenschutz und Daten

| Was | Wo es liegt / wohin es geht |
|---|---|
| Materialien und Wiki | Normale `.md`-Dateien im gewählten Bibliotheksordner. |
| Index, Chats, Einstellungen | Lokale Dateien im eigenen App-Ordner von SKAZ. |
| Live-Audio | Wird nicht als Archiv zum Abspielen aufbewahrt. Temporäres Audio kann zur Verarbeitung oder Wiederherstellung genutzt werden. |
| Spracherkennung | **Soniox:** Audio wird nach deiner Zustimmung gesendet, die du jederzeit zurücknehmen kannst. **Whisper auf diesem Computer:** Audio verlässt deinen Mac nie. |
| Agent | Deine Frage und die gelesenen Teile der Bibliothek gehen an den gewählten Agenten; dessen Aufbewahrungs- und Trainingsrichtlinien gelten. |
| Websuche | Nur eine von dir erlaubte Anfrage, an die Suche des auf der Karte genannten Agenten – ohne Chatverlauf und ohne Text aus der Bibliothek. Eine gefundene Seite hinzuzufügen ist eine einzige Anfrage an diese Adresse. |
| Schlüssel | Eine verschlüsselte lokale Datei im App-Ordner von SKAZ, der Schlüssel liegt daneben. Die Dateiberechtigungen sind die Hauptgrenze – kein Schutz vor Prozessen, die unter deinem Benutzer laufen. |
| Aktivitätsprotokoll | Ohne Gesprächstext und Schlüssel. |
| Backend | Python, nur Loopback, bei jedem Start mit neuem Token. |

Text aus deinen Quellen ist Daten, nie eine Anweisung: Eine Passage, die sich an eine KI richtet,
bleibt außerhalb des Wikis, und SKAZ sagt dir Bescheid – mit der Möglichkeit, sie zurückzuholen.
**Lokale Speicherung heißt nicht Offline-Verarbeitung.** Schütze auch Exporte und Backups.
Einschränkungen und Meldeweg stehen in der [Sicherheitsrichtlinie](../../SECURITY.md).

## 🧩 Aufbau

```text
Mikrofon / Systemton / Dateien / Links → Electron → Python ── Soniox | Whisper auf diesem Mac
                                           ↓          ↓
                                       React UI   Bibliothek: Materials/*.md, Wiki/*.md
                                                      ↕  SKAZ-Werkzeuge (Änderungen nur mit deinem OK)
                                           Codex | Claude Code | Hermes Agent | OpenCode
```

| Schicht | Technik |
|---|---|
| Desktop | Electron |
| Oberfläche | React, TypeScript, CodeMirror |
| Lokales Backend | Python, FastAPI, ein SQLite-Index über den Markdown-Dateien |

## 🗺️ Wie es weitergeht

- [ ] Notarisierung der Releases durch Apple
- [ ] Bebilderte Antworten und Notizen aus PDF-Präsentationen
- [ ] Breitere Erprobung im Alltag

## 🤝 Mitmachen

[Contributing](../../CONTRIBUTING.md) beschreibt Setup, Tests und Pull Requests;
[Packaging](../PACKAGING.md) den Bau der Installationsprogramme. Kleine Korrekturen können direkt
als PR kommen – größere Änderungen bitte zuerst in einem Issue besprechen. Release Notes stehen in
[GitHub Releases](https://github.com/all0b0y/SKAZ/releases).

[Community-Regeln](../../CODE_OF_CONDUCT.md) · [Sicherheitsrichtlinie](../../SECURITY.md) · [MIT-Lizenz](../../LICENSE)

---

<div align="center">
<sub><i>Skaz</i> (сказ) ist ein russisches Wort für eine mündliche Erzählung. Früher AudioHelper.<br>
Copyright © 2026 all0b0y.</sub>
</div>
