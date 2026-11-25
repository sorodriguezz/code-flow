# Novedades de CodeFlow

<!--
Lo que escribas aquí es lo que ven los usuarios en la ventana «Novedades» al aparecer una
actualización (y el cuerpo del release en GitHub). Escríbelo para ellos: qué pueden hacer ahora,
qué mejoró, qué se arregló. Solo el impacto en la app: sin nombres de archivos ni de módulos,
sin referencias a una organización, sus paquetes o herramientas internas, y sin datos personales.

Cómo usarlo:
- Antes de subir la versión en package.json, agrega arriba una sección con ese número exacto:
  `## 2.9.5` (también vale `## [2.9.5]` o `## v2.9.5`, con ` — fecha` opcional detrás).
- Dentro, usa las secciones que apliquen y omite las vacías:
  ### ✨ Nuevo · ### 🚀 Mejorado · ### 🐛 Corregido · ### ⚠️ Importante
- Si falta la sección de la versión, el release se publica igual con los mensajes de commit
  y el workflow deja un aviso.
-->

## 2.9.9

### ✨ Nuevo
- **Gemini, Grok y opencode más rápidos, con un agente que queda abierto.** CodeFlow ahora se conecta a estos tres por ACP, el protocolo con el que los usan los editores, en vez de abrir un programa nuevo en cada mensaje. El agente queda abierto entre turnos: en Gemini, un turno que antes tardaba unos 5 segundos ahora tarda unos 2. Las conversaciones que ya tenías siguen funcionando, y si el agente no arranca, ese turno usa la forma de siempre sin que tengas que hacer nada.
- **Gemini, Grok y opencode escriben la respuesta en vivo.** El texto aparece a medida que el agente lo escribe, igual que con Claude, en vez de llegar entero al final. También ves su razonamiento mientras piensa.
- **Ves lo que hace Gemini mientras trabaja.** La actividad del chat muestra cada archivo que lee o edita y cada comando que ejecuta, igual que con Claude.
- **Las herramientas de CodeFlow llegan a Gemini y Grok sin tocar tu repositorio.** Antes se escribía un archivo de configuración dentro del proyecto durante el turno; ahora se le entregan directamente al agente. También funcionan en los turnos de solo lectura, y los scripts de CodeFlow ya pueden actuar en Gemini y Grok con los permisos del turno.
- **CodeFlow responde los permisos de estos agentes.** Cuando Gemini, Grok u opencode piden permiso para editar o ejecutar algo, CodeFlow aplica las mismas reglas que con Claude: en un turno de solo lectura no se escribe nada, los comandos peligrosos te piden confirmación y «Completo» no pregunta. Si un agente se detiene porque se le negó algo, el chat te dice qué fue.
- **Cuota de Grok en el medidor de uso.** Ahora ves cuánto llevas usado de la semana de Grok, cuándo se reinicia y tu plan. Se actualiza al abrir el panel, igual que la de Gemini.
- **Ajuste «Conexión con el agente»** en Ajustes › Proveedores, para elegir entre ACP (recomendado) y la CLI clásica en Gemini, Grok y opencode.
- **Mira cuántos tokens ahorran los scripts del asistente.** Al abrir un script en el chat ves cuánto leyó y cuánto le llegó al modelo. En Ajustes › Proveedores, junto a los scripts de CodeFlow, un resumen de los últimos 30 días compara lo que leyeron los scripts con lo que le entregaron al modelo, y cuánto trae en promedio cada llamada suelta. Son estimaciones según el tamaño de las respuestas, no lo que factura el proveedor.
- **Contenedores: entornos por rama.** Nueva página «Entornos» para correr varias ramas del mismo sistema a la vez, cada una con su propio checkout, contenedores, red, volúmenes y puertos. CodeFlow propone cómo correr el repositorio (devcontainer o Compose), copia los `.env` que no están en git y elige un desplazamiento de puertos libre. Cada entorno se puede iniciar, detener, reconstruir, clonar a otra rama, respaldar y restaurar sus volúmenes, o eliminar sin perder cambios sin commitear. Los devcontainer corren con la CLI de Dev Containers si está instalada, o directamente aplicando `runArgs`, `mounts`, `workspaceMount`, `initializeCommand` y las opciones de build, revisados contra la política de seguridad; con la CLI los puertos también se desplazan. Si hay `features` sin la CLI, el diálogo te muestra cómo instalarla o te deja correr sin ellas, y CodeFlow te pide confirmar el `initializeCommand` antes de ejecutarlo en tu equipo, otra vez si la rama lo cambia.
- **Contenedores: catálogo de servicios.** Levanta en un clic PostgreSQL, MySQL, SQL Server, MongoDB, Valkey, Keycloak, Mailpit, MinIO, Azurite, RabbitMQ, Redpanda, WireMock, Qdrant, Jaeger o Grafana LGTM. Las bases de datos aparecen solas como conexiones en Base de datos y Keycloak como entorno y preset OAuth2 en el cliente API. Las contraseñas se generan y quedan en el Llavero, nunca en el archivo, y los puertos se publican solo en este equipo. Levantar un stack se ve en vivo en el panel de tareas, espera los healthchecks cuando el motor lo admite, y las conexiones se crean solo si terminó bien; si lo cancelas o falla, el stack queda con su error para levantarlo de nuevo.
- **Contenedores: sandboxes para agentes.** Nueva página «Sandboxes»: el trabajo de un agente corre en un contenedor aislado con su propio worktree, usuario no root, sin capacidades, raíz de solo lectura, límites y la red que elijas (sin red, interna o internet). Cada sandbox guarda su evidencia (comandos con su resultado, pruebas, diff final, informe de política y escaneo de la imagen), exportable a Markdown. Los agentes que trabajan en ese worktree (Claude Code, Codex, opencode, Cline, Antigravity, Grok y el agente local de CodeFlow) reciben herramientas para ejecutar, leer y escribir solo dentro de su sandbox; los turnos de plan o de solo lectura no pueden ejecutar ni escribir.
- **Políticas de seguridad por workspace.** Prohíbe contenedores privilegiados, rutas del sistema y el socket del motor; exige usuario no root, límites e imágenes firmadas; bloquea imágenes con vulnerabilidades críticas y restringe internet. Se aplican a los sandboxes, a los flujos que lo pidan y como aviso al ejecutar un contenedor, donde lo prohibido bloquea el botón.
- **Historias → ambiente de ingeniería.** Desde una historia, «Crear ambiente de ingeniería» crea la rama, el worktree y un sandbox enlazados a ella.
- **Kubernetes local y Helm.** Crea clústeres con kind, k3d o minikube desde «Agregar clúster → Local», e inícialos, detenlos o elimínalos desde la página de clústeres. En cada clúster, Helm: releases con su estado, historial, valores y manifiesto; actualizar, revertir, desinstalar e instalar charts desde repositorios.
- **Contenedores: seguridad al ejecutar.** «Ejecutar contenedor» tiene una sección Seguridad (usuario, solo lectura, capacidades, sin nuevos privilegios, seccomp, tmpfs, límite de procesos y memoria compartida) con un botón de perfil endurecido, y un healthcheck propio o apagado.
- **Contenedores: endurecimiento y cambios.** El detalle de un contenedor muestra qué debilita su aislamiento (modo privilegiado, socket del motor montado, red del host, root, sin límites…) con cómo arreglarlo, y qué archivos agregó, cambió o borró respecto de su imagen.
- **Contenedores: más acciones.** Etiquetar, publicar y guardar imágenes como archivo, y cargarlas desde uno; crear una imagen desde un contenedor, exportar su sistema de archivos y conectarlo o desconectarlo de una red.
- **Escaneos de vulnerabilidades guardados.** Cada análisis de una imagen queda en su historial (los últimos 20) y dos de ellos se comparan para ver qué se corrigió y qué apareció. También puedes exportar el SBOM de la imagen en CycloneDX o SPDX con Trivy o Syft.
- **Revisión del Dockerfile** con hadolint al construir una imagen, si está instalado.

