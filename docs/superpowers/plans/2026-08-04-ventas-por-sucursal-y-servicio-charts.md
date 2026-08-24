# Ventas por sucursal y por servicio — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Montar en los paneles VAEO y MESH dos barras apiladas por mes de Fecha de Cierre —
una apilada por sucursal, otra por servicio — que cuadren exactamente con la tabla pivote
que ya existe.

**Arquitectura:** Un módulo puro nuevo (`lib/sales-series.ts`) reutiliza las primitivas de
`lib/sales-pivot.ts` (`isWonOpp`, `closeDateOf`, bucketing de mes en UTC) y devuelve series
+ buckets listos para graficar. Un solo componente de React
(`sales-by-dimension-chart.tsx`) se monta dos veces por panel, cambiando solo la dimensión.
El cuadre contra `buildSalesPivot` se asegura con aserciones en el verify script existente.

**Tech Stack:** Next 16 (App Router), React, TypeScript, Recharts vía el wrapper shadcn
(`components/ui/chart.tsx`), Tailwind v3, `tsx` para los scripts de verificación, pnpm.

## Global Constraints

- **Gestor de paquetes: pnpm.** Nunca `npm install`. Este plan no agrega dependencias.
- **`npx tsc --noEmit` es el gate real** — `pnpm build` ignora errores de TypeScript y
  `pnpm lint` está roto (eslint no es dependencia del repo).
- **No hay framework de tests.** La verificación de módulos puros va en
  `scripts/verify-sales-pivot.ts` con `node:assert/strict`, corrido con `pnpm verify:pivot`.
- **El paquete es CJS**: nada de top-level `await` en los scripts. El script ya envuelve
  todo en `main()`; agrega tus bloques dentro de `main()`.
- **Fechas DATE de GHL se leen en UTC.** El mes SIEMPRE se saca con `getUTCFullYear()` /
  `getUTCMonth()`. Leerlo en local mueve un cierre del día 1 al mes anterior.
- **Nunca reimplementar la lógica de dominio compartida.** `isWonOpp()` decide qué es una
  venta; `closeDateOf()` decide la fecha; `PANEL_SCOPES` decide el pipeline y el campo de
  sucursal. Importa, no copies.
- **Los drill-downs se resuelven contra `allOpportunities`**, nunca contra el slice
  filtrado por fecha.
- **Textos de UI en español** (es-MX), moneda `MXN` con `Intl.NumberFormat("es-MX")`.
- Los dos paneles (`vaeo-dashboard.tsx`, `mesh-dashboard.tsx`) montan **el mismo
  componente**; lo único que cambia es `panel="vaeo" | "mesh"`.

## Decisión de paleta (medida, no opinada)

`CHART_PALETTE` de `dashboard-ui.tsx` **no aguanta** una barra apilada: validada con
`scripts/validate_palette.js` de la skill `dataviz`, a 5 slots ya falla
(`#8b5cf6` vs `#2563eb`, ΔE 12.7 en visión normal — indistinguibles), y `#335577` cae bajo
el piso de croma (lee como gris, que es justo el color reservado para la cubeta vacía).

Se agrega una paleta **nueva y separada** para estos charts, sin tocar `CHART_PALETTE` (que
sigue sirviendo a `chat-chart.tsx`). **5 tonos con nombre**, validados en
`--pairs all` — el modo estricto, porque en una leyenda cualquier par de chips se compara —
y en los dos modos contra la superficie real de la tarjeta (`#fcfcfb` claro,
`hsl(222 20% 13%)` = `#1a1f28` oscuro):

| Modo | Paleta | Resultado |
|---|---|---|
| claro | `#F59B1B,#2563eb,#22c55e,#ec4899,#06b6d4` | ALL CHECKS PASS (peor par ΔE 18.1) |
| oscuro | `#d97706,#2563eb,#16a34a,#ec4899,#0891b2` | ALL CHECKS PASS (peor par ΔE 16.3) |

El modo oscuro tiene **sus propios pasos**, no es un volteo automático: los tonos claros
caen fuera de la banda de luminosidad L 0.48–0.67 sobre superficie oscura.

Consecuencia de diseño, y **es un cambio respecto al spec**: con 5 tonos, una dimensión con
más de 5 valores (Servicio tiene ~10) **pliega la cola en "Otros"**. Sucursal VAEO tiene 4
valores y MESH 2, así que ahí nunca se pliega nada. Las cubetas neutras (`Otros`,
`Sin sucursal`/`Sin servicio`) van en gris fuera de la paleta categórica, distinguidas
entre sí por luminosidad.

---

### Task 1: `lib/sales-series.ts` — la agregación

**Files:**
- Create: `lib/sales-series.ts`
- Modify: `lib/sales-pivot.ts:71-80` (exportar `monthKeyOf` y `monthLabelOf`)
- Test: `scripts/verify-sales-pivot.ts` (agregar bloques dentro de `main()`)

**Interfaces:**
- Consumes: de `lib/sales-pivot.ts` → `closeDateOf`, `NO_DATE_KEY`, `NO_DATE_LABEL`,
  `NO_SUCURSAL`, `NO_SERVICIO`, y (nuevas exportaciones) `monthKeyOf`, `monthLabelOf`.
  De `lib/opportunity-status.ts` → `isWonOpp`.
- Produces: `buildSalesSeries(opps, opts): SalesSeriesData`, más los tipos
  `SalesSeriesEntry`, `SalesMonthBucket`, `SalesSeriesData` y la constante `OTROS_KEY`.
  La Task 3 consume todo esto.

