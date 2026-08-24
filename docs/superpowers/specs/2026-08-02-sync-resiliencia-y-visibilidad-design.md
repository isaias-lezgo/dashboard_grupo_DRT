# Resiliencia y visibilidad del sync del dashboard

**Fecha:** 2026-08-02
**Ámbito:** `lib/ghl-client.ts` (paginación), `app/api/dashboard/route.ts` (frames del
stream), `hooks/fetch-stream.ts` + `hooks/use-dashboard-data.ts` (tipos de estado),
`components/dashboard/loading-screen.tsx`, `app/page.tsx` (banner de datos incompletos).

## El problema

Dos síntomas reportados que resultan ser el mismo defecto visto desde dos lados.

**1. El panel abrió con 0 oportunidades sin avisar de nada.** 14,078 contactos y 3,072
pautas cargados, oportunidades en cero. No es que la sub-cuenta tenga cero: el fetch
murió y no había forma de que el panel lo dijera.

**2. La pantalla de carga se congela sin explicación.** Los contadores se quedan quietos
(contactos 200, oportunidades 100, pautas 100) y el usuario no sabe si sigue trabajando o
ya se murió.

### Causa raíz de (1): `Promise.all` en el abanico de páginas

`getAllOpportunities` (`lib/ghl-client.ts:902`) pide la página 1, lee `meta.total`, y
dispara **todas las páginas restantes de golpe**:

```ts
const rest = await Promise.all(
  Array.from({ length: totalPages - 1 }, (_, i) =>
    getOpportunities({ page: i + 2, limit: pageSize }).then((r) => r.opportunities)
  )
);
```

Con ~14k oportunidades son ~140 peticiones concurrentes. `Promise.all` es todo o nada:
si *una* de las 140 agota sus 5 intentos en `ghlFetch`, la promesa completa se rechaza y
**se descartan las 139 páginas que sí llegaron**. El `.catch` de la ruta
(`app/api/dashboard/route.ts:465`) lo convierte en `[]` y emite
`sendStep("opportunities", "done", 0)`.

`getAllCustomObjectRecords` (pautas, `lib/ghl-client.ts:848`) tiene la misma estructura;
sobrevivió solo porque su abanico es de ~31 páginas en vez de ~140.

`getAllContacts` es un recorrido secuencial por cursor que **acumula**, por eso llegó
completo — pero si truena a mitad del `while`, la excepción se propaga y también pierde
todo lo acumulado. Mismo defecto, distinta forma.

### Causa raíz de (2): el stream solo habla cuando algo tiene éxito

- Solo se emite un frame `step` cuando **aterriza una página**. Durante un cooldown de
  429 (`note429` bloquea todas las peticiones de esa location) o durante el backoff
  exponencial de `ghlFetch` (1s → 2s → 4s → 8s, más jitter), no sale ni un frame. La
  pantalla se queda muerta decenas de segundos sin una sola señal.
- No hay tiempo transcurrido ni noción de "esto ya tardó demasiado".
- **`done` significa dos cosas.** `sendStep("opportunities", "done", 0)` tras un fallo es
  indistinguible de "efectivamente hay 0". Ese es el eslabón exacto por el que un fallo
  total llegó a renderizarse como un dataset vacío legítimo.

### Por qué muere una página — CONFIRMADO

Medido contra la sub-cuenta real de VAEO (`scripts/diag-paged-sync.ts`, 2026-08-02).
**GHL corta la paginación por offset en 10,000 registros.** Las páginas 1-100 responden
normal; de la 101 en adelante (offset ≥ 10,000) siempre devuelven el mismo 400:

```
400 Bad Request
{"code":"SEARCH_USE_START_AFTER_PAGINATION",
 "message":"Please use startAfter and startAfterId for pagination."}
```

Resultado de la medición, ya con la paginación tolerante puesta:

```
opportunities: 10000 de 11793 | missingPages=[101…118] | 26.5s
contacts:      14085 de 14085 | missingPages=[]        | 77.2s
```

Tres consecuencias que reorientan el diseño:

1. **Es determinista, no transitorio.** Ningún reintento lo va a resolver nunca — la
   pasada de reintento de `fanOutPages` falló idéntica. Y como es un 400,
   `ghlFetch` no lo reintenta siquiera (`lib/ghl-client.ts:164`), así que mataba el
   `Promise.all` al primer intento.
2. **Explica exactamente el patrón "solo en cuentas de 10k+"** que reportó el cliente. El
   número no era "muchos registros lo vuelven lento": era literalmente el tope. Por
   debajo de 10,000 oportunidades nunca se llega a la página 101.
3. **La resiliencia sola no basta.** Convierte un fallo catastrófico (0 registros) en uno
   parcial permanente (10,000 de 11,793, perdiendo las mismas 1,793 en cada sync). Mejor,
   pero no suficiente.

Se descartaron por medición, no por razonamiento: timeout de 30s, agotamiento del
rate-limit, y `401 Command timed out`. Ninguno interviene.

### La corrección de fondo: cursor en oportunidades

El propio mensaje de error dice qué usar, y el `meta` de la página 1 ya sirve el cursor:

```json
{ "total": 11793, "startAfterId": "Azz5YxtnPoKdg5ZVfeX9", "startAfter": 1785479202688 }
```

Verificado punta a punta contra la sub-cuenta real (`scripts/probe-opp-cursor.ts`): el
recorrido por cursor **pasa el tope sin inmutarse** (hop 100 = página-offset 101, la
primera que devuelve 400) y termina en **11,793 de 11,793**. Completo.

`getAllOpportunities` migra a `startAfter`/`startAfterId`, el mismo esquema que
`getAllContacts` ya usaba — y que es justo la razón por la que los contactos, con ~14k
registros, nunca fallaron. El costo es que el cursor es inherentemente secuencial: 102s
frente a los 26s del abanico paralelo. En el sync completo eso pesa menos de lo que
parece, porque los contactos ya tardan 77s en paralelo: el sync pasa de ~77s a ~102s.

Se descartó un híbrido (offset en paralelo para los primeros 10,000, cursor para el
resto) que mantendría el sync en ~77s: obliga a mantener dos rutas de paginación y deja
una costura en el registro 10,000 donde un dataset en movimiento puede producir
duplicados o huecos. No vale ese riesgo por 25 segundos.

**`fanOutPages` sigue en uso** para `getAllCustomObjectRecords` (pautas), que hoy va por
offset con ~31 páginas. Si las pautas de alguna sub-cuenta llegaran a 10,000, ese
endpoint podría tener el mismo tope; no se puede comprobar sin una cuenta de ese tamaño,
así que queda anotado como riesgo conocido y la resiliencia lo cubre mientras tanto.

## Diseño

### Capa 1 — Paginación tolerante a fallos (`lib/paged-fetch.ts` + `lib/ghl-client.ts`)

La lógica de abanico + reintento se extrae a un módulo nuevo, `lib/paged-fetch.ts`, con
`fetchPage` inyectado como parámetro. Se extrae en vez de escribirse inline en
`ghl-client.ts` por una razón concreta: así queda libre de red y de framework, y puede
tener su propio `scripts/verify-paged-fetch.ts` con `node:assert/strict`, como
`lib/attachments.ts` y `lib/ghl-limiter.ts`. Este es exactamente el tipo de bug que el
repo reserva para esos scripts — uno que no truena, solo devuelve una respuesta
silenciosamente equivocada.

Se introduce un tipo de resultado compartido para los tres recorridos paginados:

```ts
export interface PagedResult<T> {
  records: T[];
  /** Total que GHL reportó, si lo reportó. */
  total?: number;
  /** Páginas (o tramos del cursor) que no se pudieron traer tras el reintento. */
  missingPages: number[];
  /** Registros que se estiman perdidos: missingPages.length * pageSize, acotado a total. */
  missingEstimate: number;
}
```

**`getAllCustomObjectRecords` (pautas) — abanico tolerante, `fanOutPages`:**

