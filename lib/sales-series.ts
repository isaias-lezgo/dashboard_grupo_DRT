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
  /**
   * Qué oportunidades entran al agregado. Default: las ganadas.
   *
   * Existe para que "Leads no ganados por servicio" reuse este agregado en vez
   * de copiar el orden de series y el plegado de "Otros" — dos copias de esa
   * lógica se desincronizan a la primera corrección y las dos gráficas dejan de
   * apilar los mismos valores sin que nadie lo note.
   */
  include?: (opp: Opportunity) => boolean
  /**
   * Mes al que pertenece la oportunidad (`YYYY-MM`), o null si no trae fecha
   * legible — esas caen en la cubeta NO_DATE_KEY. Default: el mes de su Fecha
   * de Cierre.
   *
   * La fecha y la forma de leerle el mes van JUNTAS en una sola opción a
   * propósito. `Fecha de Cierre` es un campo DATE de GHL, que llega a medianoche
   * UTC y por lo tanto tiene que leerse en UTC; `createdAt` es un timestamp real
   * y tiene que leerse en hora local, o un lead creado el 1 a las 02:00Z se iría
   * al mes anterior. Separarlas en dos opciones dejaría combinar la fecha de una
   * con el lector de la otra, que es un error silencioso: la gráfica no truena,
   * solo pone unos cuantos leads en el mes equivocado.
   */
  monthOf?: (opp: Opportunity) => string | null
  /**
   * Qué se acumula en cada celda: el valor monetario de la oportunidad
   * ("value", default) o el número de oportunidades ("count"). También decide
   * el orden de las series y qué se pliega en "Otros".
   */
  measure?: "value" | "count"
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

  const include = opts.include ?? isWonOpp
  const monthOf =
    opts.monthOf ??
    ((o: Opportunity) => {
      const iso = closeDateOf(o)
      return iso ? monthKeyOf(iso) : null
    })
  const countOnly = opts.measure === "count"

  for (const o of opps) {
    if (!include(o)) continue
    const bucketKey = monthOf(o) ?? NO_DATE_KEY
    const dim = cfString(o.customFieldsResolved?.[opts.dimensionField]) || opts.emptyLabel
    const value = countOnly ? 1 : o.value ?? 0

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