- [x] **Step 1: Exportar las primitivas de mes**

En `lib/sales-pivot.ts`, cambia las dos funciones privadas a exportadas (solo agrega
`export`, no toques el cuerpo ni el comentario de arriba):

```ts
export function monthKeyOf(iso: string): string {
```

```ts
export function monthLabelOf(key: string): string {
```

- [x] **Step 2: Escribir las aserciones que fallan**

En `scripts/verify-sales-pivot.ts`, agrega el import (junto a los que ya están):

```ts
import { buildSalesSeries, OTROS_KEY } from "../lib/sales-series";
```

y este bloque **dentro de `main()`**, al final, antes del `console.log` de cierre:

```ts
  // 10. sales-series: cuadre exacto con el pivote sobre el mismo input.
  // Es LA aserción del módulo: los dos charts y la tabla viven en la misma
  // pantalla, así que una discrepancia es visible y vergonzosa.
  {
    const opps = [
      opp({ value: 100, cierre: "2026-06-10T00:00:00.000Z", sucursal: "MTY Tanarah", servicio: "Coworking" }),
      opp({ value: 250, cierre: "2026-06-20T00:00:00.000Z", sucursal: "QRO Central Park", servicio: "Coworking" }),
      opp({ value: 70, cierre: "2026-07-01T00:00:00.000Z", sucursal: "MTY Tanarah", servicio: "Sala de Juntas" }),
      opp({ value: 30, cierre: "2026-07-05T00:00:00.000Z", sucursal: "SLP Covalia" }),
      opp({ value: 40, sucursal: "MTY Tanarah", servicio: "Coworking" }),
    ];
    const pivot = buildSalesPivot(opps, { sucursalField: SUCURSAL_FIELD });
    const series = buildSalesSeries(opps, {
      dimensionField: SUCURSAL_FIELD,
      emptyLabel: NO_SUCURSAL,
    });

    assert.equal(series.grandTotal, pivot.grandTotal, "el total general cuadra con el pivote");

    for (const bucket of series.buckets) {
      const cell = cellAt(pivot, bucket.key, TOTAL_KEY);
      assert.equal(bucket.total, cell.value, `el bucket ${bucket.key} cuadra con su fila`);
    }

    for (const s of series.series) {
      const cell = cellAt(pivot, TOTAL_KEY, `sub||${s.key}`);
      assert.equal(s.total, cell.value, `la serie ${s.key} cuadra con su subtotal`);
    }
  }

  // 11. sales-series: orden, cubetas y drill.
  {
    const opps = [
      opp({ value: 10, cierre: "2026-05-02T00:00:00.000Z", sucursal: "MTY Tanarah" }),
      opp({ value: 900, cierre: "2026-04-02T00:00:00.000Z", sucursal: "QRO Central Park" }),
      opp({ value: 5, cierre: "2026-04-03T00:00:00.000Z" }),
      opp({ value: 7, sucursal: "MTY Tanarah" }),
      opp({ value: 3, cierre: "2026-04-01T00:00:00.000Z", sucursal: "MTY Tanarah", status: "lost", stage: "Perdido" }),
    ];
    const d = buildSalesSeries(opps, {
      dimensionField: SUCURSAL_FIELD,
      emptyLabel: NO_SUCURSAL,
    });

    assert.deepEqual(
      d.series.map((s) => s.key),
      ["QRO Central Park", "MTY Tanarah", NO_SUCURSAL],
      "series por total desc, la cubeta vacía siempre al final"
    );
    assert.deepEqual(
      d.buckets.map((b) => b.label),
      ["abr 2026", "may 2026", "Sin fecha de cierre"],
      "meses ascendentes y la cubeta sin fecha al FINAL (al revés que el pivote)"
    );
    assert.equal(d.buckets[2].kind, "no-date");
    assert.equal(d.buckets[2].total, 7, "la ganada sin fecha vive en su propio bucket");
    assert.equal(d.grandTotal, 922, "la perdida no cuenta; todo lo demás sí");

    const abr = d.buckets[0];
    assert.equal(abr.values["QRO Central Park"], 900);
    assert.equal(abr.values[NO_SUCURSAL], 5, "sucursal vacía cae en la cubeta vacía");
    assert.equal(abr.values["MTY Tanarah"], undefined, "una serie sin valor no ocupa lugar");
    assert.equal(abr.oppIds["QRO Central Park"].length, 1, "el drill trae los ids de la celda");
  }

  // 12. sales-series: la cola se pliega en "Otros" cuando hay más de maxNamed.
  {
    const mk = (servicio: string, value: number) =>
      opp({ value, cierre: "2026-04-02T00:00:00.000Z", servicio });
    const opps = [
      mk("A", 100), mk("B", 90), mk("C", 80), mk("D", 70),
      mk("E", 60), mk("F", 50), mk("G", 40),
    ];
    const d = buildSalesSeries(opps, {
      dimensionField: "Servicio",
      emptyLabel: NO_SERVICIO,
      maxNamed: 5,
    });

    assert.deepEqual(
      d.series.map((s) => s.key),
      ["A", "B", "C", "D", "E", OTROS_KEY],
      "las 5 mayores conservan nombre, F y G se pliegan"
    );
    assert.equal(d.series[5].total, 90, "Otros suma la cola");
    assert.equal(d.series[5].foldedCount, 2, "Otros dice cuántas plegó");
    assert.equal(d.buckets[0].oppIds[OTROS_KEY].length, 2, "el drill de Otros trae las dos");
    assert.equal(d.grandTotal, 490, "plegar no cambia el total");
  }

  // 13. sales-series: namedKeys congela qué series existen. Sin esto, filtrar
  // por fecha puede "despiegar" una serie que en el total vive dentro de Otros,
  // y el chart repinta colores al mover el filtro.
  {
    const mk = (servicio: string, value: number) =>
      opp({ value, cierre: "2026-04-02T00:00:00.000Z", servicio });
    const d = buildSalesSeries([mk("F", 50), mk("G", 40)], {
      dimensionField: "Servicio",
      emptyLabel: NO_SERVICIO,
      namedKeys: ["A", "B", "C", "D", "E"],
    });
    assert.deepEqual(
      d.series.map((s) => s.key),
      [OTROS_KEY],
      "F y G siguen plegadas aunque a solas serían las mayores"
    );
    assert.equal(d.series[0].total, 90, "Otros suma las dos");
  }

  // 14. sales-series: no se pliega una sola sobrante — "Otros (1)" es absurdo.
  {
    const mk = (servicio: string, value: number) =>
      opp({ value, cierre: "2026-04-02T00:00:00.000Z", servicio });
    const d = buildSalesSeries(
      [mk("A", 100), mk("B", 90), mk("C", 80), mk("D", 70), mk("E", 60), mk("F", 50)],
      { dimensionField: "Servicio", emptyLabel: NO_SERVICIO, maxNamed: 5 }
    );
    assert.deepEqual(
      d.series.map((s) => s.key),
      ["A", "B", "C", "D", "E", "F"],
      "con una sola sobrante se queda con su nombre"
    );
  }
```