### 🚀 Mejorado
- **Kiri se detecta como motor de contenedores**, con su nombre, y se puede iniciar desde la app. El selector de contextos Docker muestra qué motor hay detrás de cada uno.
- **La cuota de Codex se sigue viendo aunque falle la lectura rápida.** Si la forma habitual de leerla falla, CodeFlow se la pregunta directamente a Codex (como mucho una vez cada 30 minutos), en vez de dejar el medidor vacío.
- **Los scripts del asistente gastan menos contexto.** El resumen que recibe el modelo después de un script ya no lista cada llamada con su duración: agrupa las que salieron bien («service_log ×10») y solo detalla las que fallaron. El detalle completo sigue en la tarjeta del chat.
- **El asistente elige mejor cuándo usar un script.** Si una llamada suelta trae una respuesta grande, se le sugiere usar un script la próxima vez para filtrar solo lo necesario, y no solo cuando la respuesta llega cortada o se encadenan muchas llamadas.
- **Tope de llamadas por turno para los scripts.** Además del límite de cada script, todos los scripts de un mismo turno comparten un máximo de 200 llamadas, así que el asistente no puede encadenar scripts sin fin.

### 🐛 Corregido
- **Antigravity y Grok ya no ven más de la cuenta al revisar material ajeno.** Cuando corrían por CLI sobre el diff de un pull request, un log de CI o una historia del tablero, recibían las herramientas de lectura de la app (la salida de otras terminales, los logs de servicios, su sandbox). Ahora reciben solo el mapa del código, el conocimiento y las memorias, igual que los demás agentes en esas tareas.
- **Detener un script del asistente lo corta en el acto.** Antes, si el script estaba esperando una acción de la app, esa acción seguía corriendo hasta tres minutos más después de pulsar Detener, y podía pasarse del límite de 5 minutos. Ahora se cancela de inmediato y ninguna espera pasa del tiempo que le queda al script.
- **Un script que insiste después de su límite de llamadas se detiene.** Antes podía seguir intentándolo hasta agotar el tiempo y llenaba la actividad del chat de intentos rechazados. Ahora, si sigue llamando después del aviso, termina en ese momento.
- **Más acciones piden tu aprobación.** Ejecutar código en un notebook o en el depurador, aplicar un manifiesto a un clúster, subir ramas o etiquetas, publicar mensajes MQTT, enviar peticiones desde el cliente de API, subir archivos a un servidor remoto, leer mensajes de una cola (eso los consume) y eliminar o detener a la fuerza contenedores o pods ya no corren sin preguntarte. Tampoco dentro de un script.
- **El asistente ya no puede salirse del workspace con rutas engañosas.** Las rutas con `..` o con enlaces simbólicos que apuntan fuera de tus repositorios ahora se rechazan.
- **Los mensajes de error de la app ya no exponen secretos al asistente.** Se les quitan los secretos guardados igual que a las respuestas, y también a los que tienen comillas o saltos de línea, que antes podían pasar.
- **Los modelos locales ya no reciben instrucciones para una herramienta que no tienen.** Con los scripts activados, se les pedía usar una herramienta de llamada individual que no les está disponible, y eso causaba intentos fallidos.

