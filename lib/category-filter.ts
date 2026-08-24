// Los menús de "Origen de lead" y "Canal de contacto" de la barra de filtros.
//
// Es la contraparte SIN AGRUPAR de lib/opportunity-breakdown.ts, y esa asimetría
// es el punto:
//
//   - El chart agrupa `Walk In` / `WALK IN` / `walk-in` en una barra, porque un
//     ranking partido en filas de un registro deja de responder "cuánto viene de
//     Walk In".
//   - El menú las lista por separado, porque una grafía repetida es un error de
//     captura que el dueño del CRM tiene que corregir en GHL — y no puede
//     corregir lo que no ve.
//
// Por eso NO fusiones los dos módulos. La normalización se usa aquí solo para
// ordenar (que las variantes salgan pegadas) y para marcar cuántas hay; nunca
// para unir dos opciones en una.
import type { Opportunity } from "./types"
import {
  CANAL_FIELDS,
  categoryValuesOf,
  normalizeCategoryKey,
  NO_VALUE_KEY,
  NO_VALUE_LABEL,
  ORIGEN_FIELDS,
} from "./opportunity-breakdown"

export type CategoryDimension = "origen" | "canal"

export const CATEGORY_DIMENSIONS: Record<
  CategoryDimension,
  { label: string; fields: string[] }
> = {
  origen: { label: "Origen de lead", fields: ORIGEN_FIELDS },
  canal: { label: "Canal de contacto", fields: CANAL_FIELDS },
}

export interface CategoryOption {
  /** La grafía cruda: es a la vez el valor guardado y lo que se pinta. */
  value: string
  label: string
  count: number
  /**
   * Clave del grupo al que pertenece la grafía. SOLO para ordenar y para contar
   * variantes — dos opciones con el mismo groupKey siguen siendo dos opciones.
   */
  groupKey: string
  /** Cuántas grafías tiene su grupo. 1 = no hay error de captura que mostrar. */
  variantCount: number
  /** La cubeta "Sin dato": va al final y en gris, como "Sin sucursal". */
  muted?: boolean
}

/**
 * Las grafías distintas de una oportunidad en esa dimensión, ya recortadas.
 * Sin valor devuelve [NO_VALUE_KEY]: "Sin dato" es una opción más del menú, no
 * un hueco.
 *
 * Se deduplica por cadena exacta ("Meta, Meta" es un solo valor) pero NO por
 * clave: "Meta, meta" son dos grafías y cuentan en las dos opciones.
 */
export function categorySpellingsOf(
  opp: Opportunity,
  dimension: CategoryDimension
): string[] {
  const values = categoryValuesOf(opp, CATEGORY_DIMENSIONS[dimension].fields)
  if (values.length === 0) return [NO_VALUE_KEY]
  return [...new Set(values)]
}

/**
 * ¿Pasa esta oportunidad el menú de esa dimensión? Selección vacía = pasa todo.
 *
 * Recibe un Set y no un arreglo porque se llama una vez por oportunidad dentro
 * del filter() de applyPanelFilters; el llamador lo arma una sola vez.
 */
export function matchesCategory(
  opp: Opportunity,
  dimension: CategoryDimension,
  selected: ReadonlySet<string>
): boolean {
  if (selected.size === 0) return true
  return categorySpellingsOf(opp, dimension).some((v) => selected.has(v))
}

/**
 * Una opción por grafía distinta, ordenada en dos niveles: los grupos por su
 * total descendente, y dentro de cada grupo las grafías por su propio conteo.
 *
 * Ese orden es lo que hace visible el error: ordenado solo por conteo, "WALK IN"
 * con 2 registros quedaría treinta filas debajo de "Walk In" con 31, y nadie
 * notaría que son el mismo valor mal capturado.
 *
 * Los empates se rompen alfabéticamente para que el orden sea estable entre
 * renders. "Sin dato" siempre al final: es una fuga de atribución, no una
 * categoría que compita en el ranking.
 */
export function buildCategoryOptions(
  opps: Opportunity[],
  dimension: CategoryDimension
): CategoryOption[] {
  const counts = new Map<string, number>()
  for (const opp of opps) {
    for (const spelling of categorySpellingsOf(opp, dimension)) {
      counts.set(spelling, (counts.get(spelling) ?? 0) + 1)
    }
  }

  // Totales y número de grafías por grupo — los dos niveles del orden.
  const groupTotals = new Map<string, number>()
  const groupSpellings = new Map<string, number>()
  for (const [value, n] of counts) {
    if (value === NO_VALUE_KEY) continue
    const groupKey = normalizeCategoryKey(value)
    groupTotals.set(groupKey, (groupTotals.get(groupKey) ?? 0) + n)
    groupSpellings.set(groupKey, (groupSpellings.get(groupKey) ?? 0) + 1)
  }

  const options: CategoryOption[] = []
  for (const [value, count] of counts) {
    if (value === NO_VALUE_KEY) continue
    const groupKey = normalizeCategoryKey(value)
    options.push({
      value,
      label: value,
      count,
      groupKey,
      variantCount: groupSpellings.get(groupKey) ?? 1,
    })
  }

  options.sort((a, b) => {
    if (a.groupKey !== b.groupKey) {
      const byGroup = (groupTotals.get(b.groupKey) ?? 0) - (groupTotals.get(a.groupKey) ?? 0)
      if (byGroup !== 0) return byGroup
      return a.groupKey.localeCompare(b.groupKey, "es")
    }
    return b.count - a.count || a.value.localeCompare(b.value, "es")
  })

  const sinDato = counts.get(NO_VALUE_KEY) ?? 0
  if (sinDato > 0) {
    options.push({
      value: NO_VALUE_KEY,
      label: NO_VALUE_LABEL,
      count: sinDato,
      groupKey: NO_VALUE_KEY,
      variantCount: 1,
      muted: true,
    })
  }

  return options
}

/**
 * Añade al final, con conteo 0, las grafías marcadas que ya no están en la
 * lista — porque se movió el rango de fechas, o se cambió de pestaña y ese valor
 * no existe en el otro pipeline.
 *
 * Sin esto queda un filtro activo invisible: el panel sale vacío y el menú no
 * ofrece manera de apagarlo.
 */
export function withPinnedSelection(
  options: CategoryOption[],
  selected: string[]
): CategoryOption[] {
  const present = new Set(options.map((o) => o.value))
  const missing = selected.filter((v) => !present.has(v))
  if (missing.length === 0) return options

  return [
    ...options,
    ...missing.map((value) => ({
      value,
      label: value === NO_VALUE_KEY ? NO_VALUE_LABEL : value,
      count: 0,
      groupKey: value === NO_VALUE_KEY ? NO_VALUE_KEY : normalizeCategoryKey(value),
      variantCount: 1,
      muted: true,
    })),
  ]
}
