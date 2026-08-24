// Los cuatro filtros globales de la barra: desarrollo, asesor, origen y canal.
//
// Son del mismo tipo que el filtro de fechas — cambian de qué oportunidades
// habla el panel entero, no cómo dibuja un gráfico. Por eso se aplican en
// app/page.tsx sobre el set de oportunidades ANTES del corte por fecha: así las
// slices filtradas y los sets `all*` que resuelven los drill-downs ven el mismo
// universo, y un drawer nunca puede sacar a la luz un registro que los gráficos
// excluyeron.
//
// Puro y sin React para que scripts/verify-panel-filters.ts pueda afirmarlo: un
// filtro silenciosamente mal se ve igual que uno bien: números más chicos.
import type { Contact, Opportunity, Pipeline } from "./types"
import { NO_DESARROLLO, desarrolloOf } from "./panel-scope"
import { matchesCategory } from "./category-filter"

/** Estado de los cuatro menús. Arreglo vacío = ese menú no filtra nada. */
export interface PanelFilters {
  /** Desarrollos seleccionados; NO_DESARROLLO alcanza a los que no resuelven. */
  desarrollos: string[]
  /** Claves de asesor seleccionadas (las que devuelve advisorKeyOf). */
  asesores: string[]
  /** Grafías crudas de "Origen de lead"; NO_VALUE_KEY alcanza a los sin dato. */
  origen: string[]
  /** Grafías crudas de "Canal de contacto"; NO_VALUE_KEY alcanza a los sin dato. */
  canal: string[]
}

export const EMPTY_PANEL_FILTERS: PanelFilters = {
  desarrollos: [],
  asesores: [],
  origen: [],
  canal: [],
}

/** Cubeta centinela del asesor: la oportunidad que nadie tiene asignada. */
export const NO_ASESOR = "Sin asesor"

/** Una opción del menú de asesores, derivada de los datos. */
export interface Advisor {
  key: string
  label: string
}

/** Sin acentos y en minúsculas, para comparar nombres capturados a mano. */
function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
}

/**
 * Clave del asesor asignado, o NO_ASESOR si la oportunidad está huérfana.
 *
 * La clave es el nombre COMPLETO normalizado, no el primer nombre. La subcuenta
 * tiene ~24 asesores activos y los primeros nombres SÍ colisionan — hay una
 * "Adriana López" y una "Adriana Ortega", una "Mónica Gomez" y una "Mónica
 * Leal" —, así que casar por primer nombre fundiría a dos personas en una fila
 * y repartiría mal sus oportunidades sin que nada se viera roto.
 *
 * El costo aceptado es el simétrico: si alguien corrige un apellido en GHL, esa
 * persona aparece como un asesor nuevo hasta que se resincroniza. Es un error
 * VISIBLE (una fila que se parte en dos), y por eso es el lado correcto donde
 * equivocarse.
 */
export function advisorKeyOf(opp: Opportunity): string {
  return normalize(opp.assignedTo ?? "") || NO_ASESOR
}

/**
 * Los asesores presentes en el set, con su etiqueta legible, ordenados por
 * volumen descendente — con ~24 asesores el orden alfabético entierra a los que
 * mueven el negocio. La cubeta NO_ASESOR queda fuera; el menú la agrega aparte
 * para que quede siempre al final.
 *
 * La etiqueta es la primera grafía vista para esa clave: dos capturas que solo
 * difieren en acentos o espacios son la misma persona y comparten fila.
 */
export function collectAdvisors(opps: Opportunity[]): Advisor[] {
  const counts = new Map<string, number>()
  const labels = new Map<string, string>()
  for (const o of opps) {
    const key = advisorKeyOf(o)
    if (key === NO_ASESOR) continue
    counts.set(key, (counts.get(key) ?? 0) + 1)
    if (!labels.has(key)) labels.set(key, (o.assignedTo ?? "").trim())
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "es"))
    .map(([key]) => ({ key, label: labels.get(key) ?? key }))
}

/**
 * Dentro de un menú los valores son OR; entre menús es AND. Un menú sin
 * selección no filtra: es el estado inicial. Deliberadamente NO se usa "todas
 * seleccionadas" como estado neutro — con esa convención, un desarrollo nuevo en
 * el CRM quedaría fuera de un filtro que el usuario cree que no tiene puesto.
 */
export function applyPanelFilters(
  opps: Opportunity[],
  filters: PanelFilters,
  pipelines?: Pipeline[],
  /** Origen y canal viven en el CONTACTO en esta cuenta — ver categoryValuesOf. */
  contactById?: Map<string, Contact>
): Opportunity[] {
  const byDesarrollo = filters.desarrollos.length > 0
  const byAsesor = filters.asesores.length > 0
  const byOrigen = filters.origen.length > 0
  const byCanal = filters.canal.length > 0
  // Misma referencia cuando no hay nada que filtrar: una copia nueva
  // invalidaría los memos aguas abajo.
  if (!byDesarrollo && !byAsesor && !byOrigen && !byCanal) return opps

  const desarrollos = new Set(filters.desarrollos)
  const asesores = new Set(filters.asesores)
  // Los Sets de categoría se arman una vez, no una por oportunidad.
  const origen = new Set(filters.origen)
  const canal = new Set(filters.canal)

  return opps.filter((o) => {
    if (byDesarrollo && !desarrollos.has(desarrolloOf(o, pipelines))) return false
    if (byAsesor && !asesores.has(advisorKeyOf(o))) return false
    if (byOrigen && !matchesCategory(o, "origen", origen, contactById)) return false
    if (byCanal && !matchesCategory(o, "canal", canal, contactById)) return false
    return true
  })
}

/** Cuántas opciones hay marcadas en total — alimenta el aviso de "filtros activos". */
export function activeFilterCount(filters: PanelFilters): number {
  return (
    filters.desarrollos.length +
    filters.asesores.length +
    filters.origen.length +
    filters.canal.length
  )
}

export { NO_DESARROLLO }