## 2.9.8

### 🚀 Mejorado
- **Los enlaces del chat se abren en el Navegador de CodeFlow.** Un enlace en una respuesta (por ejemplo, las fuentes al final) ya no te saca de la app: se abre en una pestaña del Navegador, y desde ahí puedes pasarlo a tu navegador con «Abrir en tu navegador». Si prefieres ir directo a tu navegador, haz clic con Shift.

### 🐛 Corregido
- **⌘Z, ⌘⇧Z, ⌘A y ⌘W vuelven a funcionar en el editor y en el resto de la app (macOS).** Desde la versión anterior, deshacer, rehacer y seleccionar todo no hacían nada en el editor de código, y ⌘W cerraba la ventana completa en vez de la pestaña. Ahora cada atajo hace lo que corresponde donde está el cursor, también en el menú Edición.
- **El texto que el asistente escribe mientras trabaja ya no sale todo junto.** Cada vez que retoma después de usar una herramienta empieza un párrafo nuevo, en vez de pegarse a la frase anterior («…el repo.Ahora la configuración…»).
- **No más líneas de código crudo en la actividad del asistente.** Cuando una herramienta devolvía un resultado muy largo, la lista de pasos mostraba fragmentos de datos internos en vez de ocultarlos.

## 2.9.7

### ✨ Nuevo
- **Scripts de CodeFlow para el asistente.** Cuando una tarea necesita muchas llamadas a la app (revisar varios servicios y reiniciar los caídos, cruzar datos, filtrar una respuesta grande), el asistente puede escribir un script corto que hace todas esas llamadas en un entorno aislado de este equipo y le devuelve solo el resultado. Son menos idas y vueltas y menos tokens. Para una o dos llamadas sigue usando la herramienta de siempre.
- **El script se ve en el chat como un paso que se abre:** cada llamada con su resultado y su duración, el código que escribió el asistente (con un botón para copiarlo), lo que devolvió y, si algo falló, en qué llamada y por qué. Si falla, se abre solo.
- **Un ajuste por proveedor** en Ajustes › Proveedores: «Automático» o «Apagado». Viene encendido para Claude, Codex, opencode, Cline, Gemini y Grok (en Gemini y Grok el script solo puede consultar) y apagado para los modelos locales. Los comandos destructivos nunca corren dentro de un script: siguen pidiendo tu aprobación uno por uno.

