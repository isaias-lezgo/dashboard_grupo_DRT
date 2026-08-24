# Vigilancia de actividad de asesoras: matriz de oportunidades sin atención + rezago de tareas

Fecha: 2026-08-06
Estado: diseño aprobado para implementar

## El problema

Los paneles miden **resultados** (ventas cerradas, win rate, motivos de perdido) y
**distribución** (origen, canal, asesor × etapa), pero ninguno responde la pregunta que
el cliente hace de verdad: *¿las asesoras están trabajando los leads que tienen?*

Un lead puede llevar dos meses parado en "Lead en proceso" sin que nada en el panel lo
delate: cuenta como oportunidad abierta en el gráfico de estado, aparece en su celda de
`advisor-stage-table`, y ahí se queda. El abandono es invisible por construcción — las
tablas actuales miden el **estado** de una oportunidad, nunca su **antigüedad sin
atención**.

Este diseño agrega dos gráficos que sí lo miden:

1. **"Oportunidades sin atención"** — matriz cruzada de días sin mover la oportunidad ×
   días sin mensaje saliente.
2. **"Tareas pendientes por asesor"** — barras apiladas de vencidas / hoy / próximos 7
   días / más adelante.

Ambos viven junto a `AdvisorStageTable`, que ya es el bloque "asesoras" del panel.

---

## Reconocimiento de datos (medido contra `uDQiMzx1Iclb6gbJNRDY`, 2026-08-06)

| | Valor |
|---|---|
| Oportunidades abiertas, pipeline VAEO | 535 |
| Oportunidades abiertas, pipeline MESH | 36 |
| Conversaciones en la sub-cuenta | 12 054 |
| Conversaciones cuyo último mensaje es **entrante** | 845 (7,0 %) |

Cuatro hechos determinan el diseño.

### 1. `updatedAt` no sirve para medir movimiento

Muestra real de la pipeline VAEO:

```
createdAt  2026-08-06T17:59:52Z
updatedAt  2026-08-06T18:07:43Z   ← nadie la tocó; fue una automatización
lastStageChangeAt   2026-08-06T17:59:52Z
lastStatusChangeAt  2026-08-06T17:59:52Z
```

La cuenta corre flujos de Make y un bot de WhatsApp (hay tags `stop bot`,
`mandar perdido no esta interesado bot`), y cada escritura de esos flujos empuja
`updatedAt`. Un gráfico basado en `updatedAt` reportaría que todo se está trabajando.

**`lastStageChangeAt` es la señal honesta**: solo cambia cuando alguien mueve la
oportunidad de etapa.

### 2. Esos campos ya llegan al navegador, pero sin tipar

`transformOpportunity()` hace `...ghl`, así que `lastStageChangeAt` y
`lastStatusChangeAt` viajan en el payload hoy mismo. Faltan solo en las interfaces
`GHLOpportunity` (`lib/ghl-client.ts`) y `Opportunity` (`lib/types.ts`). No hay trabajo
de backend.

### 3. El dataset de mensajes que ya carga el panel NO puede responder esto

`app/api/dashboard-messages/route.ts` trae las últimas **30 conversaciones por usuario**
(~270 de 12 054), 50 mensajes cada una. La ausencia de un contacto en ese conjunto no
prueba silencio: prueba que no entró en la muestra. Concluir "no le han escrito" desde
ahí es exactamente el error que la regla numerada de `lib/ai-context.ts` prohíbe al
asistente, y sería peor en un gráfico, donde no hay lenguaje que lo matice.

### 4. `/conversations/search` no expone la fecha del último saliente — pero se deriva

El registro de conversación trae `lastMessageDate`, `lastMessageDirection`,
`lastManualMessageDate` y `lastOutboundMessageAction`, pero **ninguna fecha de "último
mensaje saliente"**. `lastManualMessageDate` no lo es: en la muestra vino igual a
`lastMessageDate` en una conversación cuyo último mensaje era entrante, o sea que cuenta
manuales en ambas direcciones.

Dos observaciones lo resuelven sin fuerza bruta, y son la base del algoritmo de la
sección siguiente:

- Si la conversación **termina en saliente**, `lastMessageDate` *es* la fecha del último
  saliente. Cubre el 93 % de los casos, gratis.
- El último saliente es siempre **≤** el último mensaje. Luego, si una conversación lleva
  70 días muda, el contacto lleva ≥70 días sin saliente y cae en la cubeta más profunda
  sin necesidad de abrir el hilo.

