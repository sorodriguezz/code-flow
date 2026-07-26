<div align="center">

<img src="src-tauri/icons/128x128@2x.png" width="88" alt="CodeFlow" />

# CodeFlow

### Tu cliente de Git de escritorio, con IA integrada.

Gestiona tus repositorios, revisa pull requests y deja que la IA te ayude a
escribir commits, encontrar errores y resolver conflictos — todo en una sola app,
rápida y nativa.

![version](https://img.shields.io/badge/versión-1.0.1-6C5CE7)
![platform](https://img.shields.io/badge/plataforma-Windows%20%7C%20macOS-2D3436)
![idiomas](https://img.shields.io/badge/idiomas-ES%20%7C%20EN-00B894)

</div>

---

CodeFlow reúne en un mismo lugar lo que normalmente está repartido entre tu cliente
de Git, la web de GitHub/Azure DevOps y una terminal aparte. Ves tu historial, preparas
y confirmas cambios, abres y revisas pull requests, y tienes un asistente de IA —**con
el proveedor que tú elijas**— que entiende tu repositorio y trabaja contigo.

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
    <td align="center"><b>Asistente de IA</b> — elige tu proveedor y modelo</td>
    <td align="center"><b>Revisión con IA</b> — hallazgos claros y accionables</td>
  </tr>
</table>

## 🚀 Qué puedes hacer

### 🌳 Trabaja con Git, de forma visual
- **Grafo de commits** con ramas, para leer el historial de un vistazo.
- **Prepara, confirma y descarta** cambios; visor de diff **unificado o en paralelo** (y seleccionable para copiar).
- **Ramas, remotos y stashes** al alcance, con **deshacer commit** cuando te equivocas.
- **Fetch automático** en segundo plano: siempre sabes cuántos commits llevas de adelanto o atraso.
- **Clona repositorios**, abre varios proyectos y organízalos en **espacios de trabajo**.
- **Terminal integrada** (varias pestañas y paneles) y **editor de código** con vista previa de Markdown y diagramas.

### 🤖 Un asistente de IA — con tu proveedor
El gran diferenciador: elige el motor que prefieras y úsalo en todo el flujo.
- **Elige tu IA:** Claude Code, Gemini u Open Code (más en camino).
- **Chatea con tu repo:** la IA lee archivos, busca en el código y consulta el estado de Git para responder.
- **Mensajes de commit** redactados a partir de tus cambios preparados.
- **Análisis pre-commit:** revisa tu diff en busca de bugs y vulnerabilidades antes de confirmar, con un *quality gate* de fiabilidad, seguridad y mantenibilidad.
- **Resuelve hallazgos con un clic:** la IA propone el arreglo por ti.
- **Resolución de conflictos asistida:** propuesta editable cuando un merge choca.
- **Un modelo por tarea:** usa uno rápido para commits y uno más potente para revisar.

### 🔀 Pull requests, sin salir de la app
- Conecta **GitHub** y **Azure DevOps**.
- **Lista, revisa y comenta** PRs; **aprueba, pide cambios o ciérralos**.
- **Crea un PR** con **título y descripción generados por IA**.
- Publica los comentarios de la **revisión de IA** directamente en el PR.

### 🔒 Seguridad y privacidad
- **Escaneo de secretos** antes de cada commit: detecta claves de API, tokens y llaves privadas y te avisa a tiempo.
- Tus **tokens se guardan en el llavero del sistema**, nunca en texto plano.
- Es una app local: tu código se queda en tu equipo.

### 🎨 Hazlo tuyo
- Temas **claro, oscuro o del sistema**, con color de acento a elegir.
- Interfaz en **español e inglés**.
- **Plantillas de prompt** personalizables para commit, revisión y análisis.
- Por espacio de trabajo: **contexto de revisión**, archivos de **instrucciones (.md)**, **Skills** y **servidores MCP**.

## ⚙️ Puesta en marcha

Tres pasos para dejarla lista:

**1. Abre tu repositorio**
Pulsa el botón **+** en la barra lateral y selecciona una carpeta con un repositorio Git local. Repite para añadir todos los que quieras y agrúpalos en espacios de trabajo.

**2. Elige tu asistente de IA**
Ve a **Ajustes › Asistente de IA** y selecciona tu proveedor (Claude Code, Gemini u Open Code). Indica la ruta de su herramienta de línea de comandos —si ya está instalada en tu sistema, basta con dejar el nombre por defecto— y elige el modelo. El cambio se aplica al instante.

**3. Conecta tu plataforma (opcional)**
En **Ajustes › Git hosting** conecta **GitHub** o **Azure DevOps** para ver y revisar pull requests. La conexión usa un token de acceso que se guarda de forma segura en el llavero de tu sistema operativo.

**Ajustes que quizá quieras tocar:**
- **Git behavior** — tu identidad para los commits, el escaneo de secretos y el fetch automático.
- **Asistente de IA › Plantillas** — adapta el estilo de tus mensajes de commit, revisiones y análisis a tu equipo.
- **Apariencia** e **Idioma** — tema, color de acento y lengua de la interfaz.

## 💾 Descarga

Disponible para **Windows** y **macOS**. Descarga la última versión desde la
sección de **[Releases](../../releases)**, ejecuta el instalador y ábrela.

CodeFlow puede seguir corriendo en segundo plano (icono en la bandeja) para mantener
vivas las terminales y las tareas de IA aunque cierres la ventana.

## 🌐 Idiomas

Español e inglés, cambiables en cualquier momento desde **Ajustes › General**.

---

<div align="center">
<sub>Hecho para quien quiere Git, revisiones e IA en un mismo flujo. 💜</sub>
</div>
