# Ventas por sucursal y por servicio (barras apiladas por mes de cierre)

**Fecha:** 2026-08-04
**Ámbito:** `lib/sales-series.ts` (nuevo), `lib/sales-pivot.ts` (exporta primitivas),
`components/dashboard/sales-by-dimension-chart.tsx` (nuevo),
`components/dashboard/{vaeo,mesh}-dashboard.tsx`, `scripts/verify-sales-pivot.ts`,
`CLAUDE.md`.

## Qué se está construyendo

Los dos gráficos que el cliente hoy tiene en Looker Studio — **"Ventas por Sucursal
VAEO"** y **"Ventas por servicio VAEO"** — como dos tarjetas lado a lado debajo de la
tabla pivote ya existente.

Ambos son la **misma barra apilada**: eje X = mes de la **Fecha de Cierre**, eje Y = suma
del valor monetario de las oportunidades **ganadas** del embudo del panel. Lo único que
cambia entre uno y otro es la dimensión que apila: la **sucursal** del panel
(`Sucursal VAEO` / `Sucursal MESH`) o el **servicio** (`Servicio`, compartido).

Es el mismo agregado que ya calcula `lib/sales-pivot.ts`, en otra forma. Eso es
precisamente el riesgo que este diseño ataca: si el chart y la tabla no cuadran, el panel
se contradice a sí mismo en la misma pantalla.

## El cálculo: `lib/sales-series.ts`

Un módulo puro, sin React, con una sola función:

```ts
export interface SalesSeriesEntry {
  key: string          // valor de la dimensión, p.ej. "MTY Tanarah" | NO_SUCURSAL
  label: string        // lo que se pinta en la leyenda (hoy === key)
  total: number        // total del periodo, para ordenar
}

export interface SalesMonthBucket {
  key: string          // "2026-06" | NO_DATE_KEY
  label: string        // "jun 2026" | "Sin fecha de cierre"
  kind: "month" | "no-date"
  total: number
  /** Valor por serie. Solo trae las series con valor > 0. */
  values: Record<string, number>
  /** Ids por serie — el drill-down se resuelve con esto. */
  oppIds: Record<string, string[]>
}

export interface SalesSeriesData {
  series: SalesSeriesEntry[]   // total desc; "Sin sucursal"/"Sin servicio" al final
  buckets: SalesMonthBucket[]  // meses ascendentes, "Sin fecha de cierre" al final
  grandTotal: number
}

export function buildSalesSeries(
  opps: Opportunity[],
  opts: { dimensionField: string; emptyLabel: string }
): SalesSeriesData
```

**No reimplementa nada.** `isWonOpp`, `closeDateOf` y el bucketing de mes vienen de los
módulos que ya los definen; `sales-pivot.ts` pasa a **exportar** `monthKeyOf` y
`monthLabelOf`, que hoy son privadas. Dos definiciones distintas de "en qué mes cayó esta
venta" es justo el bug que las verify scripts existen para matar — y aquí es sutil, porque
GHL guarda los campos DATE a medianoche **UTC** y leer el mes en hora local mueve un cierre
del día 1 al mes anterior.

`emptyLabel` es `NO_SUCURSAL` o `NO_SERVICIO` según a quién se llame, así que el módulo no
tiene que saber qué dimensión está agregando.

Diferencias de orden respecto al pivote, deliberadas:

- **Series** por total descendente, con la cubeta vacía siempre al final (mismo criterio
  `byTotalDesc` que ya usa el pivote para sus columnas).
- **Buckets**: meses ascendentes y `Sin fecha de cierre` **al final**, no al principio. En
  la tabla esa fila va pinneada arriba porque se lee de arriba hacia abajo; en un eje
  temporal el lugar natural del "resto" es la derecha.

## El componente: `sales-by-dimension-chart.tsx`

Un solo componente montado dos veces, con `dimension: "sucursal" | "servicio"`. Toma el
mismo prop surface que `SalesPivotTable` (incluidos `allOpportunities` y `dateRange`,
porque filtra por fecha de cierre él mismo, no por `createdAt`).

- **Scope:** `scopeOpportunities(allOpportunities, panel, pipelines)` →
  `filterByDateRange(scoped, closeDateOf, dateRange)` → `buildSalesSeries(...)`. Idéntico
  a la tabla, por eso cuadran.
- **Chart:** Recharts `BarChart` apilado (`stackId="v"`) dentro de `ChartContainer`, una
  `<Bar>` por serie, ~300px de alto.
- **Etiqueta del total** arriba de cada barra vía `LabelList` sobre la última serie del
  stack, en formato compacto (`$1.7M`) para que quepa; el monto exacto vive en el tooltip.
- **Eje Y** con el mismo formato compacto. **Tooltip** con `NonZeroTooltipContent`, que ya
  existe justo para que un stack con series en cero no imprima ruido.
- **Estado vacío:** `ChartEmpty`, mismo texto que la tabla.

### Leyenda

Leyenda propia (chips `●  Etiqueta`) renderizada arriba del chart, no la de Recharts —
así se puede truncar y envolver con las clases del panel. **Clic en un chip aísla esa
serie**; clic de nuevo restaura. Es comodidad, no una muleta.

> Este trabajo **elimina de `CLAUDE.md` la regla "no visual encoding that requires a legend
> to decode"**. Una barra apilada la requiere por definición y el cliente pidió calcar el
> reporte que ya usa; la regla estorbaba más de lo que protegía.