---

## Decisiones tomadas con el cliente

| Pregunta | Decisión | Nota |
|---|---|---|
| ¿Qué cuenta como "se le mandó un mensaje"? | **Cualquier saliente**, manual o automático | Se descartó "solo manual" a sabiendas. Ver *Riesgos*. |
| Forma del gráfico 1 | Matriz cruzada con mapa de calor | Sobre dispersión y sobre barras por asesor |
| ¿Respeta el filtro global de fechas? | **No**, ninguno de los dos | "Sin atención en 60 días" y "vencida" son condiciones de hoy, no de un periodo |
| Universo de la matriz | Abiertas, sin Ganado / Perdido / Cliente Futuro | Cliente Futuro es un estacionamiento deliberado: ahí el silencio es la intención |
| Forma del gráfico 2 | Barras apiladas por asesor | Sobre barras por cubeta y sobre tarjetas KPI |
| Alcance de las tareas | Por el pipeline de las oportunidades del contacto | Las tareas de GHL no traen `opportunityId` |

---

## Diseño — Gráfico 1: "Oportunidades sin atención"

### Nueva ruta: `app/api/conversation-activity/route.ts`

Stream NDJSON, cargado en segundo plano igual que `dashboard-messages`: fuera de la ruta
crítica, el panel pinta primero. Como toda ruta que toca GHL, pasa por `requireClient()`
y `withClient()`, y **entra al contexto dentro del callback `start()`** del
`ReadableStream`, no alrededor del handler — el stream sobrevive al return.

Payload final: `{ activity: Array<{ contactId, lastOutboundAt: string | null }>, meta }`.

Algoritmo:

1. **Paginar** `/conversations/search` con `sortBy=last_message_date`, `sort=desc`,
   `status=all`, `limit=100`, cursor `startAfterDate` = el `sort[0]` del último documento
   de la página anterior.
2. **Cortar** en cuanto una conversación tenga `lastMessageDate < now − HORIZONTE`, con
   `HORIZONTE = 60 días` (la frontera de la cubeta más profunda). Estimado ~20 páginas.
3. Por conversación:
   - `lastMessageDirection === "outbound"` → `lastOutboundAt = lastMessageDate`.
   - `=== "inbound"` → abrir el hilo con `getMessages(convId, { limit: 50 })` y tomar el
     `createdAt` del saliente más reciente **que no sea actividad de sistema** (`kind !==
     "activity"` según `ghl-message-mapper.ts`; un chip de "oportunidad creada" no es un
     mensaje a nadie). Si el hilo no tiene ningún saliente → `null`.
4. Un contacto con varias conversaciones (WhatsApp + email) se queda con el
   `max(lastOutboundAt)`.
5. Todo lo que no aparezca en el resultado — contacto sin conversación, o conversación
   fuera del horizonte — se trata como `null` en el cliente, que es la cubeta 60+. Es
   correcto por la observación 4.2, no una aproximación.

Concurrencia acotada al abrir hilos (el mismo patrón de `dashboard-messages`,
`CONCURRENCY = 6`), y dedupe por id de conversación para cubrir empates de
`lastMessageDate` en el cursor.

Hook cliente `hooks/use-conversation-activity.ts` sobre `fetch-stream.ts`, montado en
`app/page.tsx` junto a `useConversationsData`, y pasado a los dos paneles como
`conversationActivity` + `activityStatus: "loading" | "ready" | "error"`.

### Módulo puro: `lib/stale-opportunity-matrix.ts`

```ts
buildStaleMatrix(
  opportunities: Opportunity[],
  lastOutboundByContact: Map<string, string | null>,
  now: Date
): StaleMatrix
```

- **Universo**: `status === "open"`, excluyendo por **nombre de etapa**,
  case-insensitive, nunca por id (`/ganad[oa]|\bwon\b/i`, `/perdid/i`,
  `/cliente\s+futuro/i`) — la misma regla que ya sigue `isWonOpp()`. Una oportunidad con
  `status: "open"` parada en la etapa "Ganado" es una venta, no un lead abandonado.
- **Eje de movimiento**: días entre `lastStageChangeAt ?? createdAt` y `now`.
- **Eje de mensajes**: días entre `lastOutboundByContact.get(contactId)` y `now`; `null`
  o ausente → cubeta más profunda.