### 🚀 Mejorado
- **«Consultó» agrupa todo lo que el asistente hizo en la app** (buscar comandos, llamarlos y los scripts) bajo «CodeFlow», en vez de mostrarlo como un conector aparte.

### 🐛 Corregido
- **Los chats del workspace ya no desaparecen de la Bandeja.** En un workspace con un solo repositorio, o sin ninguno (por ejemplo, después de quitar el único que tenía), la Bandeja no mostraba los chats del workspace, y al cerrar su pestaña no había forma de volver a abrirlos. Ahora siempre aparecen. Una Bandeja vacía lo dice, en vez de quedar en blanco.
- **Quitar un repositorio ya no borra sus chats.** Antes, quitar un repositorio de CodeFlow borraba todas las conversaciones que tuviste en él. Ahora siguen en la Bandeja del workspace, marcadas con «(quitado)» junto al nombre del repositorio, y se pueden abrir para leerlas. Duran hasta que las borres o elimines el workspace. Si vuelves a agregar la misma carpeta al workspace, sus chats vuelven a ese repositorio y puedes seguirlos.
- **Borrar un workspace no deja basura.** Sus chats ya se borraban con él; ahora también se borran de inmediato las carpetas en disco de esos chats (los archivos que generaron, las imágenes adjuntas y la carpeta de trabajo del workspace).
- **Servicios creados por el asistente aparecen al instante.** Cuando el asistente crea, edita o borra un servicio o un grupo, el panel Servicios se actualiza solo; ya no hace falta recargar la ventana ni cambiar de workspace. Lo mismo pasa si un servicio del workspace se levanta desde fuera de la ventana.

## 2.9.6

### ✨ Nuevo
- **Herramientas: pegar y detectar.** Un botón lee el portapapeles, reconoce qué hay (un JWT, un JSON, un timestamp, un cron, Base64, un UUID, una URL, un certificado, un hash bcrypt…) y abre la herramienta que corresponde con el contenido ya cargado. Si pegas o escribes datos en la búsqueda, también ofrece «Abrir en…».
- **Herramientas: enviar a otra herramienta.** La salida de cualquier herramienta se puede mandar como entrada a otra: por ejemplo, un Base64 decodificado directo al formateador de JSON.
- **Diez herramientas nuevas:** bcrypt (generar y verificar), códigos TOTP para probar 2FA (también desde un enlace `otpauth://`), Base32, Base58, formatear y minificar HTML, CSS y JavaScript, diff de JSON por estructura (el orden de las claves no cuenta), validar un JSON contra su JSON Schema, convertir entre `.env` y JSON, ver la fecha de creación dentro de un ObjectId, un Snowflake o un ULID, y leer un código QR desde una imagen o una captura pegada.

