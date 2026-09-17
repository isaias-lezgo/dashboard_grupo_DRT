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
import { SIN_NOMBRE_CAMPAIGN } from "./pauta"
import { reachedStage } from "./desarrollo-funnel"
import { normalizeDesarrolloName } from "./panel-scope"

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

export interface PautaRow {
  name: string
  /** true solo en la fila SIN_NOMBRE_CAMPAIGN, que va al final en rojizo. */
  missing: boolean
  cells: Record<PautaMetric, PautaCell>
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
  /** Oportunidades que cuentan en más de una fila. */
  multiPauta: number
  /** Tamaño del universo: todas las oportunidades recibidas. */
  universe: number
}

const CITA = { key: "cita", minIndex: 4 }

/**
 * La misma regla que "Citas agendadas" del embudo de GENERAL: etapa actual
 * `≥04`, o ganada (una venta implica cita — el embudo es monótono), o el
 * contacto tiene una cita en el objeto Citas, cualquier estatus y sin filtrar
 * por fecha.
 */
export function hadCita(opp: Opportunity, contactsWithCita: ReadonlySet<string>): boolean {
  return (
    reachedStage(opp, CITA) ||
    isWonOpp(opp) ||
    (!!opp.contactId && contactsWithCita.has(opp.contactId))
  )
}

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

/**
 * contactId → nombres DISTINTOS de sus Pautas, en orden de aparición. Se arma
 * sobre las Pautas SIN filtrar: el registro pudo crearse fuera de la ventana que
 * pone a la oportunidad en pantalla, y perderlo la mandaría a "sin Pauta" por
 * un accidente del filtro.
 */
export function buildPautaNamesByContact(
  pautas: Pauta[],
  desarrollo?: string | null
): Map<string, string[]> {
  const wanted = desarrollo ? normalizeDesarrolloName(desarrollo) : null
  const m = new Map<string, string[]>()
  for (const p of pautas) {
    if (!p.contactId) continue
    if (wanted !== null && normalizeDesarrolloName(p.properties?.desarrollo ?? "") !== wanted) continue
    const name = p.nombrePauta?.trim() || SIN_NOMBRE_CAMPAIGN
    const arr = m.get(p.contactId) ?? []
    if (!arr.includes(name)) arr.push(name)
    m.set(p.contactId, arr)
  }
  return m
}

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
  desarrollo: string | null = null
): PautaPerformance {
  const namesByContact = buildPautaNamesByContact(pautas, desarrollo)
  // Para distinguir "sin Pauta" de "con Pauta, pero de otro desarrollo".
  const anyPautaContacts = desarrollo ? buildPautaNamesByContact(pautas) : namesByContact
  const contactsWithCita = new Set(appointments.map((a) => a.contactId).filter(Boolean))

  const byName = new Map<string, PautaRow>()
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
    if (names.length > 1) multiPauta += 1

    const hits: PautaMetric[] = ["leads"]
    if (hadCita(opp, contactsWithCita)) hits.push("citas")
    if (isWonOpp(opp)) hits.push("ventas")
    else if (isPerdida(opp)) hits.push("perdidos")

    // Los totales cuentan la oportunidad UNA vez, aunque caiga en dos filas.
    for (const m of hits) push(totals, m, opp.id)
    for (const name of names) {
      const row =
        byName.get(name) ??
        { name, missing: name === SIN_NOMBRE_CAMPAIGN, cells: emptyCells() }
      byName.set(name, row)
      for (const m of hits) push(row.cells, m, opp.id)
    }
  }

  const rows = [...byName.values()].sort((a, b) => {
    if (a.missing !== b.missing) return a.missing ? 1 : -1
    return b.cells.leads.count - a.cells.leads.count || a.name.localeCompare(b.name, "es")
  })

  return { rows, totals, sinPauta, otroDesarrollo, multiPauta, universe: opps.length }
}
