// Agregación detrás de "Rendimiento por pauta": una fila por nombre de Pauta con
// cuántas oportunidades entraron por ella y cuántas llegaron a cita, venta o se
// perdieron.
//
// Todo se enlaza a través del CONTACTO: la oportunidad tiene `contactId`, el
// registro Pauta tiene `contactId`, la cita tiene `contactId`. La unidad sigue
// siendo la oportunidad, como en todo el panel: el universo son las
// oportunidades del embudo (ya cortadas por fecha) y la Pauta solo les pone
// nombre.
//
// Un contacto con Pautas de DOS nombres distintos (18 % de los contactos con
// Pauta, medido 2026-09-17) cuenta en las dos filas. Es la misma convención de
// los ejes multi-valor de origen/canal: quedarse con la primera Pauta borraría
// las re-entradas. `multiPauta` y la nota al pie lo dicen en vez de esconderlo.
//
// PERO dentro de un desarrollo solo nombran la fila las Pautas de ESE
// desarrollo (`properties.desarrollo`, poblada al 100 % con el nombre del
// pipeline). Sin ese corte, un contacto que entró por una pauta de Cañadas y
// después abrió una oportunidad en Atria ponía "Cañadas by El Mirador" en la
// tabla de Atria — cierto, pero ilegible. Medido 2026-09-17: en Atria 1,284 de
// 1,293 oportunidades con Pauta tienen una de Atria; las 9 restantes van a
// `otroDesarrollo`, fuera de la tabla, con su propio drill.
//
// Puro y sin React, igual que lib/lost-reason-matrix.ts y por la misma razón:
// un join mal hecho se ve idéntico a uno bien en la UI. Vive bajo
// scripts/verify-pauta-performance.ts.
import type { Appointment, Opportunity, Pauta } from "./types"
import { isWonOpp } from "./opportunity-status"
import { SIN_NOMBRE_CAMPAIGN, buildPautaNamesByContact } from "./pauta"
import { hadCita, reachedStage } from "./desarrollo-funnel"
import { oppAdId } from "./meta-attribution"

export const PAUTA_METRICS = ["leads", "citas", "ventas", "perdidos"] as const
export type PautaMetric = (typeof PAUTA_METRICS)[number]

export const PAUTA_METRIC_LABELS: Record<PautaMetric, string> = {
  leads: "Leads recibidos",
  citas: "Citas",
  ventas: "Ventas",
  perdidos: "Perdidos",
}

export interface PautaCell {
  count: number
  oppIds: string[]
}

/** Cómo se agrupa la tabla: por nombre de Pauta o por id del anuncio. */
export type PautaGroupBy = "name" | "id"

/** Sentinela de la fila sin `ID Pauta` en el modo por id. */
export const SIN_ID_PAUTA = "Sin id"

export interface PautaRelated {
  label: string
  /** Leads de la fila que traen este valor. */
  count: number
}

export interface PautaRow {
  /** El nombre de la Pauta (por nombre) o el id del anuncio (por id). */
  name: string
  /** true en las filas centinela (SIN_NOMBRE_CAMPAIGN / SIN_ID_PAUTA), al final y en rojizo. */
  missing: boolean
  cells: Record<PautaMetric, PautaCell>
  /**
   * La otra identidad, por leads desc: los `ID Pauta` de la fila cuando se
   * agrupa por nombre, los nombres de Pauta cuando se agrupa por id. Es
   * uno-a-muchos en ambos sentidos — el nombre es la campaña o el formulario
   * y el id es el anuncio; "Cañadas by El Mirador" corre bajo 98 anuncios
   * (medido 2026-09-17) — así que la UI muestra el dominante y cuántos más hay.
   */
  related: PautaRelated[]
}

export interface PautaPerformance {
  rows: PautaRow[]
  /** Fila de totales: oportunidades DISTINTAS por métrica, no la suma de filas. */
  totals: Record<PautaMetric, PautaCell>
  /** Oportunidades del universo cuyo contacto no tiene ningún registro Pauta. */
  sinPauta: PautaCell
  /**
   * Solo con `desarrollo`: el contacto sí tiene Pautas, pero todas de OTRO
   * desarrollo — un lead que el equipo movió de embudo. Fuera de la tabla.
   */
  otroDesarrollo: PautaCell
  /** Oportunidades que cuentan en más de una fila. Siempre 0 por id: el id es uno por oportunidad. */
  multiPauta: number
  /** Tamaño del universo: todas las oportunidades recibidas. */
  universe: number
}