- **Cubetas**, idénticas en ambos ejes: `0-7 | 8-15 | 16-30 | 31-60 | 60+`.
- Cada celda conserva sus `Opportunity[]` para el drill-down.
- Salida: `{ rows, colTotals, grandTotal }`, con totales por fila y columna.

Verificado por `scripts/verify-stale-matrix.ts` (`pnpm verify:stale-matrix`), con
`node:assert/strict` y `main().catch(...)` — el paquete es CommonJS y `tsx` compila a CJS,
donde el `await` de nivel superior falla.

Casos que el script debe cubrir: fronteras exactas de cubeta (7/8, 60/61), oportunidad
sin `lastStageChangeAt`, contacto sin entrada en el mapa, contacto con entrada `null`,
exclusión de las tres etapas por nombre en sus dos grafías (`Lead Perfilado` /
`Lead perfilado`, `Ganado`, `Cliente Futuro`), y que la suma de las celdas cuadre con
`grandTotal`.

### Componente: `components/dashboard/stale-opportunity-matrix.tsx`

Tarjeta de ancho completo, montada en los dos paneles con solo `panel` distinto. Su
superficie de props es la de los demás gráficos por oportunidad, así que entra en el
objeto `shared` que ya arman `vaeo-dashboard.tsx` y `mesh-dashboard.tsx`, más las dos
props nuevas de actividad.

Idioma visual de `advisor-stage-table` y `lost-reason-matrix`, con dos diferencias
deliberadas:

- **El sombreado se normaliza sobre toda la matriz**, no por columna. En
  `advisor-stage-table` la normalización por columna existe porque las etapas tienen
  órdenes de magnitud distintos; aquí las dos dimensiones son la misma escala de días y
  la comparación que importa es entre celdas.
- **El cuadrante crítico** (ambas cubetas ≥31 días) lleva un fondo rojizo tenue que lo
  delimita. Es la única codificación posicional; la intensidad por conteo sigue siendo
  neutra, para no montar dos escalas de color en la misma celda.

`ScopePill` explicando, sin eufemismos: solo oportunidades abiertas del embudo vivo,
**ignora el filtro de fechas**, "movimiento" = cambio de etapa (no cualquier edición), y
"mensaje" = cualquier saliente, incluidos los automáticos.

Drill-down por celda con `chart-drill-drawer.tsx`, resolviendo joins contra los sets
`all*` sin filtrar, como el resto del panel.

### Estados de carga — el riesgo número uno

El dataset de conversaciones llega después del render. Si la matriz se pintara con el
mapa vacío, **todas** las oportunidades caerían en la columna 60+ y el gráfico afirmaría
un abandono total. Es el peor modo de fallo posible: alarmante, verosímil y falso.

Por eso la tarjeta **no renderiza la matriz** hasta que `activityStatus === "ready"`:

- `"loading"` → esqueleto con el texto "Cargando actividad de conversaciones…".
- `"error"` → estado de error explícito con botón de reintentar. Nunca ceros, nunca una
  matriz parcial.

---

## Diseño — Gráfico 2: "Tareas pendientes por asesor"

### Módulo puro: `lib/task-backlog.ts`

```ts
buildTaskBacklog(
  tasks: Task[],
  scopedOpportunities: Opportunity[],
  now: Date,
  timeZone: string
): TaskBacklog
```

- Solo `status === "pending"`. Las completadas no son rezago.
- Cubetas por `dueDate` contra hoy **en `America/Mexico_City`**: `Vencidas` (antes de
  hoy) / `Hoy` / `Próx. 7 días` / `Más adelante`, más `Sin fecha` para las que no traen
  `dueDate`. El servidor corre en UTC en Vercel; sin la zona, una tarea que vence hoy a
  las 18:00 local se lee como vencida.
- Asesor desde `assignedToName`; sin asignar → `Sin asesor`.
- Salida: filas por asesor con el conteo por cubeta, más el conjunto `unscoped` de la
  sección siguiente.

Verificado por `scripts/verify-task-backlog.ts` (`pnpm verify:task-backlog`): fronteras de
día en `America/Mexico_City` (una tarea a las 23:59 hora local del día de hoy no está
vencida aunque su ISO caiga en el día UTC siguiente), tarea sin `dueDate`, tarea sin
asesor, y el reparto del join de la sección siguiente.

### Alcance por panel

Las tareas de GHL traen `contactId` pero **no** `opportunityId` (verificado en
`GHLTask`). El join va contacto → sus oportunidades → pipeline, contra el conjunto de
oportunidades **ya filtrado** por los filtros globales, de modo que sucursal, asesor,
origen y canal funcionan sin código adicional.

