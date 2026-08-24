// Single source of truth for what each panel *is*.
//
// En esta subcuenta el pipeline ES el desarrollo: cada pestaña de desarrollo
// cuenta solo las oportunidades de su embudo, y los seis embudos viven en la
// misma subcuenta de GHL, así que el corte es del lado del cliente.
//
// La pestaña GENERAL es la excepción y su alcance es DELIBERADAMENTE "todas las
// oportunidades", no "las de los seis desarrollos que conocemos": cuando DRT
// abra un séptimo desarrollo, sus leads entran a GENERAL y al menú de desarrollo
// el mismo día, sin tocar código. Solo la pestaña propia hay que agregarla aquí.
//
// A diferencia del panel del que salió este código, aquí NO hay un campo
// personalizado de sucursal: la dimensión geográfica/comercial es el desarrollo,
// y el desarrollo se lee del embudo. Por eso `desarrolloOf` recibe la lista de
// pipelines en vez de un nombre de campo.
import type { Opportunity, Pipeline } from "./types"

export type PanelId =
  | "general"
  | "atria"
  | "canadas"
  | "lasierra"
  | "palmyra"
  | "saggita"
  | "zanda"

export interface PanelScope {
  /** Nombre del desarrollo tal como se lee en GHL; también la llave de match. */
  label: string
  /**
   * Solo fallback — se usa cuando ningún pipeline coincide por nombre.
   * `null` es GENERAL: no acota a ningún embudo.
   */
  pipelineId: string | null
}

export const PANEL_SCOPES: Record<PanelId, PanelScope> = {
  general: { label: "General", pipelineId: null },
  atria: { label: "Atria", pipelineId: "0HGe4sGXe7v6Keo2Fk7v" },
  canadas: { label: "Cañadas", pipelineId: "ChCZUhFDe5m0RSNp4qbb" },
  lasierra: { label: "La Sierra", pipelineId: "gRHIvjxjQ2vvHSXQjfC2" },
  palmyra: { label: "Palmyra", pipelineId: "jNQOWHy6JLW5Mbb18l7t" },
  saggita: { label: "Saggita", pipelineId: "5FZvtr1HjvpLDXjcHxfx" },
  zanda: { label: "Zanda", pipelineId: "1f8VurvKrPgbwYrmBo2m" },
}

/** Las pestañas de desarrollo, en el orden en que se dibujan. */
export const DESARROLLO_PANELS = [
  "atria",
  "canadas",
  "lasierra",
  "palmyra",
  "saggita",
  "zanda",
] as const satisfies readonly PanelId[]

/** Cubeta centinela para la oportunidad cuyo embudo no resolvemos. */
export const NO_DESARROLLO = "Sin desarrollo"

/** Sin acentos y en minúsculas: "Cañadas" tiene que casar con la llave `canadas`. */
function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
}

/**
 * Resuelve el pipeline del panel, prefiriendo el match por NOMBRE sobre el id
 * hardcodeado. Mismo razonamiento que el match por etapa de isWonOpp(): un
 * embudo que se recrea conserva su nombre, no su id.
 *
 * Devuelve `null` para GENERAL, que no acota a ningún embudo.
 */
export function resolvePipelineId(
  pipelines: Pipeline[] | undefined,
  panel: PanelId
): string | null {
  const scope = PANEL_SCOPES[panel]
  if (scope.pipelineId === null) return null
  const match = pipelines?.find(
    (p) => normalize(p.name) === normalize(scope.label)
  )
  return match?.id ?? scope.pipelineId
}

/**
 * Todas las oportunidades que le tocan a este panel.
 *
 * GENERAL devuelve la MISMA referencia, no una copia: igual que
 * applyPanelFilters, una copia nueva invalidaría los memos aguas abajo en la
 * pestaña que más datos maneja.
 */
export function scopeOpportunities(
  opps: Opportunity[],
  panel: PanelId,
  pipelines?: Pipeline[]
): Opportunity[] {
  const pipelineId = resolvePipelineId(pipelines, panel)
  if (pipelineId === null) return opps
  return opps.filter((o) => o.pipelineId === pipelineId)
}

/**
 * El desarrollo de una oportunidad: el nombre de su embudo.
 *
 * Se resuelve contra la lista de pipelines que trae el sync, así que un
 * desarrollo nuevo aparece con su nombre real sin tocar PANEL_SCOPES.
 */
export function desarrolloOf(
  opp: Opportunity,
  pipelines: Pipeline[] | undefined
): string {
  const name = pipelines?.find((p) => p.id === opp.pipelineId)?.name?.trim()
  return name || NO_DESARROLLO
}

/**
 * Los desarrollos presentes en el set, ordenados y sin la cubeta vacía — el
 * menú la agrega aparte para que quede siempre al final.
 */
export function collectDesarrollos(
  opps: Opportunity[],
  pipelines: Pipeline[] | undefined
): string[] {
  const seen = new Set<string>()
  for (const o of opps) {
    const d = desarrolloOf(o, pipelines)
    if (d !== NO_DESARROLLO) seen.add(d)
  }
  return [...seen].sort((a, b) => a.localeCompare(b, "es"))
}