// Se mudó a lib/desarrollo-funnel.ts para que lib/meta-attribution.ts pueda
// usarla sin un ciclo de imports (este módulo importa oppAdId de ahí).
// Re-exportada por compatibilidad.
export { hadCita } from "./desarrollo-funnel"

/** Perdida o abandonada — la cubeta "perdida" de statusBucket, sin importar la etapa. */
export function isPerdida(opp: Opportunity): boolean {
  return opp.status === "lost" || opp.status === "abandoned"
}

function emptyCell(): PautaCell {
  return { count: 0, oppIds: [] }
}

function emptyCells(): Record<PautaMetric, PautaCell> {
  return { leads: emptyCell(), citas: emptyCell(), ventas: emptyCell(), perdidos: emptyCell() }
}

// Se mudó a lib/pauta.ts por la misma razón que hadCita. Re-exportada.
export { buildPautaNamesByContact } from "./pauta"

/**
 * `opps` es el universo ya acotado (embudo de la pestaña + fecha); `pautas` y
 * `appointments` van SIN filtrar, porque solo sirven de lookup. `desarrollo` es
 * el nombre del pipeline de la pestaña (null en GENERAL): con él, solo las
 * Pautas de ese desarrollo nombran filas.
 *
 * Filas por leads desc; "Sin nombre" fija al final aunque sea la más grande:
 * es un hueco de captura del escenario de Make, no una campaña.
 */
export function buildPautaPerformance(
  opps: Opportunity[],
  pautas: Pauta[],
  appointments: Appointment[],
  desarrollo: string | null = null,
  groupBy: PautaGroupBy = "name"
): PautaPerformance {
  const namesByContact = buildPautaNamesByContact(pautas, desarrollo)
  // Para distinguir "sin Pauta" de "con Pauta, pero de otro desarrollo".
  const anyPautaContacts = desarrollo ? buildPautaNamesByContact(pautas) : namesByContact
  const contactsWithCita = new Set(appointments.map((a) => a.contactId).filter(Boolean))

  const byKey = new Map<string, PautaRow>()
  const relatedByKey = new Map<string, Map<string, number>>()
  const totals = emptyCells()
  const sinPauta = emptyCell()
  const otroDesarrollo = emptyCell()
  let multiPauta = 0

  const push = (cells: Record<PautaMetric, PautaCell>, metric: PautaMetric, id: string) => {
    cells[metric].count += 1
    cells[metric].oppIds.push(id)
  }

  for (const opp of opps) {
    const names = opp.contactId ? namesByContact.get(opp.contactId) : undefined
    if (!names || names.length === 0) {
      const out = opp.contactId && anyPautaContacts.has(opp.contactId) ? otroDesarrollo : sinPauta
      out.count += 1
      out.oppIds.push(opp.id)
      continue
    }
    // Por nombre la oportunidad cae en cada Pauta de su contacto; por id cae
    // UNA vez, en su anuncio, y los nombres pasan a ser la columna relacionada.
    const adId = oppAdId(opp)
    const keys = groupBy === "name" ? names : [adId ?? SIN_ID_PAUTA]
    const related = groupBy === "name" ? (adId ? [adId] : []) : names
    if (keys.length > 1) multiPauta += 1

    const hits: PautaMetric[] = ["leads"]
    if (hadCita(opp, contactsWithCita)) hits.push("citas")
    if (isWonOpp(opp)) hits.push("ventas")
    else if (isPerdida(opp)) hits.push("perdidos")

    // Los totales cuentan la oportunidad UNA vez, aunque caiga en dos filas.
    for (const m of hits) push(totals, m, opp.id)
    for (const key of keys) {
      const row =
        byKey.get(key) ??
        {
          name: key,
          missing: key === SIN_NOMBRE_CAMPAIGN || key === SIN_ID_PAUTA,
          cells: emptyCells(),
          related: [],
        }
      byKey.set(key, row)
      for (const m of hits) push(row.cells, m, opp.id)
      const rel = relatedByKey.get(key) ?? new Map<string, number>()
      for (const r of related) rel.set(r, (rel.get(r) ?? 0) + 1)
      relatedByKey.set(key, rel)
    }
  }

  for (const row of byKey.values()) {
    row.related = [...(relatedByKey.get(row.name)?.entries() ?? [])]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "es"))
  }

  const rows = [...byKey.values()].sort((a, b) => {
    if (a.missing !== b.missing) return a.missing ? 1 : -1
    return b.cells.leads.count - a.cells.leads.count || a.name.localeCompare(b.name, "es")
  })

  return { rows, totals, sinPauta, otroDesarrollo, multiPauta, universe: opps.length }
}
