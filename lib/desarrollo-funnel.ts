// Las agregaciones de la cabecera de GENERAL: los tres recuentos por desarrollo
// (registros / visitas / ventas) y el embudo de seis pasos de la estrategia.
//
// Puro y sin React, por la razón de siempre: un embudo que cuenta mal se ve
// idéntico a uno que cuenta bien. Vive bajo scripts/verify-desarrollo-funnel.ts.
//
// "Alcanzó la etapa" se lee del PREFIJO NUMÉRICO de la etapa actual, no del id:
// una oportunidad perdida en "05. Visita al Desarrollo" sí visitó, y una que
// hoy está en "07. Apartado" pasó por la cita aunque nadie la haya detenido
// ahí. Es la misma regla que el costo por etapa de Meta; por eso `stageIndexOf`
// y `reachedStage` viven aquí y lib/meta-attribution.ts las importa — una sola
// definición de "alcanzó".
import type { Appointment, Opportunity, Pipeline } from "./types"
import { isWonOpp } from "./opportunity-status"
import { desarrolloOf, NO_DESARROLLO } from "./panel-scope"

// ── Etapas ──────────────────────────────────────────────────────────────────

/** "05. Visita al Desarrollo" → 5. Los side buckets no tienen prefijo → null. */
export function stageIndexOf(stage: string | undefined): number | null {
  const m = /^\s*(\d{1,2})\s*\./.exec(stage ?? "")
  return m ? Number(m[1]) : null
}

/**
 * La etapa actual está en o después del objetivo.
 *
 * "Venta" NO usa el prefijo: es isWonOpp() y nada más, porque esa es la
 * definición canónica de venta en todo el panel. Cubre a la ganada por `status`
 * que nadie movió a "08." y, al revés, excluye a la perdida que se quedó
 * sentada en "08. Venta" — que por prefijo contaría como venta cerrada.
 */
export function reachedStage(
  opp: Opportunity,
  target: { key: string; minIndex: number }
): boolean {
  if (target.key === "venta") return isWonOpp(opp)
  const idx = stageIndexOf(opp.stage)
  return idx !== null && idx >= target.minIndex
}

const VISITA = { key: "visita", minIndex: 5 }
const VENTA = { key: "venta", minIndex: 8 }

// ── Recuentos por desarrollo ────────────────────────────────────────────────

export type CountKey = "registros" | "visitas" | "ventas"

export interface DesarrolloCountRow {
  /** Nombre real del pipeline, o NO_DESARROLLO. */
  desarrollo: string
  /** La cubeta centinela: el embudo que el sync no resolvió. */
  missing: boolean
  /** Toda oportunidad del set: una oportunidad ES un registro. */
  registros: number
  /**
   * Etapa actual ≥ "05." — incluye perdidas que sí visitaron — o ganada: una
   * venta implica visita, la misma monotonía del embudo, para que esta tarjeta
   * y "Visitas realizadas" digan el mismo número.
   */
  visitas: number
  /** isWonOpp(): 74 en "08. Venta", no las 47 con status won. */
  ventas: number
  ids: Record<CountKey, string[]>
}

/**
 * Una fila por desarrollo con los tres recuentos. Es UNA agregación para los
 * tres gráficos a propósito: si cada uno contara lo suyo, un día "Ventas por
 * desarrollo" y "Registros por desarrollo" ordenarían distinto al mismo
 * desarrollo.
 *
 * Orden: por registros descendente; "Sin desarrollo" siempre al final. Un
 * desarrollo se dibuja aunque tenga cero visitas o cero ventas — ese cero es
 * el dato (Palmyra y Zanda hoy).
 */
export function buildDesarrolloCounts(
  opps: Opportunity[],
  pipelines: Pipeline[] | undefined
): DesarrolloCountRow[] {
  const rows = new Map<string, DesarrolloCountRow>()
  for (const opp of opps) {
    const name = desarrolloOf(opp, pipelines)
    let row = rows.get(name)
    if (!row) {
      row = {
        desarrollo: name,
        missing: name === NO_DESARROLLO,
        registros: 0,
        visitas: 0,
        ventas: 0,
        ids: { registros: [], visitas: [], ventas: [] },
      }
      rows.set(name, row)
    }
    row.registros += 1
    row.ids.registros.push(opp.id)
    const venta = reachedStage(opp, VENTA)
    if (venta || reachedStage(opp, VISITA)) {
      row.visitas += 1
      row.ids.visitas.push(opp.id)
    }
    if (venta) {
      row.ventas += 1
      row.ids.ventas.push(opp.id)
    }
  }
  return [...rows.values()].sort((a, b) => {
    if (a.missing !== b.missing) return a.missing ? 1 : -1
    return b.registros - a.registros || a.desarrollo.localeCompare(b.desarrollo, "es")
  })
}