- [x] **Step 3: Correr y ver que falla**

Run: `pnpm verify:pivot`
Expected: FAIL — `Cannot find module '../lib/sales-series'`.

- [x] **Step 4: Escribir el módulo**

Crear `lib/sales-series.ts`:

```ts
// Agregación detrás de los dos charts de barras apiladas de ventas: ganadas
// agrupadas por mes de Fecha de Cierre (eje X) y apiladas por una dimensión
// (sucursal o servicio).
//
// Es el MISMO agregado que buildSalesPivot en otra forma, y los dos viven en la
// misma pantalla — por eso comparte con él todas las primitivas (qué es una
// venta, cuál es su fecha, en qué mes cae) en vez de reimplementarlas, y por eso
// scripts/verify-sales-pivot.ts asegura que los dos dan el mismo número.
import type { Opportunity } from "./types"
import { isWonOpp } from "./opportunity-status"
import {
  closeDateOf,
  monthKeyOf,
  monthLabelOf,
  NO_DATE_KEY,
  NO_DATE_LABEL,
} from "./sales-pivot"

/** Clave de la serie que agrupa la cola larga de una dimensión. */
export const OTROS_KEY = "Otros"

/** Máximo de series con nombre propio. Es el tamaño de la paleta validada. */
export const DEFAULT_MAX_NAMED = 5

export interface SalesSeriesEntry {
  /** Valor de la dimensión, OTROS_KEY, o la etiqueta de la cubeta vacía. */
  key: string
  label: string
  kind: "named" | "otros" | "empty"
  /** Total del periodo — define el orden de apilado y de la leyenda. */
  total: number
  /** Cuántos valores se plegaron aquí. Solo en kind "otros". */
  foldedCount?: number
}

export interface SalesMonthBucket {
  /** "2026-06" o NO_DATE_KEY. */
  key: string
  label: string
  kind: "month" | "no-date"
  total: number
  /** Valor por serie. Solo trae las series con valor; el resto no aparece. */
  values: Record<string, number>
  /** Ids por serie — de aquí sale el drill-down. */
  oppIds: Record<string, string[]>
}

export interface SalesSeriesData {
  /** Total desc; "Otros" y la cubeta vacía, en ese orden, al final. */
  series: SalesSeriesEntry[]
  /** Meses ascendentes; el bucket sin fecha al final. */
  buckets: SalesMonthBucket[]
  grandTotal: number
}

export interface SalesSeriesOptions {
  /** Custom field que apila: "Sucursal VAEO" | "Sucursal MESH" | "Servicio". */
  dimensionField: string
  /** Etiqueta de la cubeta vacía: NO_SUCURSAL o NO_SERVICIO. */
  emptyLabel: string
  maxNamed?: number
  /**
   * Valores que conservan nombre propio; todo lo demás se pliega en "Otros".
   * Se calcula UNA vez sobre el set sin filtrar y se impone a la llamada
   * filtrada. Sin esto, un servicio que en el total anual vive dentro de
   * "Otros" reaparecería con nombre propio al filtrar a un mes donde sí es
   * grande — y el chart repintaría las series al mover el filtro.
   */
  namedKeys?: string[]
}

function cfString(v: string | string[] | undefined): string {
  const s = Array.isArray(v) ? v[0] : v
  return (s ?? "").trim()
}

export function buildSalesSeries(
  opps: Opportunity[],
  opts: SalesSeriesOptions
): SalesSeriesData {
  const maxNamed = opts.maxNamed ?? DEFAULT_MAX_NAMED

  // Pase 1 — clasificar cada ganada y acumular los totales que definen el orden.
  type Entry = { bucketKey: string; dim: string; value: number; id: string }
  const entries: Entry[] = []
  const dimTotals = new Map<string, number>()
  const bucketKeys = new Set<string>()

  for (const o of opps) {
    if (!isWonOpp(o)) continue
    const iso = closeDateOf(o)
    const bucketKey = iso ? monthKeyOf(iso) : NO_DATE_KEY
    const dim = cfString(o.customFieldsResolved?.[opts.dimensionField]) || opts.emptyLabel
    const value = o.value ?? 0

    entries.push({ bucketKey, dim, value, id: o.id })
    bucketKeys.add(bucketKey)
    dimTotals.set(dim, (dimTotals.get(dim) ?? 0) + value)
  }

  // Orden de series: total desc, empates por nombre, cubeta vacía siempre al
  // final. Mismo criterio que usa el pivote para sus columnas.
  const named = [...dimTotals.keys()]
    .filter((k) => k !== opts.emptyLabel)
    .sort((a, b) => {
      const diff = (dimTotals.get(b) ?? 0) - (dimTotals.get(a) ?? 0)
      return diff !== 0 ? diff : a.localeCompare(b, "es")
    })

  // Con namedKeys manda la lista de afuera. Sin ella se pliega la cola, y solo
  // si sobra MÁS de una: "Otros (1)" no dice nada que el nombre real no diga
  // mejor.
  let keptNames: string[]
  let foldedNames: string[]
  if (opts.namedKeys) {
    const allowed = new Set(opts.namedKeys)
    keptNames = named.filter((k) => allowed.has(k))
    foldedNames = named.filter((k) => !allowed.has(k))
  } else if (named.length > maxNamed + 1) {
    keptNames = named.slice(0, maxNamed)
    foldedNames = named.slice(maxNamed)
  } else {
    keptNames = named
    foldedNames = []
  }
  const foldedSet = new Set(foldedNames)

  /** Dimensión → clave de serie bajo la que se grafica. */
  const seriesKeyOf = (dim: string) => (foldedSet.has(dim) ? OTROS_KEY : dim)

  const series: SalesSeriesEntry[] = keptNames.map((key) => ({
    key,
    label: key,
    kind: "named",
    total: dimTotals.get(key) ?? 0,
  }))

  if (foldedNames.length > 0) {
    series.push({
      key: OTROS_KEY,
      label: OTROS_KEY,
      kind: "otros",
      total: foldedNames.reduce((sum, k) => sum + (dimTotals.get(k) ?? 0), 0),
      foldedCount: foldedNames.length,
    })
  }

  if (dimTotals.has(opts.emptyLabel)) {
    series.push({
      key: opts.emptyLabel,
      label: opts.emptyLabel,
      kind: "empty",
      total: dimTotals.get(opts.emptyLabel) ?? 0,
    })
  }

  // Orden de buckets: meses ascendentes y el "sin fecha" AL FINAL. En la tabla
  // esa fila va pinneada arriba porque se lee de arriba hacia abajo; en un eje
  // temporal el lugar del "resto" es la derecha.
  const months = [...bucketKeys].filter((k) => k !== NO_DATE_KEY).sort()
  const orderedKeys = bucketKeys.has(NO_DATE_KEY) ? [...months, NO_DATE_KEY] : months

  const buckets: SalesMonthBucket[] = orderedKeys.map((key) => ({
    key,
    label: key === NO_DATE_KEY ? NO_DATE_LABEL : monthLabelOf(key),
    kind: key === NO_DATE_KEY ? "no-date" : "month",
    total: 0,
    values: {},
    oppIds: {},
  }))
  const bucketByKey = new Map(buckets.map((b) => [b.key, b]))

  // Pase 2 — llenar celdas.
  let grandTotal = 0
  for (const e of entries) {
    const bucket = bucketByKey.get(e.bucketKey)
    if (!bucket) continue
    const key = seriesKeyOf(e.dim)
    bucket.values[key] = (bucket.values[key] ?? 0) + e.value
    ;(bucket.oppIds[key] ??= []).push(e.id)
    bucket.total += e.value
    grandTotal += e.value
  }

  return { series, buckets, grandTotal }
}
```

