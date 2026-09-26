<div align="center">

<img src="../../icon/icon.png" alt="SKAZ" width="120" height="120">

# SKAZ

![macOS Apple Silicon](https://img.shields.io/badge/macOS-Apple_Silicon-111111)
![Alpha](https://img.shields.io/badge/status-alpha-orange)
[![MIT](https://img.shields.io/badge/license-MIT-blue)](../../LICENSE)

[English](../../README.md) · [Русский](README.ru.md) · **Español** · [Deutsch](README.de.md) · [简体中文](README.zh-CN.md)

</div>

**Un segundo par de oídos para clases y reuniones.**

SKAZ es una aplicación de escritorio para macOS que convierte la voz en una
transcripción legible, te ayuda a recuperar el hilo y reúne preguntas y notas junto a sus fuentes.

> **Alpha / acceso anticipado.** Puede haber errores y cambios incompatibles, incluso
> en el formato de los datos. Guarda copias de las exportaciones importantes. La plataforma
> actual es macOS con Apple Silicon; Windows, Linux y los Mac Intel no están verificados.
> La interfaz está disponible únicamente en inglés.

## Así se ve

![Transcripción y asistente de SKAZ](../images/transcript.png)
*Texto agrupado por hablante, con una pregunta, una respuesta y un enlace a su fuente.*

![Editor de notas de SKAZ](../images/notes.png)
*Notas Markdown editables junto al chat de la sesión.*

Son capturas de la aplicación en ejecución, no maquetas. La transcripción, la respuesta
y las notas se escribieron para esta demostración: no son resultados de reconocimiento
de voz ni de IA. El perfil de demostración no tiene claves API, por lo que muestra un
aviso de configuración para grabar.

## Para qué sirve

¿Has perdido el hilo? Pregunta qué te has perdido en lugar de revisar toda una grabación.
Lee la transcripción, sigue las referencias de las respuestas y guarda lo útil como notas.
La IA puede equivocarse: los enlaces ayudan a comprobar una respuesta, pero no garantizan su exactitud.

## Funciones

- **Transcripción y traducción en directo:** reconocimiento con Soniox, texto agrupado
  por hablante y acceso al original al usar la traducción.
- **Micrófono y audio del sistema:** selecciona un micrófono y, si quieres, incluye
  el sonido del Mac. El audio del sistema requiere macOS 14.2+ y permiso del sistema.
- **Preguntas con contexto:** consulta una sesión o un ámbito más amplio de la biblioteca;
  las referencias con marcas de tiempo te llevan a la transcripción.
- **Notas editables:** genera notas, edita Markdown en pestañas y expórtalo.
- **Biblioteca local:** organiza sesiones en grupos y guarda opcionalmente una copia
  de los textos en una carpeta para herramientas como Obsidian.
- **Importación de medios (experimental):** audio y vídeo locales y contenido de YouTube.
  Procesa solo material que tengas autorización para usar; la disponibilidad y los formatos varían.
- **Modelos independientes:** configura Assistant y Notes por separado mediante una
  cuenta Codex o perfiles API de OpenAI, Anthropic y OpenRouter. Soniox se encarga de la voz en directo.

## Instalación y primer inicio

**El canal previsto de descarga es [GitHub Releases](https://github.com/4IPE/SKAZ/releases).**
Todavía no hay versiones publicadas ni instaladores disponibles allí. Para probar
el código actual, consulta la [configuración de desarrollo](../../CONTRIBUTING.md).

Cuando se publique un DMG para macOS con Apple Silicon, ábrelo, arrastra SKAZ a
Applications e inicia la aplicación. Sigue las notas de instalación y firma de esa
versión. No presupongas que las versiones alpha están notarizadas; no desactives
globalmente las protecciones de macOS.

En el primer inicio:

1. Elige los idiomas que esperas escuchar.
2. Abre **Settings → API keys**, añade tu clave Soniox, autoriza el procesamiento en la nube y guarda.
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
- Con tu consentimiento, el audio se envía a Soniox. Assistant y Notes envían contexto
  al servicio seleccionado. Se aplican sus políticas de conservación y entrenamiento:
  **almacenamiento local no significa procesamiento sin conexión**.
- Las claves API se guardan en un archivo cifrado, junto a su clave de cifrado. La
  protección principal son los permisos de archivo, no una barrera frente a procesos
  ejecutados como tu usuario. Protege también las exportaciones y copias de seguridad.
- El backend Python solo escucha en loopback y utiliza un token nuevo en cada inicio.
  Consulta [Security](../../SECURITY.md) para conocer los límites y el estado del canal de avisos.

## Cómo funciona

```text
Micrófono / audio del sistema / medios → Electron → Python → Soniox
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
[GitHub Releases](https://github.com/4IPE/SKAZ/releases), sin un changelog separado.
Los arreglos pequeños pueden enviarse directamente; los cambios grandes se discuten primero.

Las prioridades incluyen la firma y notarización de versiones, la recuperación fiable
de sesiones largas y la validación en situaciones reales. La importación y la búsqueda
web experimentales no implican disponibilidad para producción; la búsqueda web nativa de Codex está desactivada.

[Normas de convivencia](../../CODE_OF_CONDUCT.md) · [Seguridad](../../SECURITY.md) · [Licencia MIT](../../LICENSE)

*Skaz* (сказ) es una palabra rusa que designa una narración oral.
El nombre de trabajo original era AudioHelper. Copyright © 2026 all0b0y.