### 🚀 Mejorado
- **Herramientas más cómodas:** las favoritas (con la estrella de cada fila) y las últimas que abriste aparecen arriba de la lista. La búsqueda se recorre con las flechas y Enter abre la marcada. La lista se puede ensanchar y, si la arrastras más allá de su mínimo, se pliega a una barra.
- **Panel del asistente que no se deforma:** el panel ya no se puede angostar hasta que su contenido se encime; si sigues arrastrando el borde más allá del mínimo, el panel se oculta, igual que con su botón en la barra lateral, y al volver a abrirlo recupera el ancho que tenía. En un panel angosto, la insignia «Plan», los artefactos y «Compartir» muestran solo su ícono.
- **Historial del chat del workspace más limpio:** los chats se agrupan por día («Hoy», «Ayer», la fecha) y cada uno ocupa una sola línea con su hora; el chat abierto se marca con un punto y el botón de borrar aparece al pasar el mouse.
- **Menos botones en el chat del workspace:** se quitó «Nuevo chat del workspace»; para eso están el subchat y el «+» de las pestañas.
- **Pregunta rápida con esquinas redondeadas,** como la ventana de CodeFlow.
- **Lista de puntos de interrupción más legible:** cada fila muestra primero el archivo y la línea, y después la carpeta en gris. La fila usa todo el ancho y los botones de editar, convertir en logpoint y quitar aparecen al pasar el mouse.
- **Marcadores, solo marcadores:** el panel «Marcadores» ya no repite los puntos de interrupción, que tienen su lista en «Ejecutar y depurar».
- **Captura de código más grande:** la ventana de captura crece con el tamaño de la ventana de CodeFlow, así se ven bien las líneas largas.
- **Pipelines con lista plegable:** si arrastras el borde de la lista de ejecuciones más allá de su mínimo, se pliega a una barra delgada, igual que en el cliente de API o en base de datos. Un clic en la barra la vuelve a abrir.
- **Proyectos y Configuración se pliegan al arrastrar:** si llevas el borde de la lista de proyectos o del menú de Configuración más allá de su mínimo, se pliegan a su barra de íconos, igual que con su botón. Al abrirlos de nuevo recuperan el ancho que tenían. Además, los dos tienen un ancho mínimo un poco mayor, para que los nombres no se corten tanto.
- **«Nuevo conjunto de historias» más amplio:** la ventana se adapta al tamaño de la pantalla, así las fuentes caben en una línea y la lista de páginas de la wiki muestra más a la vez.
- **Importar de la wiki sin adivinar la ruta:** al elegir la wiki aparece la lista de sus páginas. Escribe para filtrarla o haz clic en la que quieras; pegar la URL de la página sigue funcionando. Si el proyecto tiene una sola wiki, se elige sola.
- **Revisar un work item eligiéndolo de una lista:** en «Revisar», el campo de búsqueda muestra tus work items abiertos al hacer clic, y al escribir busca por título o número en toda la organización. Un selector de proyecto, al lado de la organización, acota la lista a uno solo y recuerda tu elección. Un clic lo carga; pegar el enlace sigue funcionando.
- **«Cómo funciona» más grande:** la guía de Especificación se adapta al tamaño de la ventana.

### 🐛 Corregido
- En el encabezado del chat del workspace, «10 repos» ya no queda montado bajo la insignia «Plan · solo lectura».
- En el editor, un breakpoint en una línea larga que se ajusta en varias filas ya no muestra un punto por fila, sino uno solo.
- En la captura de código, la vista previa ya no deforma el texto: si la imagen no cabe, se achica entera y mantiene sus proporciones.
- En Herramientas, los botones «Pegar» pegan con un solo clic: ya no aparece la burbuja «Paste» del sistema pidiendo confirmar.
- En Herramientas, «Copiar» ya no falla en silencio: si el sistema rechaza la copia, lo intenta por otra vía y avisa si tampoco funciona.
- En los diálogos de contenedores, «Pegar variables» pega con un solo clic, sin la burbuja «Paste» del sistema.