- [x] **Step 5: Correr y ver que pasa**

Run: `pnpm verify:pivot`
Expected: PASS — todas las aserciones, incluidas las 9 que ya existían.

- [x] **Step 6: Chequear tipos**

Run: `npx tsc --noEmit`
Expected: sin salida.

- [x] **Step 7: Commit**

```bash
git add lib/sales-series.ts lib/sales-pivot.ts scripts/verify-sales-pivot.ts
git commit -m "feat(vaeo): agregación de ventas por mes de cierre × dimensión

buildSalesSeries reutiliza las primitivas del pivote (isWonOpp, closeDateOf,
mes en UTC) y verify:pivot asegura que los dos dan el mismo número."
```

---

### Task 2: La paleta validada

**Files:**
- Modify: `components/dashboard/dashboard-ui.tsx` (agregar exports después de
  `chartPaletteColor`, ~línea 50)

**Interfaces:**
- Consumes: nada.
- Produces: `SERIES_PALETTE` (`{ light: string[]; dark: string[] }`),
  `SERIES_NEUTRALS` (`{ otros: {light,dark}; empty: {light,dark} }`). La Task 3 los consume.

- [x] **Step 1: Agregar las constantes**

En `components/dashboard/dashboard-ui.tsx`, justo después de `chartPaletteColor`:

```ts
/**
 * Paleta de las series apiladas de ventas. Separada de CHART_PALETTE a
 * propósito: aquella se diseñó para barras y pays de UNA serie, y en un stack no
 * pasa la validación — `#8b5cf6` y `#2563eb` quedan a ΔE 12.7 en visión normal
 * (indistinguibles) y `#335577` cae bajo el piso de croma, es decir lee gris,
 * que es justo el color reservado aquí para la cubeta vacía.
 *
 * Estos 5 tonos pasan las seis validaciones en modo `--pairs all` (cualquier par
 * de la leyenda, no solo los vecinos del stack), en claro y en oscuro, contra la
 * superficie real de la tarjeta. El modo oscuro tiene sus PROPIOS pasos: los
 * tonos claros caen fuera de la banda de luminosidad sobre fondo oscuro.
 *
 * Cinco es el límite duro: con un sexto tono la validación falla. Una dimensión
 * con más valores pliega su cola en "Otros" (ver lib/sales-series.ts).
 */