### Color estable

El índice de color de cada serie se calcula sobre el set **sin filtrar** del panel (todas
las ganadas del embudo, ordenadas por total desc) y se mapea a `chartPaletteColor(i)`. El
render usa el set filtrado. Así "MTY Tanarah" conserva su color al mover el filtro de
fechas y entre los dos paneles; si se coloreara por el orden del set filtrado, cambiar de
mes recolorearía todo.

El componente hace dos llamadas memoizadas a `buildSalesSeries` — una sobre el set sin
filtrar solo para obtener el orden, otra sobre el filtrado para pintar. El módulo no sabe
nada de colores: eso se queda en la UI.

La cubeta vacía (`Sin sucursal` / `Sin servicio`) **no** toma color de la paleta; va en
gris neutro al final del stack, para que no compita con una sucursal real.

### Cuántas series caben (medido, no opinado)

`CHART_PALETTE` **no sirve para un stack**. Validada con el script de la skill `dataviz`,
falla desde 5 slots: `#8b5cf6` y `#2563eb` quedan a ΔE 12.7 en visión normal — un lector
sin daltonismo no los distingue — y `#335577` cae bajo el piso de croma, o sea lee gris,
que es justo el color reservado para la cubeta vacía.

Se agrega una paleta aparte para estos charts (`SERIES_PALETTE`), sin tocar
`CHART_PALETTE`, que sigue sirviendo a `chat-chart.tsx`. **Cinco tonos**, validados en modo
`--pairs all` (cualquier par de la leyenda, no solo los vecinos del stack) y en los dos
temas contra la superficie real de la tarjeta. El modo oscuro tiene **sus propios pasos**:
los tonos claros caen fuera de la banda de luminosidad sobre fondo oscuro.

Consecuencia: una dimensión con más de cinco valores **pliega su cola en "Otros"**
(gris, distinto del gris de la cubeta vacía). Sucursal VAEO tiene 4 valores y MESH 2, así
que ahí nunca se pliega nada; Servicio tiene ~10 y sí. Qué se pliega se decide **una sola
vez sobre el set sin filtrar** y se le impone a la llamada filtrada (`namedKeys`) — si se
decidiera sobre el set filtrado, un servicio chico en el año pero grande en un mes saldría
de "Otros" al filtrar y repintaría las demás series.

### La barra "Sin fecha de cierre"

Va al final del eje, con el resto de sus segmentos al **55% de opacidad** y su tick del eje
X en `text-muted-foreground`. Se descartó el `ReferenceLine` punteado que se había pensado
para separarla: en un eje categórico Recharts dibuja la línea **por el centro** de la
categoría, no en su frontera, así que atravesaría la barra en vez de separarla.

Nada queda fuera del gráfico: la suma de todas las barras es el `grandTotal` de la tabla.

## Montaje

En `vaeo-dashboard.tsx` y `mesh-dashboard.tsx`, debajo de `SalesPivotTable`:

```tsx
<div className="grid gap-5 md:grid-cols-2">
  <SalesByDimensionChart dimension="sucursal" panel="vaeo" {...shared} />
  <SalesByDimensionChart dimension="servicio" panel="vaeo" {...shared} />
</div>
```

MESH monta exactamente lo mismo con `panel="mesh"`; `PANEL_SCOPES` ya resuelve su pipeline
y su campo de sucursal. MESH deja de renderizar `PanelPlaceholder`.

## Drill-down

Clic en un segmento abre `ChartDrillDrawer` con las oportunidades de ese
(mes × serie), resueltas contra **`allOpportunities`** — nunca contra el slice filtrado,
por la regla de joins del repo. Título `"jun 2026 — MTY Tanarah"`, subtítulo
`"Oportunidades ganadas"`, igual que la tabla.

## Verificación

Se extiende `scripts/verify-sales-pivot.ts` (`pnpm verify:pivot`) — no se crea un script
nuevo, porque lo que hay que probar es que los dos módulos **coinciden**:

1. **Cuadre con el pivote**, la aserción que importa: sobre el mismo input,
   `grandTotal` es idéntico, el total de cada bucket iguala la celda `total` de su fila, y
   el total de cada serie de sucursal iguala la columna de subtotal de esa sucursal.
2. **Mes en UTC**: un cierre en `2026-02-01T00:00:00.000Z` cae en `feb 2026`.
3. **Faltantes**: dimensión vacía → `emptyLabel`; sin fecha → bucket `no-date` al final del
   arreglo, contando para `grandTotal`.
4. **Orden**: series por total desc con la cubeta vacía al final; buckets por mes
   ascendente.
5. **`oppIds`** por (bucket, serie) trae exactamente las oportunidades de esa celda — es lo
   que alimenta el drawer.
6. **Ganadas**: se hereda `isWonOpp`, así que basta una aserción de que una perdida en
   stage "Ganado" no entra.

Más `npx tsc --noEmit`, que es el gate real del repo, y una pasada por la app corriendo
(los charts no se pueden verificar de verdad sin verlos).

## Fuera de alcance

- Exportar estos charts al PDF (`lib/report.ts`) — la tabla tampoco está ahí todavía.
- Exponer la serie a las herramientas del asistente IA.
- Cualquier corte que no sea sucursal o servicio.
