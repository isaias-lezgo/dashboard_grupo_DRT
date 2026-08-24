// Single source of truth for what each business-line panel *is*.
//
// In this deployment the pipeline IS the business line: every chart in the VAEO
// tab counts only opportunities in the VAEO pipeline, and likewise for MESH.
// Both pipelines live in the same GHL sub-account, so the split is client-side.
//
// The sucursal lives in a DIFFERENT custom field per panel ("Sucursal VAEO" vs
// "Sucursal MESH"), which is why the field name is part of the scope and not
// hardcoded in a chart.
import type { Opportunity, Pipeline } from "./types"

export type PanelId = "vaeo" | "mesh"

export interface PanelScope {
  /** Pipeline name as it reads in GHL; also the matching key. */
  label: string
  /** Fallback only — used when no pipeline matches by name. */
  pipelineId: string
  /** Name of the opportunity custom field holding the branch. */
  sucursalField: string
}

export const PANEL_SCOPES: Record<PanelId, PanelScope> = {
  vaeo: {
    label: "VAEO",
    pipelineId: "MiATYfkJWklaXqYc7hOr",
    sucursalField: "Sucursal VAEO",
  },
  mesh: {
    label: "MESH",
    pipelineId: "DkZiRWdizgMRt7osjuRb",
    sucursalField: "Sucursal MESH",
  },
}

/**
 * Resolve the panel's pipeline id, preferring a NAME match over the hardcoded
 * id. Same reasoning as isWonOpp()'s stage matching: a pipeline that gets
 * recreated keeps its name but not its id.
 */
export function resolvePipelineId(
  pipelines: Pipeline[] | undefined,
  panel: PanelId
): string {
  const scope = PANEL_SCOPES[panel]
  const match = pipelines?.find(
    (p) => p.name.trim().toLowerCase() === scope.label.toLowerCase()
  )
  return match?.id ?? scope.pipelineId
}

/** Every opportunity that belongs to this panel's business line. */
export function scopeOpportunities(
  opps: Opportunity[],
  panel: PanelId,
  pipelines?: Pipeline[]
): Opportunity[] {
  const pipelineId = resolvePipelineId(pipelines, panel)
  return opps.filter((o) => o.pipelineId === pipelineId)
}
