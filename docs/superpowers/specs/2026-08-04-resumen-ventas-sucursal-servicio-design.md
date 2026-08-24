# Resumen de ventas por sucursal y servicio (primer chart de VAEO)

**Fecha:** 2026-08-04
**Ámbito:** `app/api/dashboard/route.ts` (resolución de campos DATE), `lib/panel-scope.ts`
(nuevo), `lib/sales-pivot.ts` (nuevo),
`components/dashboard/sales-pivot-table.tsx` (nuevo), `app/page.tsx` (prop `dateRange`),
`components/dashboard/{vaeo,mesh}-dashboard.tsx`, `scripts/verify-sales-pivot.ts` (nuevo).

## Qué se está construyendo

La primera gráfica del panel VAEO: una **tabla pivote de ventas cerradas**, calcada del
reporte "Resumen general ventas VAEO" que el cliente hoy tiene en Looker Studio.

- **Filas:** mes/año de la **Fecha de Cierre** de la oportunidad.
- **Columnas:** dos niveles — primero **Sucursal**, dentro de cada sucursal el **Servicio**.
- **Métrica:** suma del valor monetario de la oportunidad.

El mismo componente sirve al panel MESH sin cambios; lo único que varía es el pipeline y
el campo de sucursal (ver *Alcance de panel*).

## Los datos reales

Verificado contra la sub-cuenta de producción (`uDQiMzx1Iclb6gbJNRDY`, "Grupo VAEO") el
2026-08-04. Ambos pipelines viven en la misma sub-cuenta, así que el sync los trae juntos
y el corte es client-side.

| Pipeline | id | Total | Ganadas |
|---|---|---|---|
| VAEO | `MiATYfkJWklaXqYc7hOr` | 11,227 | 648 |
| MESH | `DkZiRWdizgMRt7osjuRb` | 674 | 42 |

Los tres campos que alimentan la tabla son **custom fields de oportunidad**, no de
contacto:

| Campo | id | Tipo | Relleno en ganadas VAEO |
|---|---|---|---|
| `Fecha de Cierre` | `HKCsyPAL0NeTAoIrVDl4` | DATE | 645 / 648 (99.5%) |
| `Sucursal VAEO` | `i7V75YULXbXZPDru3sfm` | SINGLE_OPTIONS | 641 / 648 |
| `Sucursal MESH` | `0QXhFRe8E0zaVdmV2oo7` | SINGLE_OPTIONS | — (aplica al panel MESH) |
| `Servicio` | `7NFprKdjURn7Vlm88xpM` | SINGLE_OPTIONS | **275 / 648 (42%)** |

`monetaryValue` (nativo) está en 646 / 648, sumando **$9,237,003** en ganadas VAEO.

Opciones de cada catálogo:

- **Sucursal VAEO:** MTY Tanarah (115 ganadas), MTY Calzada del Valle (90),
  QRO Central Park (258), SLP Covalia (178).
- **Sucursal MESH:** MTY Varzor, QRO Central Park.
- **Servicio:** Linea Personal, Coworking, Oficinas Privado, Sala de Juntas,
  Oficinas Virtuales, Dom. fiscal y Com., Day pass, Oficina por hora, VAEO Flex,
  Sala de Juntas Mezzanine.

Existe además un campo `Producto` (`3Sro4xlcCVoyuuKwalaP`, opciones VAEO / MESH) que
duplica la señal del pipeline (646 de 648 ganadas del pipeline VAEO dicen "VAEO").
**No se usa** — el pipeline es la fuente de verdad del panel, y meter una segunda señal
solo abre la puerta a que los dos discrepen.

> El Looker del cliente suma $4.7M contra los $9.2M del pipeline completo. Trae otro
> rango o filtra sucursales; **no esperes que los números cuadren contra esa captura.**

### Hallazgo 1: los campos DATE se están descartando hoy

`resolveCustomFields()` (`app/api/dashboard/route.ts:57`) lee
`f.fieldValue ?? f.fieldValueString ?? f.value`. Los campos DATE de oportunidad **no usan
ninguno de esos** — llegan como `fieldValueDate` con un epoch en milisegundos:

```json
{ "id": "tVPJIfhEiqyFXtYc6oTv", "fieldValueDate": 1785801600000, "type": "date" }
```

Resultado: hoy **ningún campo de fecha llega al browser**. Es un prerrequisito, no un
detalle de esta tabla — afecta a `Fecha de Cierre` y a `Fecha de Creación` por igual.