export const SERIES_PALETTE = {
  light: ["#F59B1B", "#2563eb", "#22c55e", "#ec4899", "#06b6d4"],
  dark: ["#d97706", "#2563eb", "#16a34a", "#ec4899", "#0891b2"],
} as const

/**
 * Las dos cubetas que NO son una categoría real. Van en gris, fuera de la paleta
 * categórica, y se distinguen entre sí por luminosidad: "Otros" pesa más que
 * "sin dato capturado", así que va más oscuro en claro y más claro en oscuro.
 */
export const SERIES_NEUTRALS = {
  otros: { light: "#4b5563", dark: "#9ca3af" },
  empty: { light: "#9ca3af", dark: "#4b5563" },
} as const
```

- [x] **Step 2: Chequear tipos**

Run: `npx tsc --noEmit`
Expected: sin salida.

- [x] **Step 3: Commit**

```bash
git add components/dashboard/dashboard-ui.tsx
git commit -m "feat(ui): paleta categórica validada para series apiladas

CHART_PALETTE no pasa la validación en un stack; esta sí, en claro y oscuro,
con --pairs all. Cinco tonos es el límite duro."
```

---

### Task 3: El componente `sales-by-dimension-chart.tsx`

**Files:**
- Create: `components/dashboard/sales-by-dimension-chart.tsx`

**Interfaces:**
- Consumes: `buildSalesSeries`, `OTROS_KEY`, `SalesSeriesData` (Task 1);
  `SERIES_PALETTE`, `SERIES_NEUTRALS` (Task 2); `PANEL_SCOPES`, `scopeOpportunities`
  (`lib/panel-scope.ts`); `closeDateOf`, `NO_SUCURSAL`, `NO_SERVICIO`, `SERVICIO_FIELD`
  (`lib/sales-pivot.ts`); `filterByDateRange` (`lib/date-range.ts`);
  `ChartDrillDrawer`, `DRILL_CLOSED`, `DrillState` (`chart-drill-drawer.tsx`).
- Produces: `SalesByDimensionChart` y su prop `SalesByDimensionChartProps`, que la Task 4
  monta en los dos paneles.

**Notas de implementación que no se ven en el código:**
- Las claves de serie son texto libre del CRM (`"Dom. fiscal y Com."`), y se usan como
  `dataKey` de Recharts **y** como nombre de variable CSS. Por eso se mapean a slots
  sintéticos `s0…s4`, `otros`, `vacio`.
- El tema se resuelve **solo con CSS**: `ChartConfig` acepta `theme: { light, dark }` y
  `ChartStyle` (en `components/ui/chart.tsx`) emite `--color-<slot>` por modo. No hace falta
  leer el tema en JS.
- El `stroke` del color de la tarjeta es el separador de 2px entre segmentos apilados.

- [x] **Step 1: Escribir el componente**

```tsx
"use client"

import { useMemo, useState } from "react"
import { BarChart3 } from "lucide-react"
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  XAxis,
  YAxis,
} from "recharts"
import type {
  Appointment,
  Call,
  Contact,
  Message,
  Opportunity,
  Pauta,
  Pipeline,
  Task,
} from "@/lib/types"
import {
  buildSalesSeries,
  OTROS_KEY,
  type SalesSeriesEntry,
} from "@/lib/sales-series"
import {
  closeDateOf,
  NO_SERVICIO,
  NO_SUCURSAL,
  SERVICIO_FIELD,
} from "@/lib/sales-pivot"
import { PANEL_SCOPES, scopeOpportunities, type PanelId } from "@/lib/panel-scope"
import { filterByDateRange, type ResolvedDateRange } from "@/lib/date-range"
import { cn } from "@/lib/utils"
import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart"
import {
  CHART_GRID_STROKE,
  CHART_TICK,
  ChartCardContent,
  ChartCardHeader,
  ChartEmpty,
  DashboardCard,
  NonZeroTooltipContent,
  ScopePill,
  SERIES_NEUTRALS,
  SERIES_PALETTE,
} from "./dashboard-ui"
import { ChartDrillDrawer, DRILL_CLOSED, type DrillState } from "./chart-drill-drawer"

const money = new Intl.NumberFormat("es-MX", {
  style: "currency",
  currency: "MXN",
  maximumFractionDigits: 0,
})

/** Etiqueta sobre la barra y ticks del eje: $1.7 M en vez de $1,704,142. */
const moneyShort = new Intl.NumberFormat("es-MX", {
  style: "currency",
  currency: "MXN",
  notation: "compact",
  maximumFractionDigits: 1,
})

type Dimension = "sucursal" | "servicio"

export interface SalesByDimensionChartProps {
  panel: PanelId
  dimension: Dimension
  /** Sin filtrar — este chart filtra por fecha de CIERRE, no por createdAt. */
  allOpportunities: Opportunity[]
  contacts: Contact[]
  /** Sin filtrar — los joins del drill se resuelven aquí. */
  allContacts: Contact[]
  pipelines?: Pipeline[]
  dateRange: ResolvedDateRange | null
  tasks?: Task[]
  calls?: Call[]
  allPautas?: Pauta[]
  appointments?: Appointment[]
  messages?: Message[]
  locationId?: string
}

