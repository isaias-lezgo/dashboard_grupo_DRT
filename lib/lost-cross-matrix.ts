// El cruce detrás de la tabla "Perdidas por desarrollo, origen y canal": las
// oportunidades perdidas repartidas sobre DOS de esas tres dimensiones, elegidas
// en la tarjeta.
//
// Es hermano de lib/lost-reason-matrix.ts pero no el mismo problema: ahí el eje
// de filas es el motivo, que siempre trae un valor único, y solo las columnas
// pueden ser multi-valor. Aquí los dos ejes pueden serlo —una oportunidad con
// "Meta, Sitio Web" de origen y "DM, WhatsApp" de canal cae en cuatro celdas—,
// que es justo la clase de doble conteo que hay que aseverar.
//
// Puro y sin React para que scripts/verify-lost-cross.ts lo pueda aseverar: un
// cruce mal armado no truena, da una respuesta plausible y equivocada.
import type { Opportunity, Pipeline } from "./types"
import {
  buildCategoryBreakdown,
  CANAL_FIELDS,
  NO_VALUE_KEY,
  ORIGEN_FIELDS,
  statusBucket,
  type CategoryRow,
} from "./opportunity-breakdown"
import { desarrolloOf, NO_DESARROLLO } from "./panel-scope"

export type LostDimensionId = "desarrollo" | "origen" | "canal"

export interface LostDimension {
  /** Etiqueta del eje, tal como se lee en GHL. */
  label: string
  /**
   * Campos a leer, en orden de preferencia — ver ORIGEN_FIELDS / CANAL_FIELDS.
   * Vacío cuando la dimensión NO sale de un campo personalizado (ver `fromPipeline`).
   */
  fieldNames: string[]
  /** Cómo se llama la cubeta de los que no traen valor, en el eje que sea. */
  missingLabel: string
  /**
   * true cuando el eje se resuelve del EMBUDO y no de un campo. Es mono-valor
   * por construcción: una oportunidad vive en un solo embudo.
   */
  fromPipeline?: boolean
}

/**
 * Las tres dimensiones que la tarjeta alterna.
 *
 * `Desarrollo` sale del EMBUDO, no de un campo personalizado — en esta cuenta el
 * pipeline ES el desarrollo. Eso lo vuelve el único de los tres ejes que está
 * poblado al 100% y que no puede degradarse por un hueco de captura.
 *
 * Ocupa el lugar que en el panel del que salió este código tenía `Servicio`, un
 * campo que aquí no existe. Si algún día se quiere una dimensión de producto de
 * verdad (`Tipo de vivienda`, `Objetivo de compra`), agrégala como una cuarta
 * entrada y MIDE SU POBLADO ANTES: los campos que se capturan al cerrar rondan
 * el 5% en esta cuenta, y un eje casi vacío se lee como un cruce roto.
 */
export const LOST_DIMENSIONS: Record<LostDimensionId, LostDimension> = {
  desarrollo: {
    label: "Desarrollo",
    fieldNames: [],
    missingLabel: NO_DESARROLLO,
    fromPipeline: true,
  },
  origen: {
    label: "Origen de Lead",
    fieldNames: ORIGEN_FIELDS,
    missingLabel: "Sin origen",
  },
  canal: {
    label: "Canal de Contacto",
    fieldNames: CANAL_FIELDS,
    missingLabel: "Sin canal",
  },
}

export const LOST_DIMENSION_IDS = Object.keys(LOST_DIMENSIONS) as LostDimensionId[]

export interface LostCrossCell {
  count: number
  oppIds: string[]
}

export interface LostCrossColumn {
  /** Etiqueta de la categoría; es también la clave de React. */
  label: string
  total: number
  /** true para la cubeta sin valor capturado ("Sin desarrollo", "Sin canal", …). */
  missing: boolean
}

export interface LostCrossRow {
  label: string
  /** Una celda por columna, en el mismo orden que `columns`. */
  cells: LostCrossCell[]
  /** Oportunidades DISTINTAS en esta fila — no la suma de las celdas. */
  total: number
  /** Porcentaje sobre el total de perdidas, 0–100. */
  pct: number
  oppIds: string[]
  /** true para la cubeta sin valor capturado. */
  missing: boolean
}

export interface LostCrossMatrix {
  rowDimension: LostDimensionId
  colDimension: LostDimensionId
  columns: LostCrossColumn[]
  rows: LostCrossRow[]
  /** Fila de totales al pie, alineada con `columns`. */
  totals: LostCrossCell[]
  /** Oportunidades perdidas distintas. */
  grandTotal: number
  /**
   * El conteo de la celda más grande **entre las que codifican un dato real**,
   * o sea ignorando las filas y columnas centinela. Es el denominador del
   * sombreado de calor.
   *
   * Dejar fuera las cubetas vacías no es cosmético: origen y canal sí tienen
   * cubetas grandes, y normalizar contra ellas pintaría toda la tabla real en un
   * blanco indistinguible. Es la misma
   * decisión que la fila "Sin asesor" de advisor-stage-table, y la misma regla
   * de `MISSING_TEXT`: en una cubeta centinela el color se va a la etiqueta, no
   * al fondo, porque ahí el fondo codifica cantidad.
   */
  maxCell: number
}

const emptyMatrix = (
  rowDimension: LostDimensionId,
  colDimension: LostDimensionId
): LostCrossMatrix => ({
  rowDimension,
  colDimension,
  columns: [],
  rows: [],
  totals: [],
  grandTotal: 0,
  maxCell: 0,
})