### Hallazgo 2: no existe "won on" en la API

La oportunidad no expone un `wonAt`. Lo más cercano es `lastStatusChangeAt` (presente en
el 100%), pero en los datos importados miente por semanas: hay cierres de julio con
`lastStatusChangeAt` del 1° de agosto, cuando se corrió la importación. **Se descarta como
fallback**: las 3 ganadas sin Fecha de Cierre van a una fila "Sin fecha de cierre" y ya.

### Hallazgo 3: el hoyo es `Servicio`, no la fecha

373 de 648 ganadas (58%) no tienen Servicio capturado. Se muestran en una columna
**"Sin servicio"** dentro de su sucursal: el dinero nunca se pierde de la tabla, y el hueco
de captura queda visible por sucursal — que para VAEO es información accionable, no ruido.

## Decisiones

| Decisión | Elegido | Por qué |
|---|---|---|
| Alcance | Solo ganadas (`isWonOpp()`) | Es un reporte de ventas; mezclar abiertas o perdidas hace que el total deje de ser ingreso |
| Servicio vacío | Columna "Sin servicio" por sucursal | Preserva el total y expone dónde falla la captura |
| Filtro de fecha global | Aplica, medido sobre **Fecha de Cierre** | Coherente con el resto del panel; sin esto la tabla crece sin techo |
| Sin Fecha de Cierre | Fila "Sin fecha de cierre" arriba | Sin aproximaciones inventadas (ver Hallazgo 2). Replica la fila `null` del Looker |
| Ancho | Pivote completo con scroll horizontal | Fidelidad al reporte que el cliente ya conoce y lee |

### Alternativas de ancho consideradas y rechazadas

Con 4 sucursales × ~9 servicios + "Sin servicio" + subtotales son ~45 columnas (~4,000px),
así que el ancho era la decisión de diseño real.

- **Sucursal expandible** (colapsada a mes × 4 sucursales, click para abrir servicios).
  Entra sin scroll y da el resumen gratis, pero esconde por default justo el desglose que
  el cliente hoy lee de corrido.
- **Selector de sucursal** (dropdown + tabla mes × servicio). Nunca scrollea, pero mata la
  comparación entre sucursales, que es lo que hace valiosa la tabla.

Se eligió el pivote completo: el usuario ya vive con esta tabla en Looker y la lee
scrolleando. Replicarla evita retraducir un reporte que ya está en su cabeza.

## Arquitectura

### 1. `resolveCustomFields()` — prerrequisito

Agregar `fieldValueDate` a la cadena de fallbacks y normalizar el epoch-ms a ISO 8601, de
modo que `customFieldsResolved` siga siendo `Record<string, string | string[]>` y ningún
consumidor tenga que saber que el campo era una fecha.

**Los DATE de GHL vienen en medianoche UTC** (`1785801600000` = `2026-08-01T00:00:00Z`).
El bucketing a mes usa getters **UTC** (`getUTCFullYear` / `getUTCMonth`), nunca locales:
con hora de México un cierre del 1° de agosto se dibujaría en julio.

### 2. `lib/panel-scope.ts` — alcance de panel

Materializa la regla ya documentada en CLAUDE.md ("el pipeline ES la línea de negocio").
Es el primer consumidor, así que este chart establece el helper.

```ts
export type PanelId = "vaeo" | "mesh"

export const PANEL_SCOPES: Record<PanelId, {
  label: string
  pipelineId: string      // respaldo
  sucursalField: string   // "Sucursal VAEO" | "Sucursal MESH"
}>

export function resolvePipelineId(pipelines: Pipeline[], panel: PanelId): string
export function scopeOpportunities(opps: Opportunity[], panel: PanelId, pipelines: Pipeline[]): Opportunity[]
```

`resolvePipelineId` busca el pipeline **por nombre** (case-insensitive) en el array
`pipelines` que ambos dashboards ya reciben, y cae al id hardcodeado si no lo encuentra.
Mismo criterio que `isWonOpp()` aplica a los stages: el nombre sobrevive a un pipeline
recreado, el id no.

### 3. `lib/sales-pivot.ts` — el agregado

Puro, sin React, testeable por script.

```ts
export interface PivotCell { value: number; oppIds: string[] }
export interface PivotColumn { sucursal: string; servicio: string; kind: "cell" | "subtotal" | "total" }
export interface PivotRow { key: string; label: string; cells: PivotCell[]; kind: "month" | "no-date" | "total" }
export interface SalesPivot { columns: PivotColumn[]; rows: PivotRow[] }

export function buildSalesPivot(opps: Opportunity[], opts: { sucursalField: string }): SalesPivot
```

