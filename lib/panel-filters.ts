// Los dos filtros globales de la barra: sucursal y asesor.
//
// Son del mismo tipo que el filtro de fechas y el toggle de HubSpot — cambian de
// qué oportunidades habla el panel entero, no cómo dibuja un gráfico. Por eso se
// aplican en app/page.tsx sobre el set de oportunidades ANTES del corte por
// fecha: así las slices filtradas y los sets `all*` que resuelven los
// drill-downs ven el mismo universo, y un drawer nunca puede sacar a la luz un
// registro que los gráficos excluyeron.
//
// Puro y sin React para que scripts/verify-panel-filters.ts pueda afirmarlo: un
// filtro silenciosamente mal se ve igual que uno bien: números más chicos.
import type { Opportunity } from "./types"
import { PANEL_SCOPES } from "./panel-scope"
import { NO_SUCURSAL } from "./sales-pivot"
import { matchesCategory } from "./category-filter"

/** Estado de los cuatro menús. Arreglo vacío = ese menú no filtra nada. */
export interface PanelFilters {
  /** Valores de sucursal seleccionados; NO_SUCURSAL alcanza a los que no tienen. */
  sucursales: string[]
  /** Claves de asesor seleccionadas (las de ADVISORS). */
  asesores: string[]
  /** Grafías crudas de "Origen de Lead"; NO_VALUE_KEY alcanza a los sin dato. */
  origen: string[]
  /** Grafías crudas de "Canal de Contacto"; NO_VALUE_KEY alcanza a los sin dato. */
  canal: string[]
}

export const EMPTY_PANEL_FILTERS: PanelFilters = {
  sucursales: [],
  asesores: [],
  origen: [],
  canal: [],
}

/**
 * Los tres asesores de ventas que el cliente pidió, y solo esos. La subcuenta
 * tiene nueve usuarios; el resto son dueño, marketing y soporte, y ofrecerlos en
 * un filtro de ventas sería ruido.
 *
 * `key` es el primer nombre normalizado, que es también con lo que se hace el
 * match: si alguien corrige un apellido en GHL el filtro no debe dejar de
 * funcionar en silencio. Los tres primeros nombres son distintos entre sí y la
 * comparación es de token completo, así que no hay colisiones.
 */
export const ADVISORS = [
  { key: "zulema", label: "Zulema Silva" },
  { key: "dariana", label: "Dariana Turrubiates" },
  { key: "diana", label: "Diana Arbelaez" },
] as const

export type AdvisorKey = (typeof ADVISORS)[number]["key"]

const SUCURSAL_FIELDS = [
  PANEL_SCOPES.vaeo.sucursalField,
  PANEL_SCOPES.mesh.sucursalField,
]

function cfString(v: string | string[] | undefined): string {
  const s = Array.isArray(v) ? v[0] : v
  return (s ?? "").trim()
}

/** Sin acentos y en minúsculas, para comparar nombres capturados a mano. */
function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
}

/**
 * La sucursal de una oportunidad como un solo valor, leyendo el campo de VAEO o
 * el de MESH indistintamente: cada oportunidad solo puebla el de su embudo, así
 * que un menú global puede tratarlos como un campo único.
 */
export function sucursalOf(opp: Opportunity): string {
  for (const field of SUCURSAL_FIELDS) {
    const v = cfString(opp.customFieldsResolved?.[field])
    if (v) return v
  }
  return NO_SUCURSAL
}

/** Clave del asesor asignado, o undefined si no es ninguno de los tres. */
export function advisorKeyOf(opp: Opportunity): AdvisorKey | undefined {
  const first = normalize(opp.assignedTo ?? "").split(/\s+/)[0]
  if (!first) return undefined
  return ADVISORS.find((a) => a.key === first)?.key
}

/**
 * Las sucursales presentes en el set, ordenadas y sin la cubeta vacía — el menú
 * la agrega aparte para que quede siempre al final.
 */
export function collectSucursales(opps: Opportunity[]): string[] {
  const seen = new Set<string>()
  for (const o of opps) {
    const s = sucursalOf(o)
    if (s !== NO_SUCURSAL) seen.add(s)
  }
  return [...seen].sort((a, b) => a.localeCompare(b, "es"))
}

/**
 * Dentro de un menú los valores son OR; entre los dos menús es AND. Un menú sin
 * selección no filtra: es el estado inicial. Deliberadamente NO se usa "todas
 * seleccionadas" como estado neutro — con esa convención, una sucursal nueva en
 * el CRM quedaría fuera de un filtro que el usuario cree que no tiene puesto.
 */
export function applyPanelFilters(
  opps: Opportunity[],
  filters: PanelFilters
): Opportunity[] {
  const bySucursal = filters.sucursales.length > 0
  const byAsesor = filters.asesores.length > 0
  const byOrigen = filters.origen.length > 0
  const byCanal = filters.canal.length > 0
  // Misma referencia cuando no hay nada que filtrar, igual que
  // applyHubspotFilter: una copia nueva invalidaría los memos aguas abajo.
  if (!bySucursal && !byAsesor && !byOrigen && !byCanal) return opps

  const sucursales = new Set(filters.sucursales)
  const asesores = new Set(filters.asesores)
  // Los Sets de categoría se arman una vez, no una por oportunidad.
  const origen = new Set(filters.origen)
  const canal = new Set(filters.canal)

  return opps.filter((o) => {
    if (bySucursal && !sucursales.has(sucursalOf(o))) return false
    if (byAsesor) {
      const key = advisorKeyOf(o)
      if (!key || !asesores.has(key)) return false
    }
    if (byOrigen && !matchesCategory(o, "origen", origen)) return false
    if (byCanal && !matchesCategory(o, "canal", canal)) return false
    return true
  })
}

/** Cuántas opciones hay marcadas en total — alimenta el aviso de "filtros activos". */
export function activeFilterCount(filters: PanelFilters): number {
  return (
    filters.sucursales.length +
    filters.asesores.length +
    filters.origen.length +
    filters.canal.length
  )
}