1. Página 1 igual que hoy. Si falla, se propaga (no hay nada que salvar).
2. El resto pasa de `Promise.all` a `Promise.allSettled`. Se absorben las cumplidas y se
   guardan los números de página de las rechazadas.
3. **Reintento por página, una vez.** Si hubo rechazos, se espera una ventana de
   rate-limit (10s — deja que el cooldown expire y el bucket se rellene) y se reintentan
   **solo esas páginas**, otra vez con `allSettled`. Es el "reintentar automáticamente"
   aplicado al nivel más barato: 1 página de 31, no las 31.
4. Devuelve `PagedResult`. Las que sigan fallando quedan en `missingPages`.

**`getAllOpportunities` — recorrido por cursor, `cursorWalk`:** ya no usa `fanOutPages`.
El abanico por offset es irreparable contra el tope de 10,000 (ver arriba), así que pasa
a `startAfter`/`startAfterId`. Comparte implementación con `getAllContacts` a través de
`cursorWalk` en el mismo módulo, para que las dos únicas paginaciones por cursor del
repo no puedan derivar. `missingPages` guarda el número de salto donde se rompió el
recorrido, si se rompió.

**`getAllContacts`:** también pasa por `cursorWalk`, que ya trae el try/catch. Al fallar
un salto se rompe el recorrido, se conserva todo lo acumulado y se marca como parcial
usando `total` (de `meta.total`) para estimar lo perdido. **El cursor no se reintenta**:
al no saber la posición exacta de lo que falta, un reintento traería duplicados o un
tramo arbitrario; más honesto es reportarlo incompleto. Ésa es la diferencia de fondo con
`fanOutPages`, donde cada página es direccionable y sí se puede repetir sola.

`searchLocationTasks` no cambia: pagina secuencialmente con `CAP = 500` por rama y ya
degrada bien.

**Sitios que llaman a estas funciones.** El radio de impacto es chico — fuera de
`lib/ghl-client.ts` solo hay dos llamantes:

- `app/api/dashboard/route.ts` (líneas 233, 460, 470) — se actualiza a `.records` y usa
  `missingPages` para decidir `done` vs `partial`.
- `scripts/diag-otro-pauta.ts:18` — script de diagnóstico; se actualiza a `.records`.

`fetchAllPautas` (`app/api/dashboard/route.ts:219`) envuelve a
`getAllCustomObjectRecords` y hoy devuelve `Pauta[]`. Pasa a devolver
`{ pautas, missingPages, missingEstimate }` para no tragarse la señal de parcialidad que
acaba de ganar la capa de abajo. Su `catch` actual, que devuelve `[]`, pasa a devolver un
resultado marcado como error.

### Capa 2 — El stream deja de mentir (`app/api/dashboard/route.ts`)

`sendStep` gana estados. `StepStatus` pasa de `loading | done` a:

| Estado | Significado |
|---|---|
| `pending` | aún no arranca (solo lado cliente) |
| `loading` | trayendo datos |
| `retrying` | falló algo y se está reintentando |
| `done` | completo y correcto |
| `partial` | trajo datos pero se sabe que faltan (`missingPages` no vacío) |
| `error` | no trajo nada |

**Reintento a nivel dataset.** Si tras la capa 1 un dataset quedó en cero registros
(falló hasta la página 1), la ruta lo reintenta **una vez completo**, emitiendo
`sendStep(key, "retrying")` antes. Ocurre dentro del mismo stream NDJSON, antes de mandar
el frame `data`, así que **no hace falta ningún endpoint nuevo**. Si el reintento
tampoco trae nada, el paso queda en `error`.

**Sin heartbeat.** Se consideró un frame `{ type: "heartbeat", elapsedMs }` cada 5s para
dar señal de vida durante los cooldowns. Se descartó: un `setInterval` de 1s en el hook
del cliente produce el mismo tiempo transcurrido y la misma detección de atasco, sin
frame nuevo, sin manejar un intervalo dentro del `ReadableStream`, y sin el riesgo de que
siga disparando `controller.enqueue` después de que el navegador aborte. Lo único que el
heartbeat distinguía —"servidor vivo esperando a GHL" vs "servidor colgado"— no cambia el
mensaje al usuario, y una conexión realmente muerta ya la cubre el rechazo de
`fetchStream` → `isError`.

