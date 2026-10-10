<div align="center">

<img src="../../icon/icon.png" alt="SKAZ" width="128" height="128">

# SKAZ

**Un segundo par de oídos para clases y reuniones.**

[![Release](https://img.shields.io/github/v/release/all0b0y/SKAZ?include_prereleases&label=release&color=2f7c72)](https://github.com/all0b0y/SKAZ/releases/latest)
![macOS Apple Silicon](https://img.shields.io/badge/macOS-Apple_Silicon-111111)
![Alpha](https://img.shields.io/badge/status-alpha-orange)
[![MIT](https://img.shields.io/badge/license-MIT-blue)](../../LICENSE)

[English](../../README.md) · [Русский](README.ru.md) · **Español** · [Deutsch](README.de.md) · [简体中文](README.zh-CN.md)

<br>

<img src="../images/skaz-demo.webp" alt="Recorrido rápido por SKAZ: transcripción en vivo, respuestas con fuentes, alcance de búsqueda, notas y proveedores de voz" width="880">

<sub>Recorrido rápido · perfil de demostración con datos preparados · <a href="../images/skaz-demo.mp4">Vídeo en Full HD (MP4, 34 s)</a></sub>

</div>

SKAZ es una aplicación de escritorio para macOS que convierte la voz en una
transcripción legible, te ayuda a recuperar el hilo y reúne preguntas y notas junto a sus fuentes.

> **Alpha / acceso anticipado.** Puede haber errores y cambios incompatibles, incluso
> en el formato de los datos. Guarda copias de las exportaciones importantes. La plataforma
> actual es macOS con Apple Silicon; Windows, Linux y los Mac Intel no están verificados.
> La interfaz está disponible únicamente en inglés.

## Así se ve

<table>
<tr>
<td width="50%"><img src="../images/transcript.webp" alt="Transcripción en vivo"><br><b>Transcripción en vivo</b><br>La voz se convierte en texto legible, agrupado por hablante, con el chat de la sesión al lado.</td>
<td width="50%"><img src="../images/sources.webp" alt="Respuestas con fuentes"><br><b>Respuestas con fuentes</b><br>Un enlace a la fuente abre la línea exacta de la transcripción.</td>
</tr>
<tr>
<td width="50%"><img src="../images/scope.webp" alt="Alcance de búsqueda"><br><b>Alcance de búsqueda</b><br>Pregunta sobre una sesión, un grupo o toda la biblioteca.</td>
<td width="50%"><img src="../images/notes.webp" alt="Notas editables"><br><b>Notas editables</b><br>Notas Markdown en pestañas, listas para exportar.</td>
</tr>
<tr>
<td width="50%"><img src="../images/providers.webp" alt="Tú eliges el proveedor"><br><b>Tú eliges el proveedor</b><br>Soniox, OpenAI o Local Whisper en este Mac.</td>
<td width="50%"><img src="../images/light.webp" alt="Claro y oscuro"><br><b>Claro y oscuro</b><br>Sigue a tu Mac, o elige un tema.</td>
</tr>
</table>

Son capturas de la aplicación en ejecución, no maquetas. Las transcripciones, respuestas y
notas son datos de demostración preparados a mano, no resultados reales de reconocimiento de
voz ni de IA; el recorrido de arriba se montó con estas mismas capturas usando
[Remotion](https://www.remotion.dev).

## Para qué sirve

¿Has perdido el hilo? Pregunta qué te has perdido en lugar de revisar toda una grabación.
Lee la transcripción, sigue las referencias de las respuestas y guarda lo útil como notas.
La IA puede equivocarse: los enlaces ayudan a comprobar una respuesta, pero no garantizan su exactitud.

## Funciones

- **Transcripción y traducción en directo:** el proveedor se elige en
  **Settings → Transcription**: Soniox (streaming en la nube, separación completa de
  hablantes, traducción), **Local Whisper** (faster-whisper en este Mac, funciona sin red;
  hablantes aproximados, traducción solo al inglés) u OpenAI. Texto agrupado por hablante
  y acceso al original al traducir. Nunca se cambia de proveedor en silencio.
- **Micrófono y audio del sistema:** selecciona un micrófono y, si quieres, incluye
  el sonido del Mac. El audio del sistema requiere macOS 14.2+ y permiso del sistema.
- **Preguntas con contexto:** consulta una sesión, un grupo o toda la biblioteca;
  las referencias con marcas de tiempo te llevan a la transcripción.
- **Notas editables:** genera notas, edita Markdown en pestañas y expórtalo.
- **Biblioteca local:** organiza sesiones en grupos y guarda opcionalmente una copia
  de los textos en una carpeta para herramientas como Obsidian.
- **Importación de medios (experimental):** audio y vídeo locales y contenido de YouTube.
  Procesa solo material que tengas autorización para usar; la disponibilidad y los formatos varían.
- **Modelos independientes:** configura Assistant y Notes por separado mediante una
  cuenta Codex o perfiles API de OpenAI, Anthropic y OpenRouter. El proveedor de transcripción se encarga de la voz en directo.

## Instalación y primer inicio

Descarga el DMG más reciente desde [GitHub Releases](https://github.com/all0b0y/SKAZ/releases/latest)
(Apple Silicon, macOS 13 o posterior), ábrelo, arrastra SKAZ a Applications e iníciala.
Las versiones alpha aún no están notarizadas: en el primer inicio sigue los pasos de las
notas de la versión (**Privacy & Security → Open Anyway**). No desactives globalmente las
protecciones de macOS. Para ejecutar el código actual, consulta la [configuración de desarrollo](../../CONTRIBUTING.md).

En el primer inicio:

1. Elige los idiomas que esperas escuchar.
2. Abre **Settings → API keys**, añade tu clave Soniox, autoriza el procesamiento en la nube y guarda —
   o, para que el audio no salga del Mac, elige **Local Whisper** en **Settings → Transcription**
   y descarga un modelo (el tamaño se muestra antes; sin clave ni consentimiento de nube).
3. En **Settings → Transcription**, elige transcripción o traducción y el idioma de destino.
4. Configura **Assistant** y **Notes** por separado. Para Codex, instala el
   [Codex CLI oficial](https://developers.openai.com/codex/cli/) e inicia sesión desde
   los ajustes Codex de SKAZ; no se instala automáticamente. Como alternativa,
   configura una clave y un modelo de un proveedor API. Se aplican sus requisitos,
   límites y tarifas.
5. Crea una sesión, selecciona las fuentes de audio, concede los permisos de macOS
   correspondientes y pulsa **Record**. Pausa o detén la grabación cuando lo necesites;
   abre **Notes** para trabajar con las notas de la transcripción.

Obtén el consentimiento necesario antes de grabar a otras personas. Soniox y los
servicios de modelos de texto tienen sus propias tarifas; la licencia MIT no incluye su uso.

## Privacidad y datos

- Las transcripciones, notas y chats se guardan localmente. No hay un archivo permanente
  del audio en directo para reproducirlo; puede usarse audio temporal para procesamiento o recuperación.
- Con Soniox u OpenAI, el audio se envía a ese proveedor tras tu consentimiento; con Local
  Whisper se reconoce en este Mac y nunca se envía. Assistant y Notes envían contexto
  al servicio seleccionado. Se aplican sus políticas de conservación y entrenamiento:
  **almacenamiento local no significa procesamiento sin conexión**.
- Las claves API se guardan en un archivo cifrado, junto a su clave de cifrado. La
  protección principal son los permisos de archivo, no una barrera frente a procesos
  ejecutados como tu usuario. Protege también las exportaciones y copias de seguridad.
- El backend Python solo escucha en loopback y utiliza un token nuevo en cada inicio.
  Consulta [Security](../../SECURITY.md) para conocer los límites y el estado del canal de avisos.

## Cómo funciona

```text
Micrófono / audio del sistema / medios → Electron → Python → Soniox | Local Whisper | OpenAI
                                           ↓         ↓
                                       React UI   Biblioteca local
                                                     ↕
                                          Proveedor Assistant / Notes
```

| Capa | Tecnología |
|---|---|
| Escritorio | Electron |
| Interfaz | React, TypeScript, CodeMirror |
| Backend local | Python, FastAPI, SQLite |

## Desarrollo y estado del proyecto

[Contributing](../../CONTRIBUTING.md) explica la configuración, las pruebas y los PR;
[Packaging](../PACKAGING.md), la creación de instaladores. El historial de cambios estará en
[GitHub Releases](https://github.com/all0b0y/SKAZ/releases), sin un changelog separado.
Los arreglos pequeños pueden enviarse directamente; los cambios grandes se discuten primero.

Las prioridades incluyen la firma y notarización de versiones, la recuperación fiable
de sesiones largas y la validación en situaciones reales. La importación y la búsqueda
web experimentales no implican disponibilidad para producción; la búsqueda web nativa de Codex está desactivada.

[Normas de convivencia](../../CODE_OF_CONDUCT.md) · [Seguridad](../../SECURITY.md) · [Licencia MIT](../../LICENSE)

*Skaz* (сказ) es una palabra rusa que designa una narración oral.
El nombre de trabajo original era SKAZ. Copyright © 2026 all0b0y.
