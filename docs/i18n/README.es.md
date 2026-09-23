<div align="center">

<img src="../../icon/icon.png" alt="SKAZ" width="120" height="120">

# SKAZ

**Un segundo par de oídos para clases y reuniones.**

SKAZ escucha contigo, transcribe en directo, traduce al vuelo,<br>
responde preguntas sobre lo que se acaba de decir y toma notas — cada respuesta respaldada por la propia grabación.

[![macOS](https://img.shields.io/badge/macOS-Apple%20Silicon-111111?logo=apple&logoColor=white)](#primeros-pasos)
[![Electron](https://img.shields.io/badge/Electron-React%20%2B%20TypeScript-47848F?logo=electron&logoColor=white)](#cómo-funciona)
[![Python](https://img.shields.io/badge/backend-Python%203.11%2B-3776AB?logo=python&logoColor=white)](#cómo-funciona)
[![Status](https://img.shields.io/badge/status-early%20development-orange)](#estado-del-proyecto)

[English](../../README.md) &nbsp;·&nbsp;
[Русский](README.ru.md) &nbsp;·&nbsp;
**Español** &nbsp;·&nbsp;
[Deutsch](README.de.md) &nbsp;·&nbsp;
[简体中文](README.zh-CN.md)

</div>

---

## Por qué SKAZ

Te distraes dos minutos en clase y el ponente ya está en otro tema. En una reunión
alguien dice tu nombre y no sabes cuál era la pregunta. Grabarlo todo y verlo después
no ayuda *ahora*.

SKAZ está hecho para ese momento. Funciona en tu Mac junto a la conversación y guarda
un registro con marcas de tiempo y búsqueda de lo que se dijo, para que puedas
preguntar **«¿qué me acabo de perder?»** y obtener la respuesta en segundos, con
enlaces a las palabras exactas.

La regla que SKAZ nunca rompe: **no inventa lo que no se dijo.** Si la grabación no
contiene la respuesta, te lo dice, y lo que el modelo aporta de conocimiento general
se mantiene separado de lo que realmente dijeron los participantes.

## Funciones

**🎙️ Transcripción en directo**
Reconocimiento de voz en streaming desde el micrófono que elijas. El habla se agrupa
en monólogos por hablante (A → B → A), así que se lee como una conversación.

**🌍 Traducción en directo**
Elige los idiomas previstos y la traducción aparece junto al habla mientras ocurre.
El original está siempre a un clic.

**💬 Pregunta sobre la grabación**
Durante la sesión o después: *«¿Qué me perdí?»*, *«¿Cómo se definió X?»*, *«¿Qué se
decidió sobre el presupuesto?»*. Busca en una sesión, en un grupo o en toda la
biblioteca. Las respuestas citan sus fuentes con notas que llevan a la transcripción.

**📝 Notas fieles a la fuente**
Genera notas estructuradas a partir de la transcripción. Cada punto está ligado al
fragmento de habla del que procede, y SKAZ avisa cuando unas notas se quedan atrás.
Edítalas en un editor Markdown con pestañas al estilo de Obsidian.

**📂 Tu biblioteca, en archivos normales**
Organiza las sesiones en grupos y refléjalas en la carpeta que quieras como Markdown
legible — para Obsidian, git o la búsqueda de Finder.

**📥 Importa grabaciones**
Añade un archivo de audio existente y obtén la misma transcripción, preguntas y notas
que en una sesión en directo.

**🧩 Usa tus propios modelos**
Elige el modelo para cada tarea por separado: transcripción, asistente, notas y
búsqueda. Proveedores compatibles: Soniox (voz), OpenRouter, OpenAI y Anthropic. Sin
sustituciones silenciosas: si un modelo no sirve para la tarea, SKAZ lo indica.

## Privacidad desde el diseño

- **Sin archivo de audio.** El audio se envía al reconocimiento y se descarta; SKAZ
  guarda el texto, no la grabación.
- **Todo en local.** Transcripciones, notas y chats se quedan en tu Mac. El texto solo
  sale hacia el proveedor que tú hayas configurado.
- **Claves en el dispositivo.** Las claves de API se guardan cifradas en la carpeta de
  datos de la app, con permisos solo para el propietario.
- **Backend cerrado.** El backend en Python solo escucha en loopback y exige un token
  aleatorio nuevo en cada arranque.
- **La voz son datos, no órdenes.** Lo que se oye en la sala nunca se trata como una
  instrucción para el asistente.

## Cómo funciona

```
 Micrófono ──► Electron main ──► Backend Python ──► Reconocimiento de voz (Soniox)
                    │                  │
                    │                  ├──► SQLite + biblioteca Markdown
                    ▼                  └──► Modelos de lenguaje (asistente, notas)
             Interfaz React
```

| Capa | Tecnología | Responsabilidad |
|---|---|---|
| Aplicación de escritorio | Electron | Ventana, permisos de micrófono, IPC seguro, ciclo de vida del backend |
| Interfaz | React + TypeScript, Zustand, CodeMirror 6 | Grabación, transcripción, asistente, notas, ajustes |
| Backend | Python 3.11+, FastAPI, SQLite | Audio en streaming, reconocimiento, biblioteca, asistente, notas |

## Primeros pasos

> SKAZ está en una fase temprana y se dirige a **macOS con Apple Silicon**. Otras
> plataformas no se han probado.

**Requisitos:** Node.js 20.19+, Python 3.11+, [uv](https://docs.astral.sh/uv/) y una
clave de API de al menos un proveedor compatible.

```bash
# 1. Instalar dependencias
npm install
uv sync --project backend

# 2. Ejecutar la app en modo desarrollo
npm run dev
```

En el primer arranque abre **Settings → API keys**, añade tus claves, elige los
idiomas que hablas y pulsa **Record**.

### Comandos útiles

| Comando | Qué hace |
|---|---|
| `npm run dev` | Inicia la app con recarga en caliente |
| `npm test` | Tests unitarios del frontend (Vitest) |
| `npm run typecheck` | Comprobación de tipos de TypeScript |
| `uv run --project backend pytest` | Tests del backend |
| `npm run dist:mac` | Genera `SKAZ.app` y un instalador DMG — ver [Packaging](../PACKAGING.md) |

## Estado del proyecto

SKAZ es un prototipo funcional en desarrollo activo. La transcripción en directo, la
traducción, el asistente, las notas, los grupos de sesiones y la importación ya
funcionan en local. Pendiente:

- [ ] Versiones firmadas y notarizadas
- [ ] Un asistente que recorra la biblioteca paso a paso
- [ ] Edición manual de hablantes
- [ ] Manejo robusto de suspensión, cierre y pérdida de red en sesiones largas

Hasta la primera versión puede haber asperezas y cambios incompatibles.

## El nombre

*Skaz* (сказ) es una palabra rusa para un relato oral, contado con la voz de quien lo
narra. El repositorio conserva su nombre de trabajo original, `AudioHelper`.