Reglas de armado:

- Filtra con `isWonOpp()` (fuente única de verdad de "ganada" — no re-inlinear).
- Sucursal: `customFieldsResolved[sucursalField]`; vacío → cubo **"Sin sucursal"**.
- Servicio: `customFieldsResolved["Servicio"]`; vacío → columna **"Sin servicio"**.
- Mes: `Fecha de Cierre` en UTC → clave `YYYY-MM`; ausente → fila **"Sin fecha de cierre"**.
- **Orden de columnas:** sucursales por valor total desc, "Sin sucursal" al final. Dentro
  de cada sucursal, los servicios siguen un **orden global** (por valor total del panel,
  no por el de esa sucursal) y solo aparecen los que tienen valor ahí; "Sin servicio"
  siempre cierra el grupo. El orden global es lo que hace comparables las posiciones entre
  grupos. Cada grupo termina en su **Subtotal**; la tabla cierra con **Total**.
- **Orden de filas:** "Sin fecha de cierre" fija arriba, meses ascendentes (solo los que
  tienen datos), fila **Total** al final.
- Cada celda guarda los `oppIds` que la componen, para el drill-down.

### 4. `components/dashboard/sales-pivot-table.tsx` — solo pinta

- `ChartCardHeader` + `ScopePill` con la regla: "Solo ganadas · por Fecha de Cierre".
- Un `div` plano con `overflow-x-auto`. **Nada de Radix `ScrollArea`** (rompe `truncate`),
  y no se anida un contenedor con scroll vertical dentro de la card.
- Header de dos niveles `sticky top-0`; columna de mes `sticky left-0` con fondo opaco.
- Cero se dibuja `–` en tono tenue; moneda con
  `Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 0 })`.
- Toda celda es clickeable — celdas, subtotales y totales — y abre `chart-drill-drawer`
  con las oportunidades que la componen. Los contactos se resuelven contra
  **`allContacts`**, no contra el slice filtrado (regla de drill-downs de CLAUDE.md).

### 5. `app/page.tsx` — el filtro de fecha

`dateRange` ya se calcula en `app/page.tsx:61`. Se pasa como prop nuevo a **ambos**
dashboards, para mantener las listas de props espejeadas.

La tabla **ignora el prop `opportunities`** (viene filtrado por `createdAt`) y filtra
`allOpportunities` por Fecha de Cierre. Se reutiliza `filterByDateRange(opps, o =>
fechaDeCierre(o), dateRange)`, cuyo comportamiento heredado es no descartar registros sin
fecha — exactamente lo que queremos: la fila "Sin fecha de cierre" sobrevive a cualquier
filtro, en vez de desaparecer sin dejar rastro.

## Verificación

`scripts/verify-sales-pivot.ts` + `pnpm verify:pivot`, con `node:assert/strict` como los
demás scripts. Cubre:

1. **Bucketing UTC en el borde de mes** — un cierre a medianoche UTC del día 1 cae en su
   mes, no en el anterior.
2. **Cubos vacíos** — sucursal ausente → "Sin sucursal"; servicio ausente → "Sin servicio".
3. **Exclusión de no-ganadas** — abiertas, perdidas y abandonadas no suman; una en stage
   "Ganado" con `status: "open"` sí suma (vía `isWonOpp()`).
4. **Cuadre** — subtotales por sucursal, fila Total y total general contra la suma cruda.
5. **Orden** — "Sin fecha de cierre" primero, meses ascendentes, Total al final;
   "Sin servicio" al cierre de cada grupo.

Recordatorio del repo: el paquete es CommonJS, así que `tsx` compila a CJS y el
`await` de nivel superior falla. Envolver en `main()` y llamar `main().catch(...)`.

`npx tsc --noEmit` es obligatorio — `next build` ignora errores de TypeScript.

Lo visual (sticky headers, scroll horizontal, drawer) se verifica manejando la app real.

## Fuera de alcance

- Conteo de oportunidades como métrica alterna (la tabla es solo dinero).
- Comparativos contra periodo anterior o % de crecimiento.
- Exportación a PDF de esta tabla — llega cuando el panel tenga varias secciones.
- La tarjeta de "Contactos sin oportunidad" documentada en CLAUDE.md: es otro chart.