/**
 * El eje de desarrollo, con la MISMA forma que devuelve buildCategoryBreakdown
 * para que el resto del cruce no tenga que saber de dónde salió cada eje.
 *
 * Mono-valor: una oportunidad vive en un solo embudo, así que aquí no hay el
 * doble conteo que sí tienen origen y canal. Ordenado de mayor a menor con la
 * cubeta vacía siempre al final, igual que el ranking de categorías.
 */
function desarrolloRows(
  lost: Opportunity[],
  pipelines: Pipeline[] | undefined
): Array<CategoryRow & { missing: boolean }> {
  const groups = new Map<string, string[]>()
  for (const o of lost) {
    const label = desarrolloOf(o, pipelines)
    const ids = groups.get(label)
    if (ids) ids.push(o.id)
    else groups.set(label, [o.id])
  }
  return [...groups.entries()]
    .map(([label, oppIds]) => ({
      key: label,
      label,
      count: oppIds.length,
      pct: lost.length > 0 ? (oppIds.length / lost.length) * 100 : 0,
      oppIds,
      missing: label === NO_DESARROLLO,
    }))
    .sort((a, b) =>
      a.missing !== b.missing
        ? Number(a.missing) - Number(b.missing)
        : b.count - a.count || a.label.localeCompare(b.label, "es")
    )
}

/** Las categorías de un eje, con la cubeta vacía renombrada para esa dimensión. */
function axisRows(
  lost: Opportunity[],
  dimension: LostDimensionId,
  pipelines: Pipeline[] | undefined
): Array<CategoryRow & { missing: boolean }> {
  const dim = LOST_DIMENSIONS[dimension]
  if (dim.fromPipeline) return desarrolloRows(lost, pipelines)
  return buildCategoryBreakdown(lost, dim.fieldNames).map((r) =>
    r.key === NO_VALUE_KEY
      ? { ...r, label: dim.missingLabel, missing: true }
      : { ...r, missing: false }
  )
}

/** id de oportunidad → índices del eje en los que cae (puede ser más de uno). */
function indexByOpp(rows: CategoryRow[]): Map<string, number[]> {
  const out = new Map<string, number[]>()
  rows.forEach((r, i) => {
    for (const id of r.oppIds) {
      const at = out.get(id)
      if (at) at.push(i)
      else out.set(id, [i])
    }
  })
  return out
}

/**
 * Matriz `rowDimension` × `colDimension` sobre las oportunidades PERDIDAS de
 * `opps`.
 *
 * Los dos ejes salen de `buildCategoryBreakdown()`, no de una normalización
 * propia: así la columna "WhatsApp" de esta tabla agrupa exactamente las mismas
 * oportunidades que la barra "WhatsApp" del ranking de al lado, y la fila
 * agrupamiento es justo la deriva que los módulos compartidos existen para
 * evitar. El eje de desarrollo es la excepción: sale del embudo, no de un campo,
 * y por eso se arma aquí (ver desarrolloRows).
 *
 * "Perdida" es `statusBucket()`, o sea `lost` o `abandoned` y nunca una que
 * `isWonOpp()` dé por ganada — la misma definición que la barra roja del gráfico
 * de estado y que "Motivos de perdido", para que los totales de las tres
 * tarjetas cuadren.
 *
 * Multi-valor EN AMBOS EJES: una oportunidad con dos orígenes y dos canales
 * capturados en la misma celda ("Meta, Sitio Web") suma en cuatro celdas. Por eso
 * ni el `total` de una fila ni el de una columna son la suma de sus celdas —
 * los dos son conteos de oportunidades distintas, y las sumas cruzadas pueden
 * pasárseles. Es a propósito: la alternativa sería una regla de "gana el
 * primero" que tira información real.
 *
 * `rowDimension` y `colDimension` iguales devuelve una matriz vacía en vez de una
 * diagonal sin sentido; la UI no lo permite, pero el módulo no depende de eso.
 */
export function buildLostCrossMatrix(
  opps: Opportunity[],
  rowDimension: LostDimensionId,
  colDimension: LostDimensionId,
  /** Necesarios solo cuando alguno de los ejes es "desarrollo". */
  pipelines?: Pipeline[]
): LostCrossMatrix {
  if (rowDimension === colDimension) return emptyMatrix(rowDimension, colDimension)

  const lost = opps.filter((o) => statusBucket(o) === "perdida")
  if (lost.length === 0) return emptyMatrix(rowDimension, colDimension)

  const colRows = axisRows(lost, colDimension, pipelines)
  const rowRows = axisRows(lost, rowDimension, pipelines)
  const colsByOpp = indexByOpp(colRows)

  const columns: LostCrossColumn[] = colRows.map((r) => ({
    label: r.label,
    total: r.count,
    missing: r.missing,
  }))

  const rows: LostCrossRow[] = rowRows.map((r) => {
    const cells: LostCrossCell[] = columns.map(() => ({ count: 0, oppIds: [] }))
    for (const id of r.oppIds) {
      for (const i of colsByOpp.get(id) ?? []) {
        cells[i].count += 1
        cells[i].oppIds.push(id)
      }
    }
    return {
      label: r.label,
      cells,
      total: r.count,
      pct: r.pct,
      oppIds: r.oppIds,
      missing: r.missing,
    }
  })

  const totals: LostCrossCell[] = colRows.map((r) => ({
    count: r.count,
    oppIds: r.oppIds,
  }))

  let maxCell = 0
  for (const row of rows) {
    if (row.missing) continue
    row.cells.forEach((cell, i) => {
      if (columns[i].missing) return
      if (cell.count > maxCell) maxCell = cell.count
    })
  }

  return {
    rowDimension,
    colDimension,
    columns,
    rows,
    totals,
    grandTotal: lost.length,
    maxCell,
  }
}