## 2.9.5

### 🚀 Mejorado
- **Chat más fácil de leer:** las listas de las respuestas vuelven a tener viñetas, los subtítulos se distinguen del texto y las tablas ya no cortan palabras a la mitad. Cada respuesta termina en una sola línea con el modelo, la hora y las fuentes de contexto («2 fuentes ▾»). La versión, los tokens y el costo aparecen al pasar el mouse. Hay más espacio antes de cada pregunta nueva, y el texto se desvanece en los bordes en vez de cortarse.
- **Encabezado del chat más compacto:** «Compartir» y «Unirse con un link» están ahora en un menú de la barra superior, así el chat gana una fila.
- **Maximizar el panel al arrastrar:** si llevas el borde del panel hasta el tope, queda maximizado y el botón de arriba cambia a «restaurar». Al restaurar, vuelve al ancho que tenía antes.
- **Preguntas del chat más ágiles:** cuando la IA hace una sola pregunta, un clic en la opción (o su número en el teclado) la responde, sin pasar por «Responder». Las opciones se muestran como una lista numerada, y «Otra respuesta» se envía con Enter. Con varias preguntas, el progreso y el envío quedan en una sola línea al final.
- **Preguntas anteriores plegadas:** las preguntas ya respondidas ocupan una sola línea que se despliega al hacer clic. Si respondiste con una de las opciones, la línea la muestra.
- **Bandeja renovada:**
  - El alcance, la búsqueda, «Analizar cambios» y un botón «Nuevo» quedan en una sola fila, y los filtros pasan a pestañas con cuántos hay de cada tipo.
  - En un panel ancho cada actividad ocupa una línea, con el título, el repositorio y la hora en columnas, así entran casi el doble.
  - Los repositorios aparecen con un nombre corto («DataSync» en vez de «Dev.Agenda.Node.DataSync»), y los chats del workspace tienen su propio ícono.
  - Los PRs muestran el número aparte, un título limpio y lo último que hiciste con ellos (revisado, aprobado, cambios pedidos o cerrado).
  - Los subchats se despliegan desde junto al título, y la fecha queda fija arriba mientras bajas.
- **Cambios del turno más claros:**
  - Lo que una respuesta cambió en tus repositorios aparece dentro de la respuesta, en una sola tarjeta aunque haya tocado varios repositorios. Plegada ya muestra los primeros archivos.
  - Al desplegarla, cada repositorio es una línea con su total de líneas y cada archivo indica si es nuevo, modificado o eliminado. Los repositorios con muchos archivos muestran los primeros y un «Ver más».
  - El diff de cada bloque muestra los números de línea.
  - «Deshacer todo» deja todo como estaba antes del turno, en todos los repositorios, y siempre pide confirmación. Lo mismo al descartar un repositorio completo.
- **«Enviar a un subchat»:** al seleccionar texto de una respuesta, el botón que antes abría un chat nuevo sin relación ahora crea un subchat del chat actual, con el texto citado listo para enviar.
- **Artefactos más compactos:** la tarjeta de un artefacto se ajusta a su contenido, muestra el tipo en palabras («Página · 200 líneas») y se abre al hacer clic en cualquier parte. La lista de artefactos del chat pasó de una franja propia a un botón en la barra superior.

## 2.9.4