/** Slot sintético por serie: sirve de dataKey y de nombre de variable CSS. */
function slotOf(entry: SalesSeriesEntry, namedIndex: number): string {
  if (entry.kind === "otros") return "otros"
  if (entry.kind === "empty") return "vacio"
  return `s${namedIndex}`
}

function colorOf(slot: string): { light: string; dark: string } {
  if (slot === "otros") return SERIES_NEUTRALS.otros
  if (slot === "vacio") return SERIES_NEUTRALS.empty
  const i = Number(slot.slice(1))
  return { light: SERIES_PALETTE.light[i], dark: SERIES_PALETTE.dark[i] }
}

export function SalesByDimensionChart({
  panel,
  dimension,
  allOpportunities,
  contacts,
  allContacts,
  pipelines = [],
  dateRange,
  tasks = [],
  calls = [],
  allPautas = [],
  appointments = [],
  messages = [],
  locationId = "",
}: SalesByDimensionChartProps) {
  const [drill, setDrill] = useState<DrillState>(DRILL_CLOSED)
  /** Slot aislado por la leyenda; null = todas visibles. */
  const [isolated, setIsolated] = useState<string | null>(null)

  const scope = PANEL_SCOPES[panel]
  const seriesOpts = useMemo(
    () =>
      dimension === "sucursal"
        ? { dimensionField: scope.sucursalField, emptyLabel: NO_SUCURSAL }
        : { dimensionField: SERVICIO_FIELD, emptyLabel: NO_SERVICIO },
    [dimension, scope.sucursalField]
  )

  const scoped = useMemo(
    () => scopeOpportunities(allOpportunities, panel, pipelines),
    [allOpportunities, panel, pipelines]
  )

  // Qué series existen y de qué color son se decide UNA vez sobre el set SIN
  // filtrar, y se impone a la llamada filtrada vía namedKeys. Si se decidiera
  // sobre el set filtrado, mover el filtro de fechas cambiaría qué serie se
  // pliega en "Otros" y repintaría las que sobreviven.
  const { slotByKey, namedKeys } = useMemo(() => {
    const all = buildSalesSeries(scoped, seriesOpts)
    const map = new Map<string, string>()
    const names: string[] = []
    let named = 0
    for (const s of all.series) {
      if (s.kind === "named") names.push(s.key)
      map.set(s.key, slotOf(s, s.kind === "named" ? named++ : 0))
    }
    return { slotByKey: map, namedKeys: names }
  }, [scoped, seriesOpts])

  const data = useMemo(
    () =>
      buildSalesSeries(filterByDateRange(scoped, closeDateOf, dateRange), {
        ...seriesOpts,
        namedKeys,
      }),
    [scoped, dateRange, seriesOpts, namedKeys]
  )

  // Serie → slot. Con namedKeys el mapa siempre acierta; el fallback solo evita
  // que un caso imprevisto rompa el render.
  const slots = useMemo(
    () => data.series.map((s) => ({ entry: s, slot: slotByKey.get(s.key) ?? "otros" })),
    [data.series, slotByKey]
  )

  const config: ChartConfig = useMemo(() => {
    const out: ChartConfig = {}
    for (const { entry, slot } of slots) {
      out[slot] = {
        label:
          entry.kind === "otros" ? `Otros (${entry.foldedCount})` : entry.label,
        theme: colorOf(slot),
      }
    }
    return out
  }, [slots])

  // Recharts consume filas planas: una por mes, con un dataKey por slot.
  const rows = useMemo(
    () =>
      data.buckets.map((b) => {
        const row: Record<string, string | number> = { label: b.label, total: b.total }
        for (const { entry, slot } of slots) {
          const v = b.values[entry.key]
          if (v) row[slot] = v
        }
        return row
      }),
    [data.buckets, slots]
  )

  const oppById = useMemo(
    () => new Map(allOpportunities.map((o) => [o.id, o])),
    [allOpportunities]
  )

  const openDrill = (seriesKey: string, bucketIndex: number) => {
    const bucket = data.buckets[bucketIndex]
    const ids = bucket?.oppIds[seriesKey] ?? []
    if (ids.length === 0) return
    const opportunities = ids
      .map((id) => oppById.get(id))
      .filter((o): o is Opportunity => Boolean(o))
    setDrill({
      open: true,
      title: `${bucket.label} — ${seriesKey}`,
      subtitle: "Oportunidades ganadas",
      opportunities,
    })
  }

  const dimLabel = dimension === "sucursal" ? "sucursal" : "servicio"
  const noDateTotal = data.buckets.find((b) => b.kind === "no-date")?.total ?? 0

  return (
    <DashboardCard>
      <ChartCardHeader
        title={`Ventas por ${dimLabel}`}
        icon={BarChart3}
        total={money.format(data.grandTotal)}
        actions={
          <ScopePill
            label="Ganadas · por fecha de cierre"
            tooltip={
              <>
                Suma el valor de las oportunidades <strong>ganadas</strong> del embudo{" "}
                {scope.label}, apiladas por <strong>{dimLabel}</strong> y agrupadas por el
                mes de su <strong>Fecha de Cierre</strong> (no por su fecha de creación).
                Las que no tienen {dimLabel} capturado caen en el segmento gris, y las que
                no tienen fecha de cierre viven en la barra{" "}
                <em>Sin fecha de cierre</em>, al final del eje, que no se ve afectada por
                el filtro de fechas. Los totales cuadran con la tabla de arriba.
              </>
            }
          />
        }
      />
      <ChartCardContent>
        {rows.length === 0 ? (
          <ChartEmpty message="Sin ventas cerradas en el periodo seleccionado" />
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
              {slots.map(({ entry, slot }) => {
                const dimmed = isolated !== null && isolated !== slot
                return (
                  <button
                    key={slot}
                    type="button"
                    onClick={() => setIsolated(isolated === slot ? null : slot)}
                    className={cn(
                      "inline-flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground transition-opacity",
                      dimmed && "opacity-40"
                    )}
                    title={`${entry.label} · ${money.format(entry.total)}`}
                  >
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
                      style={{ backgroundColor: `var(--color-${slot})` }}
                      aria-hidden
                    />
                    <span className="truncate">
                      {entry.kind === "otros" ? `Otros (${entry.foldedCount})` : entry.label}
                    </span>
                  </button>
                )
              })}
            </div>

            <ChartContainer config={config} className="aspect-auto h-[300px] w-full">
              <BarChart data={rows} margin={{ top: 24, right: 8, bottom: 0, left: 8 }}>
                <CartesianGrid vertical={false} stroke={CHART_GRID_STROKE} />
                <XAxis
                  dataKey="label"
                  tickLine={false}
                  axisLine={false}
                  tick={CHART_TICK}
                  interval={0}
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  tick={CHART_TICK}
                  width={64}
                  tickFormatter={(v: number) => moneyShort.format(v)}
                />
                <ChartTooltip
                  content={<NonZeroTooltipContent formatter={(v) => money.format(Number(v))} />}
                />
                {slots.map(({ entry, slot }, i) => {
                  const isTop = i === slots.length - 1
                  return (
                    <Bar
                      key={slot}
                      dataKey={slot}
                      stackId="ventas"
                      fill={`var(--color-${slot})`}
                      stroke="hsl(var(--card))"
                      strokeWidth={2}
                      radius={isTop ? [4, 4, 0, 0] : 0}
                      onClick={(_: unknown, index: number) => openDrill(entry.key, index)}
                      className="cursor-pointer"
                    >
                      {rows.map((_, rowIndex) => {
                        // La barra "Sin fecha de cierre" va atenuada: no es un mes,
                        // y el eje no debe sugerir que sí.
                        const noDate = data.buckets[rowIndex].kind === "no-date"
                        const dimmed = isolated !== null && isolated !== slot
                        return (
                          <Cell
                            key={rowIndex}
                            fillOpacity={(noDate ? 0.55 : 1) * (dimmed ? 0.18 : 1)}
                          />
                        )
                      })}
                      {isTop && (
                        <LabelList
                          dataKey="total"
                          position="top"
                          offset={8}
                          className="fill-muted-foreground"
                          fontSize={10}
                          formatter={(v: number) => moneyShort.format(v)}
                        />
                      )}
                    </Bar>
                  )
                })}
              </BarChart>
            </ChartContainer>

            {noDateTotal > 0 && (
              <p className="mt-2 text-[11px] text-muted-foreground">
                La última barra agrupa {money.format(noDateTotal)} en ventas ganadas sin
                Fecha de Cierre capturada.
              </p>
            )}
          </>
        )}
      </ChartCardContent>

      <ChartDrillDrawer
        drill={drill}
        onDrillChange={setDrill}
        contacts={allContacts.length > 0 ? allContacts : contacts}
        tasks={tasks}
        calls={calls}
        allOpportunities={allOpportunities}
        allPautas={allPautas}
        appointments={appointments}
        messages={messages}
        locationId={locationId}
      />
    </DashboardCard>
  )
}
```

- [x] **Step 2: Chequear tipos**

Run: `npx tsc --noEmit`
Expected: sin salida. Si Recharts se queja de la firma de `onClick` o de
`LabelList.formatter`, ajusta el tipo del parámetro — no cambies el comportamiento y no
uses `@ts-ignore`.

- [x] **Step 3: Commit**

```bash
git add components/dashboard/sales-by-dimension-chart.tsx
git commit -m "feat(ui): barras apiladas de ventas por mes de cierre