**Warnings en el payload.** El frame `data` lleva:

```ts
warnings: Array<{
  key: StepKey;
  kind: "partial" | "error";
  loaded: number;
  expected?: number;
}>
```

### Capa 3 — La UI reporta con honestidad

**`hooks/fetch-stream.ts`** — `StreamStep.status` se amplía al nuevo union.

**`hooks/use-dashboard-data.ts`** — `StepState.status` se amplía igual. Un
`setInterval` de 1s, activo solo mientras `isLoading`, alimenta dos valores nuevos:
`elapsedMs` (desde que arrancó el sync) y `stalled: boolean` (`true` cuando han pasado
>15s desde el último frame `step`).

**`components/dashboard/loading-screen.tsx`**

- Fila en ámbar con la etiqueta "reintentando…" para `retrying`; en ámbar con "parcial"
  para `partial`; en rojo con "error" para `error`. Los tres estados terminales cuentan
  para el porcentaje de la barra (el sync sí avanzó), pero el ícono no es la palomita.
- Tiempo transcurrido junto al porcentaje (`m:ss`).
- Cuando `stalled`, se sustituye la línea de progreso por
  **"GHL está limitando las solicitudes — esto puede tardar unos minutos"**. Éste es
  exactamente el hueco de la primera captura: contadores congelados sin ninguna señal.

**`app/page.tsx`** — banner ámbar bajo el header cuando `data.warnings` no viene vacío.
Nombra el dataset y las consecuencias, p. ej. *"No se pudieron cargar las oportunidades.
Las gráficas de ventas están vacías o incompletas."* Para `partial` incluye los números:
*"Se cargaron 13,900 de ~14,078 oportunidades."* Botón **Reintentar** cableado al
`refresh()` que ya existe. El banner es descartable dentro de la sesión pero reaparece en
cada sync que vuelva a producir warnings.

## Manejo de errores

- Un dataset en `error` **no bloquea el panel**: se entra con lo que sí cargó. Se
  descartó bloquear porque el resto de la información sigue siendo útil, y el banner
  elimina el riesgo real, que era confundir un fallo con un cero legítimo.
- El `.catch` por dataset de la ruta se conserva: un dataset caído nunca tumba el sync
  completo. Lo que cambia es que ahora emite `error` en vez de `done, 0`.
- Los `console.error` existentes se mantienen — son la única traza de la causa
  subyacente. Se añade el número de página a los mensajes de páginas fallidas para que el
  log diga *cuál* falló, no solo que algo falló.

## Verificación

No hay framework de tests en el repo y no se adopta uno. Siguiendo su convención:

- **`scripts/verify-paged-fetch.ts`** (nuevo, `pnpm verify:paged`) — cubre el bug que
  originó todo esto: con `fetchPage` falso, que una página que falla permanentemente
  **conserve** las demás; que una que falla y luego funciona se recupere en el reintento;
  que el dedupe aguante páginas solapadas; y que `missingEstimate` quede acotado por
  `total`.
- `npx tsc --noEmit` — obligatorio. `next build` ignora errores de TS y este cambio
  modifica tipos de retorno usados en varios sitios, que es justo donde un error se
  escaparía sin ser visto.
- Manejo real de la app contra la sub-cuenta de VAEO, que es donde el fallo se reproduce:
  confirmar que las oportunidades ahora llegan (o llegan parciales con banner), y leer el
  log `[GHL]` para identificar por fin cuál de los cuatro candidatos es la causa.

## Fuera de alcance

- Cambiar el ritmo del limiter o el timeout por petición. Ambos se descartaron por
  medición: la causa es un 400 determinista, no latencia ni presupuesto.
- Migrar `getAllCustomObjectRecords` (pautas) a cursor. Va por offset con ~31 páginas y
  no se acerca al tope; migrarlo ahora sería especular sobre un límite que no podemos
  medir sin una sub-cuenta con 10,000+ pautas.
- Cachear o persistir el resultado del sync entre recargas.