- Un contacto con oportunidades en las dos líneas pone su tarea en los dos paneles — la
  misma regla que CLAUDE.md ya fija para contactos compartidos.
- Un contacto **sin ninguna oportunidad** no es atribuible a una línea. Sus tareas van en
  una línea aparte bajo el gráfico (`N tareas de contactos sin oportunidad`, con
  drill-down), fuera del agregado. No se tiran: es la misma regla de la tarjeta de
  contactos sin oportunidad.

Ignora el filtro global de fechas, igual que la matriz.

### Componente: `components/dashboard/task-backlog-chart.tsx`

Barras horizontales apiladas por asesor, `SERIES_NEUTRALS` para las cubetas de tiempo
(cinco tonos, dentro del límite). `Sin fecha` y `Sin asesor` llevan la **etiqueta** en el
rojizo de `MISSING_TEXT`, pero la barra y el segmento apilado en gris — ahí el color
codifica datos.

Leyenda propia fuera del `ChartContainer`, con `id` en el contenedor y el mismo
`data-chart` en el bloque de chips, según el patrón de `sales-by-dimension-chart`; las
variables `--color-<slot>` viven bajo ese selector. Sin `ResponsiveContainer` anidado:
`ChartContainer` ya trae uno. `NonZeroTooltipContent` y drill-down por segmento.

### Bug latente que se cierra de paso

`searchLocationTasks` (`lib/ghl-client.ts`) tiene `CAP = 500` **por estado**. Si la
sub-cuenta pasa de 500 tareas pendientes, la paginación se detiene y el gráfico subcuenta
en silencio: un gráfico de rezago que da una respuesta tranquilizadora y falsa.

`paginateTasks` pasa a informar si se detuvo por el tope, y la ruta `dashboard` emite el
paso `tasks` con `status: "partial"`. La maquinaria de aviso ya existe entera — el frame
`step`, el `warnings[]` del frame `data` y el banner ámbar de
`sync-warning-banner.tsx` — así que es un cambio pequeño.

---

## Ubicación en el panel

Los tres gráficos que hablan de asesoras quedan juntos, en este orden:

```
AdvisorStageTable          ¿quién tiene qué, y en qué etapa?
StaleOpportunityMatrix     ¿qué está abandonado?
TaskBacklogChart           ¿qué está atrasado?
```

Idénticos en VAEO y MESH, con solo `panel` distinto.

---

## Riesgos y límites conocidos

**El eje de mensajes puede resultar plano.** Con "cualquier saliente" y un bot de
WhatsApp activo en la cuenta, es posible que casi ningún lead se vea callado y la matriz
degenere en su primera columna, midiendo de hecho solo el movimiento de etapa. El cliente
eligió esta definición a sabiendas. Si al ver datos reales ocurre, cambiar a
`lastManualMessageDate` — o a "último saliente manual" derivado del hilo — es un cambio de
una línea en el derivador de la ruta, y las cubetas y el componente no se tocan.

**El cursor de conversaciones puede saltar empates.** `startAfterDate` es un cursor por
valor de `sort`; dos conversaciones con el mismo `lastMessageDate` al milisegundo podrían
perderse o repetirse en el corte de página. El dedupe por id cubre la repetición; la
pérdida sería de una conversación aislada y movería un lead una cubeta. Aceptado.

**El horizonte de 60 días acopla la ruta a las cubetas.** Si algún día se agrega una
cubeta de 90 días, hay que subir `HORIZONTE` en la ruta o el gráfico mentirá. Va como
constante exportada y comentada en ambos lados.

**`lastStageChangeAt` no distingue quién movió la oportunidad.** Si un flujo de Make
cambia etapas automáticamente, el eje de movimiento hereda el mismo ruido del que se
acusa a `updatedAt`. No se observó en el reconocimiento, pero conviene revisarlo contra
datos reales antes de dar el gráfico por bueno.

## Fuera de alcance

- Alertas, notificaciones o cualquier acción sobre los leads abandonados. Los dos
  gráficos solo miden.
- Exportación a PDF de estas dos secciones (`lib/report.ts`). Se puede agregar después;
  hoy el presupuesto de tokens de `analyze-report` está dimensionado a las secciones
  actuales.
- Exponer la actividad de conversación al asistente de IA. El asistente sigue exento de
  los filtros del panel y trabaja con el dataset que ya tiene.
