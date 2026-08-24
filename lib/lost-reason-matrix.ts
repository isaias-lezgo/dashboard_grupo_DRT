// El cruce detrás de la tabla "Motivos de perdido": motivo × categoría, donde la
// categoría es Canal de Contacto u Origen de Lead según el switch de la tarjeta.
//
// Puro y sin React para que scripts/verify-lost-matrix.ts lo pueda aseverar: un
// cruce mal armado da una respuesta silenciosamente equivocada —una celda que
// suma en la columna que no era se ve idéntica a una correcta.
import type { Contact, Opportunity } from "./types"
import {
  buildCategoryBreakdown,
  categoryKey,
  mostFrequent,
  NO_VALUE_LABEL,
  statusBucket,
} from "./opportunity-breakdown"

/** Fila sin motivo capturado. Siempre va al final, aunque sea grande. */
export const NO_REASON_LABEL = "Sin motivo"

export interface LostMatrixColumn {
  /** Etiqueta de la categoría; es también la clave de React. */
  label: string
  total: number
  /** true para la columna "Sin dato". */
  missing: boolean
}

export interface LostMatrixCell {
  count: number
  oppIds: string[]
}

export interface LostMatrixRow {
  label: string
  /** Una celda por columna, en el mismo orden que `columns`. */
  cells: LostMatrixCell[]
  /** Oportunidades DISTINTAS con este motivo — no la suma de las celdas. */
  total: number
  /** Porcentaje sobre el total de perdidas, 0–100. */
  pct: number
  oppIds: string[]
  /** true para la fila "Sin motivo". */
  missing: boolean
}

export interface LostReasonMatrix {
  columns: LostMatrixColumn[]
  rows: LostMatrixRow[]
  /** Fila de totales al pie, alineada con `columns`. */
  totals: LostMatrixCell[]
  /** Oportunidades perdidas distintas. */
  grandTotal: number
  /** El conteo de la celda más grande — para el sombreado de calor. */
  maxCell: number
}

const EMPTY: LostReasonMatrix = {
  columns: [],
  rows: [],
  totals: [],
  grandTotal: 0,
  maxCell: 0,
}

/**
 * Motivo de pérdida legible de una oportunidad, o null si no trae ninguno.
 *
 * `lostReason` ya viene resuelto por la API (el `lostReasonId` nativo contra el
 * catálogo de la sub-cuenta, con caída a un custom field "Motivo de Perdido").
 * Aquí solo se recorta.
 */
function reasonOf(opp: Opportunity): string | null {
  const raw = opp.lostReason?.trim()
  return raw ? raw : null
}

/**
 * Matriz motivo × categoría sobre las oportunidades PERDIDAS de `opps`.
 *
 * Las columnas salen de `buildCategoryBreakdown()`, no de una segunda
 * normalización propia: así la columna "WhatsApp" de esta tabla agrupa
 * exactamente las mismas oportunidades que la barra "WhatsApp" del gráfico de al
 * lado. Duplicar esa lógica es justo la clase de deriva que los módulos
 * compartidos existen para evitar.
 *
 * "Perdida" es `statusBucket()`, o sea `lost` o `abandoned` y nunca una que
 * `isWonOpp()` dé por ganada — la misma definición que la barra roja del gráfico
 * de estado, para que los totales de las dos tarjetas cuadren.
 *
 * Multi-valor: una oportunidad con dos categorías en la misma celda ("Meta,
 * Sitio Web") cuenta en AMBAS columnas, igual que en el ranking. Por eso el
 * `total` de una fila es su conteo de oportunidades distintas y puede ser menor
 * que la suma horizontal de sus celdas.
 */
export function buildLostReasonMatrix(
  opps: Opportunity[],
  fieldNames: string[],
  /** La categoría puede vivir en el CONTACTO — ver categoryValuesOf. */
  contactById?: Map<string, Contact>
): LostReasonMatrix {
  const lost = opps.filter((o) => statusBucket(o) === "perdida")
  if (lost.length === 0) return EMPTY

  // Columnas: el mismo ranking que dibuja el gráfico de categorías, que ya trae
  // los ids de cada grupo y deja "Sin dato" al final.
  const catRows = buildCategoryBreakdown(lost, fieldNames, contactById)
  const columns: LostMatrixColumn[] = catRows.map((r) => ({
    label: r.label,
    total: r.count,
    missing: r.label === NO_VALUE_LABEL,
  }))
  // id de oportunidad → índices de columna en los que cae (puede ser más de uno).
  const colsByOpp = new Map<string, number[]>()
  catRows.forEach((r, i) => {
    for (const id of r.oppIds) {
      const at = colsByOpp.get(id)
      if (at) at.push(i)
      else colsByOpp.set(id, [i])
    }
  })

  // Filas: se agrupan por clave normalizada para que "No Contesta" y "No
  // contesta" no se partan en dos, y se muestra la grafía más frecuente.
  interface Group {
    spellings: Map<string, number>
    oppIds: string[]
  }
  const groups = new Map<string, Group>()
  const noReason: string[] = []

  for (const opp of lost) {
    const reason = reasonOf(opp)
    if (reason === null) {
      noReason.push(opp.id)
      continue
    }
    const key = categoryKey(reason)
    if (key === "") {
      noReason.push(opp.id)
      continue
    }
    const g: Group = groups.get(key) ?? { spellings: new Map(), oppIds: [] }
    g.spellings.set(reason, (g.spellings.get(reason) ?? 0) + 1)
    g.oppIds.push(opp.id)
    groups.set(key, g)
  }

  const pctOf = (n: number) => (n / lost.length) * 100

  const buildRow = (label: string, oppIds: string[], missing: boolean): LostMatrixRow => {
    const cells: LostMatrixCell[] = columns.map(() => ({ count: 0, oppIds: [] }))
    for (const id of oppIds) {
      for (const i of colsByOpp.get(id) ?? []) {
        cells[i].count += 1
        cells[i].oppIds.push(id)
      }
    }
    return { label, cells, total: oppIds.length, pct: pctOf(oppIds.length), oppIds, missing }
  }

  const rows: LostMatrixRow[] = [...groups.values()]
    .map((g) => buildRow(mostFrequent(g.spellings), g.oppIds, false))
    .sort((a, b) => b.total - a.total || a.label.localeCompare(b.label, "es"))

  if (noReason.length > 0) rows.push(buildRow(NO_REASON_LABEL, noReason, true))

  const totals: LostMatrixCell[] = columns.map((c, i) => ({
    count: c.total,
    oppIds: catRows[i].oppIds,
  }))

  let maxCell = 0
  for (const row of rows) {
    for (const cell of row.cells) if (cell.count > maxCell) maxCell = cell.count
  }

  return { columns, rows, totals, grandTotal: lost.length, maxCell }
}