### ✨ Nuevo
- **Aprobar el PR desde la revisión:** si la última revisión pasó su Quality Gate de forma concluyente, puedes aprobar el pull request con un clic. Antes de enviar, CodeFlow te muestra con qué cuenta se aprobará, y la memoria de la revisión guarda quién aprobó, cuándo y con qué gate.
- **Métricas de revisión:** nueva pestaña con el Quality Gate por mes, los hallazgos nuevos por severidad, los hallazgos abiertos por repositorio, los falsos positivos por revisor y por categoría, y el costo por revisión. Se puede filtrar por repositorio y por fechas.
- **Deuda técnica:** ahora puedes marcar un hallazgo como deuda técnica aceptada, siempre con un motivo. Deja de contar para el gate, pero sigue visible en cada revisión y se da por saldado cuando una revisión lo encuentra corregido. Opcionalmente, cada revisión también revisa la deuda aceptada en otros PRs del mismo repositorio.
- **Reglas automáticas antes de la IA:** un primer análisis marca en las líneas agregadas secretos (siempre enmascarados), restos de depuración, tests enfocados, dependencias nuevas y archivos .env. Además hay reglas que revisan la configuración de entornos, cambios de esquema de base de datos sin migración, versiones de Node vulnerables o sin soporte, y dependencias que se pueden actualizar. Cada regla se activa o desactiva por separado, y ninguna puede hacer fallar una revisión.
- **Lo que el equipo decide en el PR ahora cuenta:** si el equipo cierra un hilo (por ejemplo como "won't fix") o responde "Falso positivo: …" en el PR, la siguiente revisión lo aplica sola. Si el veredicto no está claro, se te ofrece aplicarlo con un clic. También puedes reabrir un hallazgo.
- **Varios enlaces de PR a la vez:** pega varios enlaces (uno por línea, separados por comas o dentro de un texto) y ábrelos o revísalos todos juntos. Cada uno se abre en su propia pestaña.
- **Respaldos livianos:** incluir las carpetas de los repositorios ahora es opcional. Puedes elegir cuáles incluir y ver cuánto pesa cada una. Al restaurar, los repositorios que quedaron fuera se pueden clonar desde su remoto, uno a uno o todos a la vez, y vuelven a su rama.

### 🚀 Mejorado
- **Respaldos más pequeños:** los repositorios se guardan comprimidos. Ya no incluyen lo que ignora el .gitignore del repositorio ni los archivos .env locales; las plantillas como .env.example sí se incluyen, y todo lo que git versiona se incluye siempre.
- **Motor de revisión más ajustable:** aviso cuando la cobertura de código que publica el CI (Azure DevOps o GitLab) queda bajo un umbral, sin bloquear el gate. Calibración por repositorio: se pide más confianza en las categorías que el equipo descarta seguido. Y CodeFlow pregunta antes de revisar PRs de promoción entre ramas largas (develop → main, release/*).
- **Revisiones por enlace con memoria:** las revisiones de un PR sin clon local ahora se guardan por repositorio. Las iteraciones, el seguimiento de hilos y las marcas funcionan igual que en un proyecto, y si después clonas el repositorio, sus revisiones continúan desde ahí.
- **Re-revisiones más claras:** un hallazgo resuelto ahora muestra qué lo resolvió y el código que lo corrige. Los hallazgos nuevos sobre código que no cambió quedan marcados como "tardíos", y el informe trae una sección "Lo que está bien".

### 🐛 Corregido
- **Hilos cerrados por error:** un hallazgo ya no se marca como resuelto (ni se cierra su hilo en el PR) solo porque el modelo no lo repitió. Ahora un revisor tiene que confirmar que está corregido.
- **Índice de conocimiento:** ya no se pierde al usar "Liberar caché" ni con las limpiezas del sistema. "Vaciar índice" conserva los vectores ya calculados, así que no hay que esperar horas para volver a vectorizar. Además, la vectorización ya no se queda trabada con textos muy largos (por ejemplo SVG o base64 incrustados).
- **Clonar repositorios privados:** al clonar o sincronizar, si git no tiene credenciales o el remoto las rechaza, CodeFlow reintenta con la cuenta que conectaste para ese servidor.

### ⚠️ Importante
- Los respaldos hechos con esta versión no se pueden abrir en versiones anteriores de CodeFlow. Los respaldos antiguos se siguen importando sin problema.