Un solo componente para los dos cortes (sucursal / servicio). Color estable
por entidad, leyenda que aísla, barra atenuada para las ventas sin fecha."
```

---

### Task 4: Montarlo en los dos paneles

**Files:**
- Modify: `components/dashboard/vaeo-dashboard.tsx:76-93`
- Modify: `components/dashboard/mesh-dashboard.tsx:61-81`

**Interfaces:**
- Consumes: `SalesByDimensionChart` (Task 3) y `SalesPivotTable` (ya existe).
- Produces: nada que consuman tareas posteriores.

- [x] **Step 1: VAEO — importar y montar**

En `components/dashboard/vaeo-dashboard.tsx`, agrega el import junto al de `SalesPivotTable`:

```tsx
import { SalesByDimensionChart } from "./sales-by-dimension-chart"
```

y reemplaza el cuerpo del `return` (deja el `DashboardShell`) por:

```tsx
  const shared = {
    allOpportunities,
    contacts,
    allContacts,
    pipelines,
    dateRange,
    tasks,
    calls,
    allPautas,
    appointments,
    messages,
    locationId,
  }

  return (
    <DashboardShell>
      <SalesPivotTable panel="vaeo" {...shared} />
      <div className="grid gap-5 md:grid-cols-2">
        <SalesByDimensionChart panel="vaeo" dimension="sucursal" {...shared} />
        <SalesByDimensionChart panel="vaeo" dimension="servicio" {...shared} />
      </div>
    </DashboardShell>
  )
