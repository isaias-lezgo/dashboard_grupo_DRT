// Los cinco filtros globales de la barra: desarrollo, asesor, origen, canal y
// campaña (nombre de Pauta).
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
import { SIN_NOMBRE_CAMPAIGN, pautaNameFromCustomFields } from "./pauta"
import { oppAdId } from "./meta-attribution"

/** Estado de los cinco menús. Arreglo vacío = ese menú no filtra nada. */
export interface PanelFilters {
  /** Desarrollos seleccionados; NO_DESARROLLO alcanza a los que no resuelven. */
  desarrollos: string[]
  /** Claves de asesor seleccionadas (las que devuelve advisorKeyOf). */
  asesores: string[]
  /** Grafías crudas de "Origen de lead"; NO_VALUE_KEY alcanza a los sin dato. */
  origen: string[]
  /** Grafías crudas de "Canal de contacto"; NO_VALUE_KEY alcanza a los sin dato. */
  canal: string[]
  /** Nombres de Pauta; NO_PAUTA alcanza a los contactos sin ningún registro Pauta. */
  campanas: string[]
}

export const EMPTY_PANEL_FILTERS: PanelFilters = {
  desarrollos: [],
  asesores: [],
  origen: [],
  canal: [],
  campanas: [],
}

/** Cubeta centinela del asesor: la oportunidad que nadie tiene asignada. */
export const NO_ASESOR = "Sin asesor"

/**
 * Cubeta centinela de la campaña: el contacto no tiene NINGÚN registro Pauta.
 * Distinta de SIN_NOMBRE_CAMPAIGN ("Sin nombre"), que es una Pauta que sí
 * existe pero llegó sin nombre desde el escenario de Make.
 */
export const NO_PAUTA = "Sin Pauta"

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

/** De dónde salió la campaña de una oportunidad — ver resolveCampanas. */
export type CampanaSource = "meta" | "pauta" | "campo" | "none"

/** Las tablas de lookup de la campaña, armadas una vez en app/page.tsx. */
export interface CampanaContext {
  /**
   * `buildPautaNamesByContact` sobre las Pautas SIN filtrar y SIN acotar a
   * desarrollo: el registro pudo crearse fuera de la ventana de fechas.
   */
  pautaNamesByContact: ReadonlyMap<string, string[]>
  /** `buildMetaCampaignByAd(data.metaAds)`; vacío o ausente sin conexión con Meta. */
  metaCampaignByAd?: ReadonlyMap<string, string> | null
}

/**
 * Los nombres de campaña de una oportunidad, con una cadena de respaldo:
 *
 *   1. `meta` — la campaña de Meta de su anuncio, por ad id (`oppAdId`), solo si
 *      Meta está conectado y el anuncio vino en el sync. Los importados por CSV
 *      no toman este nivel, igual que no entran al costo por lead en
 *      meta-attribution: su ad id es una copia, no un click.
 *   2. `pauta` — los nombres de las Pautas del contacto. La Pauta cuelga del
 *      CONTACTO, igual que en "Rendimiento por pauta"; un contacto con dos
 *      Pautas tiene dos nombres, y marcar cualquiera de los dos lo alcanza.
 *   3. `campo` — el custom field "Nombre Pauta" de la propia oportunidad.
 *   4. `none` — [SIN_NOMBRE_CAMPAIGN] si el contacto tiene Pautas pero todas sin
 *      nombre, o [NO_PAUTA] si no tiene ninguna.
 *
 * Cada nivel entra solo cuando el anterior no dio un nombre: el respaldo llena
 * huecos, no agrega nombres, para no poner a una oportunidad en dos grafías de
 * la misma campaña. Un "Sin nombre" del escenario de Make tampoco tapa un
 * nombre que la oportunidad sí trae en su campo.
 *
 * Ojo con lo que eso implica: con Meta conectado, el menú mezcla nombres de
 * campaña de Meta (las oportunidades con ad id) con nombres de Pauta (las que
 * no lo tienen). Es la prioridad que pidió el cliente.
 */
export function resolveCampanas(
  opp: Opportunity,
  ctx: CampanaContext
): { names: string[]; source: CampanaSource } {
  if (ctx.metaCampaignByAd && ctx.metaCampaignByAd.size > 0 && !isImported(opp)) {
    const adId = oppAdId(opp)
    const fromMeta = adId ? ctx.metaCampaignByAd.get(adId) : undefined
    if (fromMeta) return { names: [fromMeta], source: "meta" }
  }

  const fromPauta = opp.contactId ? ctx.pautaNamesByContact.get(opp.contactId) ?? [] : []
  if (fromPauta.some((n) => n !== SIN_NOMBRE_CAMPAIGN)) return { names: fromPauta, source: "pauta" }

  const fromField = pautaNameFromCustomFields(opp.customFieldsResolved)
  if (fromField) return { names: [fromField], source: "campo" }

  return { names: fromPauta.length > 0 ? [SIN_NOMBRE_CAMPAIGN] : [NO_PAUTA], source: "none" }
}

