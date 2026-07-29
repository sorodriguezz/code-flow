<div align="center">

<img src="src-tauri/icons/128x128@2x.png" width="88" alt="CodeFlow" />

# CodeFlow

### Tu cliente de Git de escritorio, con la IA que tú elijas.

Gestiona repositorios, revisa pull requests y deja que la IA escriba tus commits,
encuentre errores y resuelva conflictos — todo en una app rápida y nativa.
**Y decides qué modelo hace cada cosa.**

![version](https://img.shields.io/badge/versión-1.7.4-6C5CE7)
![platform](https://img.shields.io/badge/plataforma-Windows%20%7C%20macOS-2D3436)
![proveedores](https://img.shields.io/badge/IA-Claude%20%7C%20Gemini%20%7C%20Open%20Code%20%7C%20Ollama-00B894)
![idiomas](https://img.shields.io/badge/idiomas-ES%20%7C%20EN-0984E3)

</div>

---

CodeFlow reúne en un mismo lugar lo que normalmente está repartido entre tu cliente de
Git, la web de GitHub/Azure DevOps y una terminal aparte. Ves tu historial, preparas y
confirmas cambios, abres y revisas pull requests, y tienes un asistente de IA que
entiende tu repositorio y trabaja contigo.

**Lo que no vas a encontrar en otro cliente:** no te casa con un proveedor de IA. Usa
varios a la vez y asigna cada tarea al modelo que mejor le va — incluido uno **local**,
si tu código no puede salir de tu máquina.

## ✨ Un vistazo

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/graph.png" alt="Grafo de commits" /></td>
    <td width="50%"><img src="docs/screenshots/changes.png" alt="Cambios y diff" /></td>
  </tr>
  <tr>
    <td align="center"><b>Grafo de commits</b> — historial y ramas de un vistazo</td>
    <td align="center"><b>Cambios</b> — diff unificado o en paralelo</td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/ai-settings.png" alt="Asistente de IA" /></td>
    <td width="50%"><img src="docs/screenshots/pr-review.png" alt="Revisión con IA" /></td>
  </tr>
  <tr>
    <td align="center"><b>Asistente de IA</b> — proveedores y modelo por tarea</td>
    <td align="center"><b>Revisión con IA</b> — hallazgos claros y accionables</td>
  </tr>
</table>

## 🧠 La IA, a tu manera

Elige entre cuatro motores. CodeFlow **detecta cuáles tienes instalados** y te dice qué
falta, en vez de dejarte adivinar por qué algo no funciona.

| Proveedor | Cómo funciona | Ideal para |
|---|---|---|
| **Claude Code** | CLI, con herramientas | Revisiones a fondo y aplicar correcciones |
| **Gemini** | CLI (Antigravity), con herramientas | Alternativa potente con cuenta de Google |
| **Open Code** | CLI, cualquier modelo que configures | Mezclar proveedores a tu gusto |
| **Ollama** | 🔒 **Local**, sin nube | Privacidad total, sin conexión y sin coste |

*Codex y DeepSeek, en camino.*

### Un motor distinto para cada tarea

Aquí está la diferencia: no eliges «una IA» — eliges **quién hace qué**.

| Tarea | Por ejemplo… |
|---|---|
| Mensaje de commit | Un modelo local: instantáneo, gratis y sin salir de tu equipo |
| Análisis pre-commit | Uno rápido, que corre en cada cambio |
| Revisión de pull request | El más potente que tengas — aquí sí compensa |
| Descripción de PR | El que mejor redacte |
| Corregir hallazgos | Uno con acceso a herramientas, que edita los archivos |
| Resolución de conflictos | El que prefieras, incluso local |

Lo que dejes en **«heredar»** usa tu proveedor por defecto, así que puedes ignorar la
tabla entera si te vale uno para todo. Y desde el propio chat cambias de modelo **en dos
clics**, sin pasar por Ajustes.

### Lo que hace por ti

- **Chatea con tu repo** — lee archivos, busca en el código y consulta el estado de Git para responderte.
- **Mensajes de commit** redactados desde tus cambios preparados.
- **Análisis pre-commit** — busca bugs y vulnerabilidades antes de confirmar, con un *quality gate* de fiabilidad, seguridad y mantenibilidad.
- **Corrige hallazgos con un clic** — la IA aplica el arreglo en tu árbol de trabajo.
- **Resuelve conflictos** — propuesta editable, con diff contra el archivo original, que no toca nada hasta que aceptas.
- **Crea pull requests** con título y descripción generados desde el diff.
- **Plantillas personalizables** para las cinco acciones, compartidas entre proveedores.

> 🔒 **¿Tu código no puede salir de la empresa?** Pon Ollama como proveedor y todo lo
> anterior corre en tu máquina, sin conexión y sin coste por token.
> *(Las funciones que editan archivos —corregir hallazgos, MCP— necesitan un CLI con
> herramientas; la app te lo indica y oculta lo que no aplica.)*

## 🌳 Git, de forma visual

- **Grafo de commits** con ramas, para leer el historial de un vistazo.
- **Prepara, confirma y descarta** cambios; diff **unificado o en paralelo**, seleccionable para copiar.
- **Ramas, remotos y stashes** a mano, con **deshacer commit** cuando te equivocas.
- **Fetch automático** en segundo plano: siempre sabes cuántos commits llevas de adelanto o atraso.
- **Clona repositorios**, abre varios proyectos y agrúpalos en **espacios de trabajo**.
- **Terminal integrada** (varias pestañas y paneles) y **editor de código** con vista previa de Markdown y diagramas.

## 🔀 Pull requests, sin salir de la app

- Conecta **GitHub** y **Azure DevOps** — ambos a la vez, si hace falta.
- **Revisa un PR pegando solo su enlace** (⇧⌘L): CodeFlow averigua a cuál de tus repos pertenece
  — aunque esté en otro workspace — y lanza la revisión.
- ¿El repo no está en tu máquina? **Revísalo igual, sin clonar**: el diff se lee de la API del host.
  Es una revisión más superficial (el modelo no ve el resto del código), así que también puedes
  clonarlo de un clic para la revisión completa.
- **Lista, revisa y comenta** PRs; **aprueba, pide cambios o ciérralos**.
- **Crea un PR** con título y descripción por IA, también como borrador.
- Publica los comentarios de la **revisión de IA** directamente en el pull request.

## 🔒 Seguridad y privacidad

- **Escaneo de secretos antes de cada commit** — detecta claves de API, tokens y llaves privadas, y te para a tiempo. Reglas deterministas, sin enviar nada a ningún sitio.
- Tus **tokens viven en el llavero del sistema**, nunca en texto plano.
- **Opción 100% local** con Ollama: tu código nunca sale del equipo.
- Es una app de escritorio: sin servidor, sin cuenta, sin telemetría.

## 🎨 Hazlo tuyo

- Temas **claro, oscuro o del sistema**, con color de acento a elegir.
- Interfaz en **español e inglés**.
- **Plantillas de prompt** para commit, análisis, revisión, descripción de PR y conflictos.
- Por espacio de trabajo: **contexto de revisión**, **instrucciones (.md)**, **Skills** y **servidores MCP**.
- **Historial completo** de lo que ha hecho la IA — incluidos los fallos, para que mañana sepas qué pasó.

## ⚙️ Puesta en marcha

**1. Abre tu repositorio**
Pulsa **+** en la barra lateral y elige una carpeta con un repositorio Git. Repite para
añadir todos los que quieras y agrúpalos en espacios de trabajo.

**2. Elige tu asistente de IA**
En **Ajustes › Asistente de IA › Proveedores** verás los cuatro motores con su estado
(*Disponible* / *No encontrado*). Despliega el que quieras usar, comprueba su binario —o
el endpoint, si es Ollama— y elige su modelo. Márcalo como **predeterminado** y listo.

**3. Afina por tarea (opcional)**
En **Modelo por tarea** asigna un motor distinto a cada acción. Todo empieza en
«heredar», así que solo tocas lo que quieras cambiar.

**4. Conecta tu plataforma (opcional)**
En **Ajustes › Alojamiento Git** conecta **GitHub** o **Azure DevOps** para ver y revisar
pull requests. El token se guarda en el llavero de tu sistema operativo.

> 💡 ¿Quieres probarlo sin instalar ningún CLI? Instala [Ollama](https://ollama.com),
> ejecuta `ollama pull qwen2.5-coder` y selecciónalo en Ajustes. Sin cuentas ni claves.

## 💾 Descarga

Disponible para **Windows** y **macOS**. Coge la última versión desde
**[Releases](../../releases)**, ejecuta el instalador y ábrela. La app se
**actualiza sola** cuando hay una versión nueva.

Puede seguir corriendo en segundo plano (icono en la bandeja) para mantener vivas las
terminales y las tareas de IA aunque cierres la ventana.

## 🌐 Idiomas

Español e inglés, cambiables en cualquier momento desde **Ajustes › General**.

---

<div align="center">
<sub>Hecho para quien quiere Git, revisiones e IA en un mismo flujo. 💜</sub>
</div>
