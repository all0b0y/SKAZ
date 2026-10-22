<div align="center">

<img src="../../icon/icon.png" alt="SKAZ" width="128" height="128">

# SKAZ

### Clases, reuniones y documentos convertidos en una wiki a la que puedes preguntar

Graba o añade una fuente · pregunta con citas exactas · una wiki que se mantiene al día sola

[![Release](https://img.shields.io/github/v/release/all0b0y/SKAZ?include_prereleases&label=release&color=2c2e31)](https://github.com/all0b0y/SKAZ/releases/latest)
![macOS Apple Silicon](https://img.shields.io/badge/macOS-Apple_Silicon-111111)
![Alpha](https://img.shields.io/badge/status-alpha-orange)
[![MIT](https://img.shields.io/badge/license-MIT-blue)](../../LICENSE)

[English](../../README.md) · [Русский](README.ru.md) · **Español** · [Deutsch](README.de.md) · [简体中文](README.zh-CN.md)

<br>

<img src="../images/skaz-tour.webp" alt="Recorrido por SKAZ: grabar una clase, preguntar sobre ella con una nota al pie, permitir la edición de un agente, estudiar tarjetas hechas a partir de la clase" width="880">

<sub>Recorrido del producto · perfil de demostración con datos preparados · <a href="../images/skaz-tour.mp4">El recorrido completo en Full HD (MP4, 80 s)</a></sub>

<br><br>

[**Instalación**](#-instalación) · [**Funciones**](#-funciones) · [**Privacidad**](#-privacidad-y-datos) · [**Cómo funciona**](#-cómo-funciona) · [**Contribuir**](../../CONTRIBUTING.md)

</div>

---

SKAZ es una app para macOS para todo lo que escuchas y lees. Graba una clase o una reunión, o
añade un PDF, un artículo, un enlace de vídeo o un archivo. SKAZ guarda cada fuente en tu propia
carpeta de archivos Markdown, construye una wiki a partir de ellas y responde a tus preguntas con
enlaces al momento o la página exactos.

> [!WARNING]
> **Alfa / acceso anticipado.** Habrá errores y cambios incompatibles, también en los datos
> guardados. Haz copias de seguridad de las exportaciones importantes. SKAZ está pensado para macOS
> en Apple Silicon; Windows, Linux y los Mac con Intel no están verificados. Por ahora la interfaz
> solo está en inglés.

## 💡 Por qué SKAZ

Una clase, la reunión de la semana pasada, un capítulo que leíste: acaban en sitios distintos y
nada los conecta. SKAZ los mantiene juntos. Cada fuente recibe sus apuntes y páginas de conceptos
en una sola wiki, así que la misma idea de una clase y de un libro termina en la misma página.
Pregunta *«¿qué dijo sobre la segunda ley?»* y sigue la nota al pie hasta el segundo en que se dijo.

La IA puede equivocarse. Las citas ayudan a comprobar una respuesta; no garantizan que sea correcta.

## 👀 Míralo en acción

<table>
<tr>
<td width="50%"><img src="../images/tour-record.webp" alt="Grabar una clase en una carpeta"><br><b>Graba en una carpeta</b><br>Elige la carpeta, pulsa Record y la transcripción aparece mientras se habla, por hablante y con la hora.</td>
<td width="50%"><img src="../images/tour-ask.webp" alt="Una respuesta con notas al pie"><br><b>Respuestas con citas</b><br>Cada afirmación lleva una nota al pie. Ábrela y SKAZ salta a la cita en la fuente.</td>
</tr>
<tr>
<td width="50%"><img src="../images/tour-edit.webp" alt="Un agente pide permiso antes de editar una página de la wiki"><br><b>Los agentes preguntan primero</b><br>Un agente cambia la wiki solo a través de SKAZ, y ves el cambio antes de que ocurra: Allow o Deny.</td>
<td width="50%"><img src="../images/tour-cards.webp" alt="Tarjetas y un test hechos a partir de una clase"><br><b>Tarjetas y tests</b><br>Pide tarjetas o un test sobre una clase. Cada respuesta se apoya en una cita comprobada; las tarjetas vuelven con repetición espaciada.</td>
</tr>
<tr>
<td width="50%"><img src="../images/tour-web.webp" alt="Aprobar una búsqueda web y añadir una página encontrada a la biblioteca"><br><b>Búsqueda web, con tu permiso</b><br>Ves la consulta exacta antes de enviarla. Una página encontrada entra en la biblioteca con un clic.</td>
<td width="50%"><img src="../images/tour-diagram.webp" alt="Un diagrama en una respuesta, abierto a tamaño completo"><br><b>Diagramas</b><br>Las respuestas pueden dibujar un diagrama, generado en tu Mac. Ábrelo a tamaño completo y amplía.</td>
</tr>
<tr>
<td width="50%"><img src="../images/tour-wiki.webp" alt="Una página de concepto de la wiki y sus conexiones"><br><b>Una wiki que se escribe sola</b><br>Páginas de conceptos de todas tus fuentes, conectadas entre sí, marcadas con lo que es cita y lo que dedujo el agente.</td>
<td width="50%"><img src="../images/tour-theme.webp" alt="Cambiar al tema oscuro"><br><b>Claro y oscuro</b><br>Sigue a tu Mac, o elige un tema en <b>Settings → Appearance</b>.</td>
</tr>
</table>

<sub>Creado a partir de la propia interfaz de SKAZ 0.3.1 (su HTML y CSS) con <a href="https://github.com/heygen-com/hyperframes">HyperFrames</a>.
La clase, las diapositivas, las respuestas, las tarjetas y los resultados web son datos de demostración
preparados, no reconocimiento de voz, resultados de IA ni búsquedas reales.</sub>

## ✨ Funciones

| | |
|---|---|
| 🎙️ **Grabación en vivo** | Micrófono y, si quieres, el sonido del Mac (Zoom, vídeos; requiere macOS 14.2+ y permiso del sistema). Reconocimiento con **Soniox** (en la nube y en streaming, separación de hablantes, traducción) o **Whisper en este ordenador** (funciona sin conexión). SKAZ nunca cambia de servicio sin avisar. |
| 📚 **Cualquier fuente** | PDF, documentos, archivos de texto y Markdown, audio y vídeo, artículos web (limpios), texto pegado de cualquier longitud y enlaces de vídeo de YouTube, VK Video, RuTube y Vimeo. Usa solo material que tengas permiso para procesar. |
| 🧠 **Una wiki viva** | Apuntes de cada fuente, una página por concepto para todas las carpetas y análisis guardados. Cada afirmación está marcada: cita de una fuente, conexión deducida por el agente o explicación del agente. Cuando las fuentes no coinciden, se muestran ambas versiones y decides tú. |
| 💬 **Chats con notas al pie** | Pregunta sobre toda la biblioteca; el agente sabe qué está abierto y si hay una grabación en curso. Las notas abren el momento exacto de una grabación o la página de un documento. Señala una página, un material o un chat con **@**. Las respuestas pueden incluir diagramas con un visor a tamaño completo. |
| 🃏 **Tarjetas y tests** | Pide tarjetas o un test sobre una página, un material o un chat. Cada respuesta correcta se apoya en una cita comprobada. Las tarjetas se repasan con repetición espaciada FSRS; las barajas y los tests se pueden guardar en la wiki. |
| 🌐 **Búsqueda web, con tu permiso** | Antes de que nada salga de tu Mac ves la consulta exacta y eliges Allow once, Allow in this chat o Deny. Solo se envía la consulta. Una página encontrada se puede añadir a la biblioteca con un clic. |
| 🤖 **Tu agente** | **Codex**, **Claude Code**, **Hermes Agent** u **OpenCode**, con tu propia suscripción o clave; SKAZ puede instalarlos por ti. Los agentes leen la biblioteca con herramientas de SKAZ y cambian páginas de la wiki solo cuando lo permites, con Undo; tus propias notas nunca se tocan. Elige un modelo por chat y marca tus favoritos con una estrella. Las pequeñas decisiones de organización pueden ir a un modelo local o a OpenRouter. |
| ✍️ **Corrección del reconocimiento** | Una revisión opcional encuentra posibles errores de reconocimiento, corrige los seguros y solo resalta los dudosos. Toda corrección se puede deshacer. |
| 🗂️ **Archivos normales** | La biblioteca es una carpeta de archivos `.md`. Ábrela en **Obsidian** o exporta todo a Markdown con las fuentes como notas al pie. Tus propias ediciones de la wiki están protegidas frente al agente. |
| 🔄 **Actualizaciones** | SKAZ consulta las versiones de GitHub al iniciar y una vez al día e instala una actualización verificada desde **Settings → About**. |

## 📦 Instalación

Pega esto en Terminal (Apple Silicon, macOS 13 o posterior):

```bash
curl -fsSL https://raw.githubusercontent.com/all0b0y/SKAZ/main/install.sh | bash
```

El [script](../../install.sh) descarga la última versión, comprueba su suma SHA-256 y la firma de
SKAZ, instala SKAZ en Aplicaciones y lo abre. Ejecuta el mismo comando para actualizar: tu
biblioteca y tus ajustes se quedan donde están. SKAZ aún no está notarizado por Apple; la app
instalada así se abre sin el aviso «Apple no ha podido verificar…».

<details>
<summary><b>Instalar desde el DMG o el PKG</b></summary>
<br>

Descarga `SKAZ-<version>-arm64.dmg` (o el instalador `.pkg`) desde
[GitHub Releases](https://github.com/all0b0y/SKAZ/releases/latest), ábrelo y arrastra SKAZ a
Aplicaciones. En el primer arranque macOS dirá que no puede verificar SKAZ: pulsa **OK**, no
«Trasladar a la papelera». Después abre **Ajustes del Sistema → Privacidad y seguridad** y pulsa
**Abrir igualmente** junto al mensaje sobre SKAZ. Hace falta una vez por cada versión descargada.
No desactives las protecciones de macOS de forma global.

</details>

¿Prefieres ejecutar el código actual? Consulta la [configuración de desarrollo](../../CONTRIBUTING.md).

### 🚀 Primer arranque

1. **Agente.** Elige Codex, Claude Code, Hermes Agent u OpenCode e inicia sesión con tu propia cuenta.
   SKAZ puede instalar el agente por ti. Se aplican las condiciones, límites y cargos del proveedor.
2. **Voz.** Añade una clave de Soniox y permite enviar audio a Soniox, o elige **Whisper on this
   computer** y descarga un modelo de voz (se muestra su tamaño antes; no hace falta clave).
3. **Biblioteca.** Elige dónde se guarda; SKAZ sugiere una carpeta en Documentos.
4. **Úsalo.** Pulsa **Record** (la carpeta se elige al lado) o **+ Material** para añadir un
   archivo, un enlace o texto. Pregunta en el chat; abre **Wiki** para leer lo que SKAZ construyó.

Todo se puede cambiar después en **Settings**.

> [!IMPORTANT]
> Pide consentimiento antes de grabar a otras personas. Soniox, los agentes y OpenRouter tienen
> sus propios precios y políticas; la licencia MIT no cubre su uso.

## 🔒 Privacidad y datos

| Qué | Dónde se guarda / adónde va |
|---|---|
| Materiales y wiki | Archivos `.md` normales en la carpeta de biblioteca que elegiste. |
| Índice, chats, ajustes | Archivos locales en la carpeta propia de la app SKAZ. |
| Audio en vivo | No se guarda como archivo para reproducirlo. Puede usarse audio temporal para procesar o recuperar. |
| Reconocimiento de voz | **Soniox:** el audio se envía tras tu consentimiento, que puedes retirar en cualquier momento. **Whisper en este ordenador:** el audio no sale de tu Mac. |
| Agente | Tu pregunta y las partes de la biblioteca que lee van al agente que elegiste; se aplican sus políticas de conservación y entrenamiento. |
| Búsqueda web | Solo una consulta que aprobaste, enviada a la búsqueda del agente indicado en la tarjeta: sin historial del chat ni texto de la biblioteca. Añadir una página encontrada hace una sola petición a esa dirección. |
| Claves | Un archivo local cifrado en la carpeta de la app SKAZ, con su clave de cifrado al lado. Los permisos de archivo son la barrera principal, no una protección frente a procesos que se ejecutan con tu usuario. |
| Registro de actividad | Sin texto de las conversaciones ni claves. |
| Backend | Python, solo loopback, con un token nuevo en cada arranque. |

El texto de tus fuentes son datos, nunca instrucciones: un fragmento dirigido a una IA se excluye
de la wiki y SKAZ te avisa, con la opción de recuperarlo.
**Guardar en local no significa procesar sin conexión.** Protege también exportaciones y copias.
Consulta la [política de seguridad](../../SECURITY.md) para limitaciones y el canal de avisos.

## 🧩 Cómo funciona

```text
Micrófono / audio del sistema / archivos / enlaces → Electron → Python ── Soniox | Whisper en este Mac
                                                      ↓          ↓
                                                  React UI   Biblioteca: Materials/*.md, Wiki/*.md
                                                                 ↕  herramientas de SKAZ (cambios solo con tu permiso)
                                                      Codex | Claude Code | Hermes Agent | OpenCode
```

| Capa | Tecnología |
|---|---|
| Escritorio | Electron |
| Interfaz | React, TypeScript, CodeMirror |
| Backend local | Python, FastAPI, un índice SQLite sobre los archivos Markdown |

## 🗺️ Próximos pasos

- [ ] Notarización de Apple para las versiones
- [ ] Respuestas y apuntes ilustrados a partir de presentaciones PDF
- [ ] Validación más amplia en condiciones reales

## 🤝 Contribuir

[Contributing](../../CONTRIBUTING.md) explica la configuración, las pruebas y los pull requests;
[Packaging](../PACKAGING.md), cómo construir los instaladores. Los arreglos pequeños pueden ir
directamente en un PR; los cambios grandes, coméntalos antes en un issue. Las notas de versión
están en [GitHub Releases](https://github.com/all0b0y/SKAZ/releases).

[Normas de la comunidad](../../CODE_OF_CONDUCT.md) · [Política de seguridad](../../SECURITY.md) · [Licencia MIT](../../LICENSE)

---

<div align="center">
<sub><i>Skaz</i> (сказ) es una palabra rusa para un relato oral. Antes AudioHelper.<br>
Copyright © 2026 all0b0y.</sub>
</div>