/** Solo los nombres de resolveCampanas — lo que el filtro compara. */
export function campanasOf(opp: Opportunity, ctx: CampanaContext): string[] {
  return resolveCampanas(opp, ctx).names
}

/** Misma regla que meta-attribution: una importación masiva no es un click. */
function isImported(opp: Opportunity): boolean {
  return (opp.attributionMedium ?? "").toLowerCase() === "csv_import"
}

/** Una opción del menú de campaña: el nombre con su volumen. */
export interface CampanaOption {
  value: string
  count: number
  /** Cubeta centinela (NO_PAUTA / SIN_NOMBRE_CAMPAIGN): al final y en rojizo. */
  muted: boolean
}

/**
 * Opciones del menú de campaña sobre `opps`, por volumen descendente, con "Sin
 * nombre" y "Sin Pauta" fijas al final.
 *
 * `allowed` acota QUÉ nombres se listan — dentro de una pestaña de desarrollo,
 * solo las Pautas de ese desarrollo, para que Atria no ofrezca "Cañadas by El
 * Mirador". Pero el CONTEO se hace con el mismo mapa sin acotar que usa el
 * filtro, para que el número del menú sea exactamente lo que queda al marcarlo.
 * Por eso NO_PAUTA no depende de `allowed`: una oportunidad de Atria cuyo
 * contacto solo tiene Pautas de Cañadas no es "Sin Pauta" para el filtro.
 *
 * `allowed` solo acota los nombres que salen del OBJETO Pauta (que trae su
 * propio `desarrollo`). Los de Meta y del campo salen de la oportunidad misma,
 * que ya está en el embudo de la pestaña, así que se listan siempre.
 */
export function buildCampanaOptions(
  opps: Opportunity[],
  ctx: CampanaContext,
  allowed?: ReadonlySet<string> | null
): CampanaOption[] {
  const counts = new Map<string, number>()
  for (const o of opps) {
    const { names, source } = resolveCampanas(o, ctx)
    for (const name of names) {
      if (allowed && source === "pauta" && name !== SIN_NOMBRE_CAMPAIGN && !allowed.has(name)) continue
      counts.set(name, (counts.get(name) ?? 0) + 1)
    }
  }
  const sentinels = [SIN_NOMBRE_CAMPAIGN, NO_PAUTA]
  const named = [...counts.entries()]
    .filter(([name]) => !sentinels.includes(name))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "es"))
    .map(([value, count]) => ({ value, count, muted: false }))
  const tail = sentinels
    .filter((name) => counts.has(name))
    .map((value) => ({ value, count: counts.get(value)!, muted: true }))
  return [...named, ...tail]
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
  contactById?: Map<string, Contact>,
  /** Lookups de la campaña — ver resolveCampanas. */
  campanaCtx?: CampanaContext
): Opportunity[] {
  const byDesarrollo = filters.desarrollos.length > 0
  const byAsesor = filters.asesores.length > 0
  const byOrigen = filters.origen.length > 0
  const byCanal = filters.canal.length > 0
  const byCampana = filters.campanas.length > 0
  // Misma referencia cuando no hay nada que filtrar: una copia nueva
  // invalidaría los memos aguas abajo.
  if (!byDesarrollo && !byAsesor && !byOrigen && !byCanal && !byCampana) return opps

  const desarrollos = new Set(filters.desarrollos)
  const asesores = new Set(filters.asesores)
  // Los Sets de categoría se arman una vez, no una por oportunidad.
  const origen = new Set(filters.origen)
  const canal = new Set(filters.canal)
  const campanas = new Set(filters.campanas)
  // Sin contexto, ninguna fuente responde: todo cae en NO_PAUTA salvo el campo
  // de la propia oportunidad. Inventar una campaña sería peor.
  const ctx: CampanaContext = campanaCtx ?? { pautaNamesByContact: new Map() }

  return opps.filter((o) => {
    if (byDesarrollo && !desarrollos.has(desarrolloOf(o, pipelines))) return false
    if (byAsesor && !asesores.has(advisorKeyOf(o))) return false
    if (byOrigen && !matchesCategory(o, "origen", origen, contactById)) return false
    if (byCanal && !matchesCategory(o, "canal", canal, contactById)) return false
    if (byCampana && !campanasOf(o, ctx).some((n) => campanas.has(n))) return false
    return true
  })
}

/** Cuántas opciones hay marcadas en total — alimenta el aviso de "filtros activos". */
export function activeFilterCount(filters: PanelFilters): number {
  return (
    filters.desarrollos.length +
    filters.asesores.length +
    filters.origen.length +
    filters.canal.length +
    filters.campanas.length
  )
}

export { NO_DESARROLLO }