```

- [x] **Step 2: MESH — mismo montaje, quitando el placeholder**

En `components/dashboard/mesh-dashboard.tsx`, cambia el import de `dashboard-ui` para que
ya no traiga `PanelPlaceholder`, agrega los dos componentes, y ajusta la destructuración
de props para que reciba lo mismo que VAEO:

```tsx
import { DashboardShell } from "./dashboard-ui"
import { SalesPivotTable } from "./sales-pivot-table"
import { SalesByDimensionChart } from "./sales-by-dimension-chart"
```

```tsx
export function MeshDashboard({
  contacts,
  allContacts = [],
  allOpportunities = [],
  pipelines = [],
  dateRange = null,
  tasks = [],
  calls = [],
  allPautas = [],
  appointments = [],
  messages = [],
  locationId,
}: MeshDashboardProps) {
  const shared = {
    allOpportunities,
    contacts,
    allContacts,
    pipelines,
    dateRange,
    tasks,
    calls,
    allPautas,
    appointments,
    messages,
    locationId,
  }

  return (
    <DashboardShell>
      <SalesPivotTable panel="mesh" {...shared} />
      <div className="grid gap-5 md:grid-cols-2">
        <SalesByDimensionChart panel="mesh" dimension="sucursal" {...shared} />
        <SalesByDimensionChart panel="mesh" dimension="servicio" {...shared} />
      </div>
    </DashboardShell>
  )
}
```

- [x] **Step 3: Chequear tipos**

Run: `npx tsc --noEmit`
Expected: sin salida. Si TypeScript marca props sin usar en `MeshDashboardProps`
(`opportunities`, `pautas`, …), déjalas en la interfaz — el contrato de props se mantiene
idéntico entre los dos paneles a propósito.

- [x] **Step 4: Verificar en la app real**

Los charts no se verifican sin verlos. Corre `pnpm dev`, entra con la contraseña del
cliente y revisa, en las pestañas VAEO y MESH:

1. Los dos charts aparecen debajo de la tabla, lado a lado en escritorio.
2. El **total del badge de cada chart es idéntico al de la tabla** en el mismo periodo.
3. Mover el filtro de fechas **no cambia el color** de ninguna serie.
4. Clic en un chip de la leyenda aísla; clic otra vez restaura.
5. Clic en un segmento abre el drawer con el número de oportunidades que corresponde.
6. La barra "Sin fecha de cierre" está al final y se ve atenuada.
7. Modo claro y modo oscuro.
8. En MESH ya no aparece el `PanelPlaceholder`.

Cualquier discrepancia entre el total del chart y el de la tabla es un bug de bloqueo:
para y arréglalo antes de commitear.

- [x] **Step 5: Commit**

```bash
git add components/dashboard/vaeo-dashboard.tsx components/dashboard/mesh-dashboard.tsx
git commit -m "feat(panel): montar las barras de ventas en VAEO y MESH

MESH deja de renderizar el placeholder: monta la tabla y los dos charts con
su propio pipeline y su propio campo de sucursal."
```

---

### Task 5: Documentación

**Files:**
- Modify: `CLAUDE.md:497` (quitar la regla de leyendas)
- Modify: `CLAUDE.md` (tabla de módulos compartidos; sección "Current state")

**Interfaces:**
- Consumes: nada. Cierra el trabajo.

- [x] **Step 1: Quitar la regla de leyendas**

En `CLAUDE.md`, dentro de **Chart conventions**, borra la línea:

```
- No visual encoding that requires a legend to decode
```

La regla se elimina por decisión del dueño del repo: una barra apilada requiere leyenda por
definición, y estos charts calcan un reporte que el cliente ya usa.

- [x] **Step 2: Registrar el módulo nuevo**

En la tabla de **Shared domain rules (single sources of truth)**, agrega una fila después
de la de `lib/sales-pivot.ts`:

```
| `lib/sales-series.ts` | la agregación de las barras apiladas (mes de cierre × sucursal / servicio) |
```

- [x] **Step 3: Actualizar "Current state"**

Reemplaza la primera viñeta de **Current state** por:

```
- `components/dashboard/vaeo-dashboard.tsx` y `components/dashboard/mesh-dashboard.tsx`
  renderizan lo mismo: la tabla `sales-pivot-table.tsx` ("Resumen general de ventas") y,
  debajo, dos `sales-by-dimension-chart.tsx` (ventas por sucursal / por servicio) en un
  grid de dos columnas. Lo único que difiere entre los dos paneles es `panel="vaeo" |
  "mesh"`, que resuelve el pipeline y el campo de sucursal vía `lib/panel-scope.ts`.
  **Su prop surface es idéntica a propósito** — `app/page.tsx` ya alimenta las slices
  filtradas por fecha y los sets `all*`, así que un chart nuevo entra sin plomería.
```

Y en la sección de **Chart conventions**, agrega:

```
- Series apiladas: usa `SERIES_PALETTE` / `SERIES_NEUTRALS` (`dashboard-ui.tsx`), no
  `CHART_PALETTE` — esta última no pasa la validación de contraste/CVD en un stack. Cinco
  tonos es el límite; una dimensión con más valores pliega su cola en "Otros"
  (`lib/sales-series.ts`). El color se asigna sobre el set SIN filtrar, para que mover el
  filtro de fechas no repinte las series.
```

- [x] **Step 4: Verificar que el verify sigue verde**

Run: `pnpm verify:pivot && npx tsc --noEmit`
Expected: PASS y sin salida.

- [x] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: documentar los charts de ventas y quitar la regla de leyendas"
```
