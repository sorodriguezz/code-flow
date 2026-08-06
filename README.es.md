<div align="center">

<img src="src-tauri/icons/128x128@2x.png" width="88" alt="CodeFlow" />

# CodeFlow

### Tu cliente de Git de escritorio, con la IA que tú elijas.

Gestiona repositorios, revisa pull requests, convierte una especificación en backlog listo
y deja que la IA escriba tus commits, encuentre errores y resuelva conflictos — todo en una
app rápida y nativa. Y cuando termines, prueba el endpoint que acabas de cambiar y consulta
la base de datos que hay detrás sin salir de la ventana. **Y decides qué modelo hace cada
cosa.**

![versión](https://img.shields.io/badge/versión-1.13.2-6C5CE7)
![plataforma](https://img.shields.io/badge/plataforma-Windows%20%7C%20macOS-2D3436)
![proveedores](https://img.shields.io/badge/IA-7%20motores-00B894)
![idiomas](https://img.shields.io/badge/idiomas-ES%20%7C%20EN-0984E3)

[English](README.md) · **Español**

</div>

---

CodeFlow reúne en un mismo lugar lo que normalmente está repartido entre tu cliente de Git,
la web de GitHub/GitLab/Azure DevOps, tu tablero de Jira, monday o Azure, un cliente REST,
una herramienta de base de datos y una terminal aparte. Ves tu historial, preparas y confirmas cambios, abres
y revisas pull requests, escribes el backlog de lo que viene después, y tienes un asistente
de IA que entiende tu repositorio y trabaja contigo.

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

Elige entre siete motores. CodeFlow **detecta cuáles tienes instalados** y te dice qué
falta, en vez de dejarte adivinar por qué algo no funciona.

| Proveedor | Cómo funciona | Ideal para |
|---|---|---|
| **Claude Code** | CLI, con herramientas | Revisiones a fondo y aplicar correcciones |
| **Codex** | CLI, con herramientas | Tu suscripción de ChatGPT, sin créditos de API |
| **Gemini** | CLI (Antigravity), con herramientas | Alternativa potente con cuenta de Google |
| **Grok** | CLI, con herramientas | Retoma la conversación exacta, no «la última» |
| **Open Code** | CLI, cualquier modelo que configures | Mezclar proveedores a tu gusto |
| **Ollama** | 🔒 **Local**, sin nube | Privacidad total, sin conexión y sin coste |
| **OpenAI** | Clave de API, endpoint editable | OpenRouter, Groq, DeepSeek, Azure o vLLM |

La entrada de **OpenAI** habla el `/v1/chat/completions` de siempre y la URL es tuya, así
que cualquier servicio compatible entra por ahí sin esperar a que le hagamos un hueco
propio. La clave va al llavero del sistema.

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
> *(Las funciones que editan archivos —corregir hallazgos— necesitan un motor con
> herramientas, es decir uno de los cinco CLI; la app te lo indica y oculta lo que no
> aplica.)*

### Nada se pierde por mirar a otro lado

Todo lo que lanza la IA vive en segundo plano, no en la pantalla que lo lanzó.

- **Varias conversaciones a la vez**, sin límite: pregunta en una, ábrete otra y pregunta
  ahí mientras la primera sigue pensando.
- **Cambiar de chat, abrir un pull request o cerrar el panel no cancela nada.** La
  respuesta aterriza en la conversación que preguntó, esté o no en pantalla.
- **ACTIVIDAD lo lista todo mientras corre** — chats, revisiones de PR, análisis
  pre-commit y correcciones — con su contador de cuántos hay vivos. Un clic te devuelve
  justo donde estabas, con el log en marcha y el botón de parar.
- **El cronómetro dice la verdad**: cuenta desde que arrancó la tarea, no desde que
  volviste a mirarla.

## 🤖 Agentes que siguen trabajando cuando tú no

Un agente es un **rol con su propio motor**: nombre, modelo e instrucciones fijas, escritas
una vez y reutilizadas. El documentador en un modelo barato, el revisor en el mejor que
tengas — sin tocar los ajustes globales. Es la misma lista que usa el selector de agente del
chat, así que no hay dos plantillas que mantener.

- **Tareas** — le das a un agente un objetivo y un repositorio, y te vas. Sigue corriendo
  aunque cambies de vista o de espacio de trabajo, y espera en **Te toca** cuando necesita
  algo de ti.
- **Cadenas** — varios agentes uno detrás de otro, cada uno recibiendo el trabajo del
  anterior: arquitecto → implementador → revisor. Pon una **compuerta** en cualquier paso y
  la cadena se detiene a enseñarte el mensaje exacto que va a mandar, que puedes editar antes
  de que salga.
- **Revisa lo que hizo** contra el diff real de ese repositorio, igual que revisarías tu
  propio trabajo.
- **Sube de modelo a mitad de la conversación** cuando la cosa resulta más difícil de lo que
  parecía.
- Si un paso falla, la cadena **para y espera**: reintentar, saltar o abortar. Nunca hace
  bucles ni reintentos por su cuenta.

> ⚠️ Los agentes editan tu copia de trabajo **de verdad**. Cada turno toma un punto de
> restauración antes de empezar, y solo corre un agente por repositorio a la vez — pero son
> tus archivos, no una caja de arena. Para trabajar en paralelo, reparte por repositorios.

## 🌳 Git, de forma visual

- **Grafo de commits** con ramas, para leer el historial de un vistazo.
- **Prepara, confirma y descarta** cambios; diff **unificado o en paralelo**, seleccionable para copiar.
- **Ramas, remotos y stashes** a mano, con **deshacer commit** cuando te equivocas.
- **Fetch automático** en segundo plano: siempre sabes cuántos commits llevas de adelanto o atraso.
- **Clona repositorios**, abre varios proyectos y agrúpalos en **espacios de trabajo**.
- **Terminal integrada** (varias pestañas y paneles) y **editor de código** con vista previa de Markdown y diagramas.
- **Ejecuta y depura** por Debug Adapter Protocol, con puntos de ruptura y variables.

## 🔀 Pull requests, sin salir de la app

- Conecta **GitHub**, **GitLab** y **Azure DevOps** — todos a la vez, si hace falta. Y varias
  cuentas por host.
- **Revisa un PR pegando solo su enlace** (⇧⌘L): CodeFlow averigua a cuál de tus repos pertenece
  — aunque esté en otro workspace — y lanza la revisión.
- ¿El repo no está en tu máquina? **Revísalo igual, sin clonar**: el diff se lee de la API del host.
  Es una revisión más superficial (el modelo no ve el resto del código), así que también puedes
  clonarlo de un clic para la revisión completa.
- **Lista, revisa y comenta** PRs; **aprueba, pide cambios o ciérralos**.
- **La revisión se prepara antes de gastar nada**: CodeFlow recorta cada archivo a los símbolos que
  el PR tocó — el método completo, numerado, con `>` marcando lo que cambió — reparte el trabajo
  entre varios revisores en paralelo y cierra con una pasada cruzada que busca lo que ningún
  revisor por archivo puede ver: firmas que dejaron atrás a quien las llama, esquemas que
  divergieron.
- **Tres niveles de profundidad** (básico · completo · ultra) con un contrato de verdad, no una
  sugerencia: umbral de confianza, severidades que se reportan, lentes activas y paralelismo. Todo
  se edita en Ajustes → Revisión → Motor, lo aplica el código, y queda congelado en cada revisión
  guardada para que una vieja siga diciendo bajo qué reglas se hizo.
- **Memoria que se consulta, no solo se guarda**: lo que ya se descartó en otros PRs sobre esos
  mismos archivos vuelve como contexto, y quién más en el repositorio referencia los símbolos que
  tocas llega como pista para los cambios de contrato.
- **Crea un PR** con título y descripción por IA, también como borrador.
- Publica los comentarios de la **revisión de IA** directamente en el pull request.

## 📝 De un documento a un backlog

La parte del trabajo que normalmente se come una reunión: convertir una especificación que
nadie ha leído en historias que alguien pueda construir. Funciona en tres direcciones, y las
tres comparten tu espacio de trabajo, tu conexión al tablero y tus repositorios.

### Redactar

Apúntalo a una página de wiki, a una carpeta de archivos Markdown o a texto que pegues, y
recibes un conjunto de historias de usuario — narrativa, criterios de aceptación en
**Gherkin** listos para Cucumber, estimación, etiquetas y las preguntas que la documentación
dejó sin responder.

- **Cada historia se puntúa en local, sin modelo de por medio.** Que la narrativa tenga sus
  tres partes, que ningún escenario tenga dos «Cuando», que todo criterio sea comprobable,
  que la estimación esté en la serie de Fibonacci. Es una comprobación en la que se puede
  confiar justamente porque da lo mismo siempre — no es una opinión que cambia en la
  siguiente corrida.
- **Verifica contra tu código.** Cada criterio recibe un veredicto — cumple, no cumple,
  parcial, no se sabe — con el archivo y la línea que lo demuestran. Así te enteras de lo que
  ya está construido antes de volver a planificarlo.
- **Exporta un archivo `.feature`** dentro del repositorio, para que QA ejecute los criterios
  en vez de leerlos.
- **Publica** las historias que elijas en **Azure Boards**, **Jira** o **monday.com** — todos
  conectados a la vez, con un tablero elegido por conjunto. En Azure llevan su área, iteración y
  etiquetas; en Jira sus labels y su estimación; en monday, las columnas que tu tablero tenga de
  verdad — y el panel te dice cuáles emparejó antes de publicar.
- Todo es editable antes de eso: corrige un título, reescribe un escenario, tira una historia.
  Los cambios se guardan al salir del campo.

### Revisar

Para una historia, un bug o un elemento que **ya existe** en el tablero. Pega su enlace — un work
item de Azure, un `PROJ-123` de Jira, un elemento de monday — elige los repositorios que toca, y descubre qué le falta — en tres pasadas que lanzas
tú:

1. **Analizar** — qué le falta a la historia, medido con INVEST y testabilidad. Para un bug la
   vara es otra: reproducible, esperado, obtenido, alcance.
2. **Criterios** — los escenarios Gherkin que nadie escribió, sobre la historia *tal como está
   en ese momento*, incluidas tus ediciones del paso anterior.
3. **Tareas** — el desglose en trabajo de desarrollo y de QA, sabiendo qué tareas ya tiene
   para no proponerlas dos veces.

Nada llega al tablero por su cuenta. Lo que quieras mandar va a una columna de publicación y
lo confirmas campo por campo, viendo exactamente qué va a cambiar antes de que cambie.

### Wiki

La dirección contraria: lee el código y escribe la documentación técnica que las otras dos
pestañas dan por hecho que alguien redactó.

- **Por repositorio** — cómo se construye, se configura, se levanta en local y se despliega,
  con sus variables de entorno, integraciones y base de datos.
- **Por espacio de trabajo** — cómo encajan varios repositorios como sistema: quién llama a
  quién, los contratos entre ellos y dónde están acoplados.

Sale como Markdown editable, y se publica en tu wiki cuando dice lo que quieres decir.

## 🛰️ Un cliente de API, incorporado

Prueba el endpoint que acabas de cambiar sin cambiar de aplicación — en la misma ventana
que el commit que lo cambió.

- **Seis protocolos**: REST, GraphQL (con introspección de esquema), WebSocket, Socket.IO,
  gRPC (desde un `.proto` o por reflexión del servidor) y MQTT.
- **Colecciones, carpetas y entornos**, con variables que se resuelven en todas partes —
  URL, cabeceras, cuerpo y autenticación.
- **Scripts previos y tests** en JavaScript, para que un login alimente la llamada siguiente.
- **Trae lo que ya tienes**: importa desde Postman, OpenAPI/Swagger, Insomnia, HAR o un
  cURL pegado tal cual. Exporta de vuelta a Postman, OpenAPI o al formato propio de CodeFlow.
- **Ejecuta una colección entera** y lee el resultado como un informe.
- **Genera el código** de una petición en el lenguaje con el que trabajas.
- **Comparte una colección con tu equipo** a través de **tu propio** proyecto de Supabase:
  lo alojas tú, así que las peticiones y sus secretos se quedan en infraestructura tuya.

## 🗄️ Tus bases de datos, en la misma ventana

La consulta que necesitas comprobar está a una pestaña de la migración que acabas de escribir.

- **Cinco motores**: PostgreSQL, Supabase, SQL Server, InterSystems IRIS y MongoDB.
- **Navega el árbol** — esquemas, tablas, vistas, rutinas, secuencias, columnas, índices y claves.
- **Consola SQL** con historial, `EXPLAIN` y resultados exportables.
- **Edita filas en una grilla**: los cambios quedan en staging y ves las sentencias exactas
  antes de que se ejecute nada.
- **Lee el DDL** de cualquier objeto y el **diagrama del esquema** con sus claves foráneas.
- **Conexiones de solo lectura** para las que no debes tocar por accidente, y **túnel SSH**
  cuando la base está detrás de un bastión.
- Las contraseñas van al **llavero del sistema**, nunca a la base de datos de la app.

## 🔒 Seguridad y privacidad

- **Escaneo de secretos antes de cada commit** — detecta claves de API, tokens y llaves privadas, y te para a tiempo. Reglas deterministas, sin enviar nada a ningún sitio.
- Tus **tokens viven en el llavero del sistema**, nunca en texto plano.
- **Opción 100% local** con Ollama: tu código nunca sale del equipo.
- Es una app de escritorio: sin servidor, sin cuenta, sin telemetría.

## 🎨 Hazlo tuyo

- Temas **claro, oscuro o del sistema**, con color de acento a elegir.
- Interfaz en **español e inglés**.
- **Plantillas de prompt** para commit, análisis, revisión, descripción de PR y conflictos —
  y para redactar historias, verificarlas y generar documentación, para que el backlog salga
  con el estilo de tu equipo.
- Las de **revisión de PR** son seis, una por pieza del motor: las lentes, la profundidad de cada
  nivel, el revisor en paralelo, el pase cruzado y el resumen de cierre. Los números no se escriben
  a mano: llegan del Motor por marcadores tipo `{{MIN_CONFIANZA}}`, así que reescribir la redacción
  nunca deja la instrucción y el filtro que la aplica en desacuerdo.
- Por espacio de trabajo: **contexto de revisión**, **instrucciones (.md)** y **Skills**.
- **Agentes reutilizables** con su propio modelo e instrucciones fijas.
- **Historial completo** de lo que ha hecho la IA — incluidos los fallos, para que mañana sepas qué pasó.

## ⚙️ Puesta en marcha

**1. Abre tu repositorio**
Pulsa **+** en la barra lateral y elige una carpeta con un repositorio Git. Repite para
añadir todos los que quieras y agrúpalos en espacios de trabajo.

**2. Elige tu asistente de IA**
En **Ajustes › Asistente de IA › Proveedores** verás los siete motores con su estado
(*Disponible* / *No encontrado*). Despliega el que quieras usar, comprueba su binario —o
el endpoint, si es Ollama u OpenAI— y elige su modelo. Márcalo como **predeterminado** y
listo.

**3. Afina por tarea (opcional)**
En **Modelo por tarea** asigna un motor distinto a cada acción. Todo empieza en
«heredar», así que solo tocas lo que quieras cambiar.

**4. Conecta tu plataforma (opcional)**
En **Ajustes › Alojamiento Git** conecta **GitHub**, **GitLab** o **Azure DevOps** para ver y
revisar pull requests — y, en Azure DevOps, para leer wikis. **Jira** y **monday.com** se conectan en
la misma pantalla: como no alojan código, aparecen para tu backlog y no para los pull requests. Los
tokens se guardan en el llavero de tu sistema operativo, nunca en la base de datos de la app.

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
