// Agregación detrás de "Oportunidades sin atención": la matriz cruzada de días
// sin mover la oportunidad × días sin mandarle un mensaje al contacto.
//
// Es el único gráfico del panel que mide ANTIGÜEDAD SIN ATENCIÓN en vez de
// estado. Un lead parado dos meses en "Lead en proceso" cuenta como oportunidad
// abierta en todos los demás gráficos y ahí se queda; aquí se ve.
//
// Puro y sin React, verificado por scripts/verify-stale-matrix.ts.
import type { Opportunity } from "./types"

/**
 * Hasta dónde tiene que mirar hacia atrás quien alimente el eje de mensajes.
 * Es la frontera de la cubeta más profunda: cualquier conversación más vieja
 * que esto cae en "+60 d" sin importar su fecha exacta, así que la ruta
 * app/api/conversation-activity puede dejar de paginar aquí.
 *
 * Si algún día se agrega una cubeta de 90 días, HAY QUE SUBIR ESTA CONSTANTE
 * o el gráfico mentirá: las conversaciones entre 60 y 90 días nunca llegarían.
 */
export const STALE_HORIZON_DAYS = 60

export type StaleBucketKey = "0-7" | "8-15" | "16-30" | "31-60" | "60+"

export interface StaleBucketDef {
  key: StaleBucketKey
  label: string
  /** Días, inclusivo. */
  min: number
  /** Días, inclusivo. Infinity en la última. */
  max: number
}

/** Las mismas cubetas en los dos ejes: la comparación que importa es entre celdas. */
export const STALE_BUCKETS: readonly StaleBucketDef[] = [
  { key: "0-7", label: "0–7 d", min: 0, max: 7 },
  { key: "8-15", label: "8–15 d", min: 8, max: 15 },
  { key: "16-30", label: "16–30 d", min: 16, max: 30 },
  { key: "31-60", label: "31–60 d", min: 31, max: 60 },
  { key: "60+", label: "+60 d", min: 61, max: Infinity },
] as const

/**
 * Desde qué índice de cubeta empieza el cuadrante crítico: ≥31 días en AMBOS
 * ejes, o sea sin mover y sin escribir por más de un mes.
 */
export const CRITICAL_FROM_INDEX = 3

const DEEPEST: StaleBucketKey = "60+"

// Se excluyen por NOMBRE, nunca por id — un embudo recreado conserva el nombre
// pero no el id, misma regla que isWonOpp(). "Cliente Futuro" es un
// estacionamiento deliberado: ahí el silencio es la intención, no el abandono.
const CLOSED_STAGE_PATTERNS = [/ganad[oa]|\bwon\b/i, /perdid/i, /cliente\s+futuro/i]

/** ¿La etapa pertenece al embudo VIVO (ni ganada, ni perdida, ni estacionada)? */
export function isLiveStage(stage: string): boolean {
  const s = (stage ?? "").trim()
  return !CLOSED_STAGE_PATTERNS.some((re) => re.test(s))
}

/**
 * Días enteros transcurridos desde `iso` hasta `now`. `null` cuando no hay dato
 * o es ilegible — quien llama decide qué significa eso (aquí: la cubeta más
 * profunda). Una fecha futura devuelve 0, no un negativo.
 */
export function daysSince(iso: string | null | undefined, now: Date): number | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return null
  return Math.max(0, Math.floor((now.getTime() - t) / 86_400_000))
}

/** Cubeta de una antigüedad en días. `null` ⇒ la más profunda. */
export function bucketOfDays(days: number | null): StaleBucketKey {
  if (days === null) return DEEPEST
  for (const b of STALE_BUCKETS) {
    if (days >= b.min && days <= b.max) return b.key
  }
  return DEEPEST
}

export interface StaleCell {
  count: number
  oppIds: string[]
}

export interface StaleRow {
  /** Cubeta del eje de MOVIMIENTO (días sin cambio de etapa). */
  bucket: StaleBucketKey
  label: string
  /** Una celda por cubeta del eje de MENSAJES. */
  cells: Record<StaleBucketKey, StaleCell>
  total: number
  oppIds: string[]
}

export interface StaleMatrix {
  /** Siempre las cinco filas, en orden, aunque alguna quede vacía. */
  rows: StaleRow[]
  colTotals: Record<StaleBucketKey, StaleCell>
  grandTotal: number
  /** Conteo de la celda más poblada. El sombreado se normaliza sobre TODA la matriz. */
  cellMax: number
  criticalCount: number
  criticalOppIds: string[]
}

function emptyCell(): StaleCell {
  return { count: 0, oppIds: [] }
}

function emptyCells(): Record<StaleBucketKey, StaleCell> {
  const out = {} as Record<StaleBucketKey, StaleCell>
  for (const b of STALE_BUCKETS) out[b.key] = emptyCell()
  return out
}

/**
 * Matriz de abandono sobre `opportunities` (que ya deben venir acotadas al
 * embudo del panel — este módulo no filtra por pipeline).
 *
 * `lastOutboundByContact` mapea contacto → ISO del último mensaje SALIENTE, o
 * `null` si se sabe que no hay ninguno. Un contacto **ausente** del mapa se
 * trata igual que `null`: por construcción de la ruta que lo llena, ausencia
 * significa "sin conversación, o sin actividad dentro del horizonte de
 * STALE_HORIZON_DAYS", y ambas cosas caen en la cubeta más profunda. Es
 * correcto, no una aproximación — el último saliente es siempre ≤ el último
 * mensaje de la conversación.
 *
 * Ojo al llamarla: si el mapa llega vacío porque los datos todavía no cargan,
 * TODA la matriz se va a la columna "+60 d" y el gráfico afirma un abandono
 * total. El componente no debe renderizar hasta que la actividad esté lista.
 */
export function buildStaleMatrix(
  opportunities: Opportunity[],
  lastOutboundByContact: Map<string, string | null>,
  now: Date
): StaleMatrix {
  const rows: StaleRow[] = STALE_BUCKETS.map((b) => ({
    bucket: b.key,
    label: b.label,
    cells: emptyCells(),
    total: 0,
    oppIds: [],
  }))
  const rowByKey = new Map(rows.map((r) => [r.bucket, r]))
  const colTotals = emptyCells()

  const criticalOppIds: string[] = []
  let grandTotal = 0

  for (const o of opportunities) {
    if (o.status !== "open") continue
    if (!isLiveStage(o.stage ?? "")) continue

    const moveKey = bucketOfDays(daysSince(o.lastStageChangeAt ?? o.createdAt, now))
    const msgKey = bucketOfDays(daysSince(lastOutboundByContact.get(o.contactId) ?? null, now))

    const row = rowByKey.get(moveKey)!
    row.cells[msgKey].count += 1
    row.cells[msgKey].oppIds.push(o.id)
    row.total += 1
    row.oppIds.push(o.id)

    colTotals[msgKey].count += 1
    colTotals[msgKey].oppIds.push(o.id)
    grandTotal += 1

    const moveIdx = STALE_BUCKETS.findIndex((b) => b.key === moveKey)
    const msgIdx = STALE_BUCKETS.findIndex((b) => b.key === msgKey)
    if (moveIdx >= CRITICAL_FROM_INDEX && msgIdx >= CRITICAL_FROM_INDEX) {
      criticalOppIds.push(o.id)
    }
  }

  let cellMax = 0
  for (const r of rows) {
    for (const b of STALE_BUCKETS) cellMax = Math.max(cellMax, r.cells[b.key].count)
  }

  return {
    rows,
    colTotals,
    grandTotal,
    cellMax,
    criticalCount: criticalOppIds.length,
    criticalOppIds,
  }
}