// ── Embudo de la estrategia ─────────────────────────────────────────────────

export type FunnelStepKey =
  | "leads"
  | "precalificados"
  | "citas"
  | "visitas"
  | "apartados"
  | "ventas"

export interface FunnelStep {
  key: FunnelStepKey
  /** 1–6, como lo numera la estrategia. */
  n: number
  label: string
  count: number
  /** Sobre "Leads totales", 0–100. */
  pctOfTotal: number
  /** Sobre el paso anterior, 0–100; null en el primero o si el anterior está en cero. */
  pctOfPrev: number | null
  ids: string[]
  /**
   * Solo en "citas": de dónde salió el número. `porEtapa` alcanzó "04." o
   * después; `soloPorCita` está antes de "04." pero su contacto tiene una cita
   * en el objeto Citas del CRM. Suman `count`.
   */
  fuentes?: { porEtapa: number; soloPorCita: number }
}

/**
 * Cada paso, con el objetivo de etapa que lo alcanza por sí solo. "leads" no
 * tiene objetivo: toda oportunidad es un lead. El objetivo de "ventas" lleva la
 * llave "venta" para que reachedStage() use isWonOpp() y no el prefijo.
 */
const STEPS: {
  key: FunnelStepKey
  label: string
  target: { key: string; minIndex: number } | null
}[] = [
  { key: "leads", label: "Leads totales", target: null },
  { key: "precalificados", label: "Leads precalificados", target: { key: "precalificado", minIndex: 2 } },
  { key: "citas", label: "Citas agendadas", target: { key: "cita", minIndex: 4 } },
  { key: "visitas", label: "Visitas realizadas", target: VISITA },
  { key: "apartados", label: "Apartados", target: { key: "apartado", minIndex: 7 } },
  { key: "ventas", label: "Ventas cerradas", target: VENTA },
]

/**
 * El embudo de seis pasos sobre el set que recibe (ya acotado y filtrado).
 *
 * "Citas agendadas" es una UNIÓN: la etapa actual es "04." o posterior, O el
 * contacto de la oportunidad tiene al menos una cita en el objeto Citas del CRM
 * — con cualquier estatus, porque "agendada" es que se agendó. Ninguna señal
 * sola es completa: hay asesoras que agendan en el calendario sin mover la
 * oportunidad, y otras que mueven la etapa sin usar el calendario. Las citas
 * deben venir SIN filtrar por fecha: la cita puede estar agendada fuera de la
 * ventana que pone a la oportunidad en pantalla.
 *
 * El embudo es MONÓTONO por construcción: alcanzar un paso implica haber
 * alcanzado los anteriores. Sin esto, una oportunidad en "00." con cita contaría
 * como cita pero no como precalificada, y "Citas" saldría mayor que
 * "Precalificados" — un embudo que se lee roto.
 */
export function buildStageFunnel(
  opps: Opportunity[],
  appointments: Appointment[]
): FunnelStep[] {
  const contactsWithCita = new Set(appointments.map((a) => a.contactId))

  // De atrás hacia adelante: el paso i se alcanza si se alcanza por sí solo o si
  // se alcanzó el i+1.
  const reachedByStep = STEPS.map(() => new Set<string>())
  const citaPorEtapa = new Set<string>() // para desglosar "citas"
  for (const opp of opps) {
    let carried = false
    for (let i = STEPS.length - 1; i >= 0; i--) {
      const step = STEPS[i]
      let own = step.target === null || reachedStage(opp, step.target)
      if (step.key === "citas") {
        if (own || carried) citaPorEtapa.add(opp.id)
        else if (contactsWithCita.has(opp.contactId)) own = true
      }
      carried = own || carried
      if (carried) reachedByStep[i].add(opp.id)
    }
  }

  const total = opps.length
  return STEPS.map((step, i) => {
    const ids = [...reachedByStep[i]]
    const prev = i === 0 ? null : reachedByStep[i - 1].size
    const row: FunnelStep = {
      key: step.key,
      n: i + 1,
      label: step.label,
      count: ids.length,
      pctOfTotal: total === 0 ? 0 : (ids.length / total) * 100,
      pctOfPrev: prev === null || prev === 0 ? null : (ids.length / prev) * 100,
      ids,
    }
    if (step.key === "citas") {
      const porEtapa = ids.filter((id) => citaPorEtapa.has(id)).length
      row.fuentes = { porEtapa, soloPorCita: ids.length - porEtapa }
    }
    return row
  })
}
