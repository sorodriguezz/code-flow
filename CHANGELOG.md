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
