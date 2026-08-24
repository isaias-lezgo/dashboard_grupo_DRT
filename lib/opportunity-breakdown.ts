// Agregación detrás de los tres gráficos portados del reporte de Looker:
// "Oportunidades por estado" (barras apiladas por mes) y los rankings de
// "Origen de Lead" / "Canal de Contacto".
//
// Puro y sin React para que scripts/verify-breakdown.ts lo pueda aseverar: un
// número silenciosamente mal aquí es invisible en la UI, que es justo la clase
// de bug por la que existen los scripts de verificación.
import type { Contact, Opportunity } from "./types"
import { isWonOpp } from "./opportunity-status"

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------

export type StatusBucket = "ganada" | "abierta" | "perdida"

export const STATUS_BUCKETS: StatusBucket[] = ["ganada", "abierta", "perdida"]

export const STATUS_LABELS: Record<StatusBucket, string> = {
  ganada: "Ganadas",
  abierta: "Abiertas",
  perdida: "Perdidas",
}

/**
 * La cubeta de una oportunidad. "Ganada" se decide con isWonOpp(), no con el
 * `status` crudo: algunas cuentas registran la venta moviendo la oportunidad a
 * una etapa "Ganado" sin tocar el status, y el resto del panel ya cuenta así.
 *
 * `abandoned` se pliega en "perdida" a propósito — no es una venta, y una cuarta
 * serie en un apilado cuesta más legibilidad de la que aporta.
 */
export function statusBucket(opp: Opportunity): StatusBucket {
  if (isWonOpp(opp)) return "ganada"
  if (opp.status === "lost" || opp.status === "abandoned") return "perdida"
  return "abierta"
}

export interface StatusMonthRow {
  /** `YYYY-MM`, o NO_DATE_KEY para la fila sin fecha. */
  key: string
  label: string
  ganada: number
  abierta: number
  perdida: number
  total: number
  /** Ids por cubeta, para el drill-down. */
  ids: Record<StatusBucket, string[]>
}

export const NO_DATE_KEY = "sin-fecha"
export const NO_DATE_LABEL = "Sin fecha"

const MONTHS_ES = [
  "ene", "feb", "mar", "abr", "may", "jun",
  "jul", "ago", "sep", "oct", "nov", "dic",
]

// Los tres helpers de mes se exportan —no son detalle interno— porque otros
// charts arman su propio eje mensual y tienen que rellenar los meses vacíos
// EXACTAMENTE igual: hoy lib/assignment-funnel.ts y lost-by-dimension-chart.tsx,
// este último para que una perdida caiga en el mismo mes en que "Oportunidades
// por estado" pone ese lead. Dos copias del relleno se desincronizan a la primera
// corrección y nadie lo nota: los charts simplemente dejan de compartir el eje.
export function monthKeyOf(iso: string | undefined): string | null {
  if (!iso) return null
  const d = new Date(iso)
  const t = d.getTime()
  if (Number.isNaN(t)) return null
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
}

export function monthLabelOf(key: string): string {
  const [year, month] = key.split("-")
  return `${MONTHS_ES[Number(month) - 1]} ${year}`
}

function emptyRow(key: string, label: string): StatusMonthRow {
  return {
    key,
    label,
    ganada: 0,
    abierta: 0,
    perdida: 0,
    total: 0,
    ids: { ganada: [], abierta: [], perdida: [] },
  }
}

/** Todos los `YYYY-MM` de `from` a `to` inclusive, en orden. */
export function monthsBetween(from: string, to: string): string[] {
  const [fy, fm] = from.split("-").map(Number)
  const [ty, tm] = to.split("-").map(Number)
  const out: string[] = []
  for (let y = fy, m = fm; y < ty || (y === ty && m <= tm); m++) {
    if (m > 12) { m = 1; y++ }
    if (y > ty || (y === ty && m > tm)) break
    out.push(`${y}-${String(m).padStart(2, "0")}`)
  }
  return out
}

/**
 * Una fila por mes de `createdAt`, con el conteo de cada cubeta y los ids que la
 * componen.
 *
 * Los meses intermedios sin ningún registro se rellenan en cero, para que el eje
 * no insinúe continuidad donde no la hay: sin eso, un hueco de tres meses se
 * dibuja como si fueran dos meses consecutivos.
 *
 * Las oportunidades sin `createdAt` legible caen en una fila "Sin fecha" al
 * final en vez de desaparecer.
 */
export function buildStatusByMonth(opps: Opportunity[]): StatusMonthRow[] {
  const byMonth = new Map<string, StatusMonthRow>()
  let noDate: StatusMonthRow | null = null

  for (const opp of opps) {
    const key = monthKeyOf(opp.createdAt)
    let row: StatusMonthRow
    if (key === null) {
      noDate ??= emptyRow(NO_DATE_KEY, NO_DATE_LABEL)
      row = noDate
    } else {
      row = byMonth.get(key) ?? emptyRow(key, monthLabelOf(key))
      byMonth.set(key, row)
    }
    const bucket = statusBucket(opp)
    row[bucket] += 1
    row.total += 1
    row.ids[bucket].push(opp.id)
  }

  const keys = [...byMonth.keys()].sort()
  const rows =
    keys.length === 0
      ? []
      : monthsBetween(keys[0], keys[keys.length - 1]).map(
          (k) => byMonth.get(k) ?? emptyRow(k, monthLabelOf(k))
        )

  if (noDate) rows.push(noDate)
  return rows
}

// ---------------------------------------------------------------------------
// Categorías (Origen de Lead / Canal de Contacto)
// ---------------------------------------------------------------------------

/**
 * Los dos campos por concepto que existen en la sub-cuenta: el de texto libre,
 * que es el que el equipo llena, y un gemelo de picklist creado después que
 * apenas alcanza el 8% de poblado. Se lee el primero y se cae al segundo solo
 * cuando viene vacío.
 */
// Las grafías varían por subcuenta ("Origen de Lead" / "Origen de lead"), así
// que la búsqueda ignora mayúsculas — ver fieldValues(). La lista sigue
// existiendo porque el ORDEN sí importa: es la preferencia entre campos
// DISTINTOS, no entre grafías del mismo.
export const ORIGEN_FIELDS = ["Origen de Lead", "Origen del lead"]
export const CANAL_FIELDS = ["Canal de Contacto", "Canal del contacto", "Canal"]

export const NO_VALUE_LABEL = "Sin dato"

/**
 * Clave de la cubeta "Sin dato", para los menús de filtro. Empieza con un byte
 * nulo para que ninguna grafía capturada por una persona pueda colisionar con
 * ella — es un valor seleccionable más, no un hueco.
 */
export const NO_VALUE_KEY = "\u0000sin-dato"

/**
 * Clave de agrupamiento: minúsculas, sin acentos, y todo lo que no sea
 * alfanumérico colapsado a un espacio. Es lo que hace que `Walk In` / `Walk-in`,
 * `Activo Seo` / `Activo SEO` y `WHATSAPP` / `WhatsApp` caigan solos en el mismo
 * grupo, sin que haya que enumerar las variantes una por una.
 */
export function categoryKey(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

/**
 * Etiqueta oficial por clave — los valores del picklist de GHL, que es la grafía
 * que el cliente reconoce. Una clave que no esté aquí NO se descarta: muestra la
 * grafía más frecuente entre sus propios registros, así que un valor nuevo que el
 * equipo capture mañana aparece solo en el gráfico.
 */
const CANONICAL_LABELS: Record<string, string> = {
  // Origen de Lead
  "meta": "Meta",
  "sitio web": "Sitio Web",
  "no identificado": "No Identificado",
  "activo seo": "Activo SEO",
  "google ads": "Google ADs",
  "mailing": "Mailing",
  "cliente existente": "Cliente Existente",
  "walk in": "Walk In",
  "referido de asociado": "Referido de Asociado",
  "blog vaeo": "Blog VAEO",
  "inmobiliario": "Inmobiliario",
  "convenio": "Convenio",
  "correo info vaeo": "Correo Info VAEO",
  "evento patrocinado": "Evento Patrocinado",
  // Canal de Contacto
  "whatsapp": "WhatsApp",
  "dm": "DM",
  "formulario": "Formulario",
  "llamada": "Llamada",
  "manual": "Manual",
  "correo electronico": "Correo electrónico",
  "pagina web": "Página WEB",
  "facebook": "Facebook",
  "instagram": "Instagram",
  "messenger": "Messenger",
  "visita": "Visita",
  "youtube": "YouTube",
  "tiktok": "TikTok",
  "webinar": "Webinar",
  "linkedin": "LinkedIn",
}

/**
 * Grafías que la clave NO logra unir porque son palabras distintas, no una
 * variante de mayúsculas o guiones. Se mapea clave → clave.
 */
const KEY_ALIASES: Record<string, string> = {
  "inmobiliaria": "inmobiliario",
  "correo infovaeo": "correo info vaeo",
}

/**
 * La clave definitiva de agrupamiento: `categoryKey()` más los alias. Es la que
 * decide qué grafías son "el mismo valor".
 *
 * Existe como función exportada, y no en línea dentro de buildCategoryBreakdown,
 * porque lib/category-filter.ts la necesita para ordenar su menú. Dos
 * definiciones separadas harían que un alias nuevo dejara de agrupar en un lado
 * — y eso no truena, solo separa dos filas que debían ir juntas.
 */
export function normalizeCategoryKey(raw: string): string {
  const key = categoryKey(raw)
  return KEY_ALIASES[key] ?? key
}

function cfValues(v: string | string[] | undefined): string[] {
  if (v === undefined) return []
  return Array.isArray(v) ? v : [v]
}

/**
 * Los valores de categoría de una oportunidad, ya partidos.
 *
 * Tres registros traen dos valores en una sola celda de texto ("Meta, Sitio
 * Web"), así que se parte por coma y la oportunidad cuenta en CADA categoría que
 * nombra: genuinamente tiene los dos orígenes. Esto hace que los porcentajes
 * sumen un pelo más de 100%, lo cual se explica en el tooltip del gráfico en vez
 * de esconderse tras una regla de "gana el primero" que perdería información.
 */
/**
 * Los valores de `fieldNames` en un mapa de campos resueltos, ignorando
 * mayúsculas en el NOMBRE del campo.
 *
 * Primero intenta el match exacto, que es el caso común y no cuesta nada; solo
 * si no encuentra recorre las claves comparando en minúsculas. Sin eso, una
 * subcuenta que escribe "Origen de lead" en vez de "Origen de Lead" reporta
 * 100% "Sin dato" — silencioso, plausible y completamente falso.
 */
function fieldValues(
  resolved: Record<string, string | string[]> | undefined,
  fieldNames: string[]
): string[] {
  if (!resolved) return []
  const split = (v: string | string[] | undefined) =>
    cfValues(v)
      .flatMap((s) => String(s).split(","))
      .map((s) => s.trim())
      .filter((s) => s !== "")

  for (const name of fieldNames) {
    const exact = split(resolved[name])
    if (exact.length > 0) return exact
  }
  for (const name of fieldNames) {
    const target = name.toLowerCase()
    for (const key of Object.keys(resolved)) {
      if (key.toLowerCase() !== target) continue
      const parts = split(resolved[key])
      if (parts.length > 0) return parts
    }
  }
  return []
}

/**
 * La categoría de una oportunidad, buscándola PRIMERO en la oportunidad y, si
 * no la trae, en su contacto.
 *
 * Esa segunda vuelta no es un extra: en esta subcuenta `Origen de lead` y
 * `Canal de contacto` son campos del CONTACTO y la oportunidad no los tiene
 * nunca. Sin el fallback los dos gráficos de categoría, la tabla de motivos y un
 * eje del cruce salen 100% "Sin dato" sobre 10,311 oportunidades.
 *
 * El orden importa y es el correcto: si algún día la oportunidad llegara a
 * llenar el campo, ese valor es el más específico y debe ganar.
 */
export function categoryValuesOf(
  opp: Opportunity,
  fieldNames: string[],
  contactById?: Map<string, Contact>
): string[] {
  const own = fieldValues(opp.customFieldsResolved, fieldNames)
  if (own.length > 0) return own
  const contact = opp.contactId ? contactById?.get(opp.contactId) : undefined
  return fieldValues(contact?.customFieldsResolved, fieldNames)
}

export interface CategoryRow {
  /** Clave normalizada del grupo; NO_VALUE_KEY en la fila "Sin dato". */
  key: string
  label: string
  count: number
  /** Porcentaje sobre el total de oportunidades, 0–100. */
  pct: number
  oppIds: string[]
}

/**
 * Ranking de categorías, de mayor a menor. Las oportunidades sin valor caen en
 * "Sin dato", que siempre va al final aunque sea grande: es una fila de fuga de
 * atribución, no una categoría más que compita en el ranking.
 */
export function buildCategoryBreakdown(
  opps: Opportunity[],
  fieldNames: string[],
  /** Para resolver categorías que viven en el contacto — ver categoryValuesOf. */
  contactById?: Map<string, Contact>
): CategoryRow[] {
  // clave → { conteo por grafía cruda, ids }
  interface Group {
    spellings: Map<string, number>
    oppIds: string[]
  }
  const groups = new Map<string, Group>()
  const missing: string[] = []

  for (const opp of opps) {
    const values = categoryValuesOf(opp, fieldNames, contactById)
    if (values.length === 0) {
      missing.push(opp.id)
      continue
    }
    // Una misma celda podría repetir un valor ("Meta, meta"); no cuenta doble.
    const seen = new Set<string>()
    for (const raw of values) {
      const key = normalizeCategoryKey(raw)
      if (key === "" || seen.has(key)) continue
      seen.add(key)
      const g: Group = groups.get(key) ?? { spellings: new Map(), oppIds: [] }
      g.spellings.set(raw, (g.spellings.get(raw) ?? 0) + 1)
      g.oppIds.push(opp.id)
      groups.set(key, g)
    }
  }

  const total = opps.length
  const pctOf = (n: number) => (total === 0 ? 0 : (n / total) * 100)

  const rows: CategoryRow[] = [...groups.entries()]
    .map(([key, g]) => ({
      key,
      label: CANONICAL_LABELS[key] ?? mostFrequent(g.spellings),
      count: g.oppIds.length,
      pct: pctOf(g.oppIds.length),
      oppIds: g.oppIds,
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "es"))

  if (missing.length > 0) {
    rows.push({
      key: NO_VALUE_KEY,
      label: NO_VALUE_LABEL,
      count: missing.length,
      pct: pctOf(missing.length),
      oppIds: missing,
    })
  }
  return rows
}

/** La grafía más usada del grupo; empate desempatado alfabéticamente, estable. */
export function mostFrequent(spellings: Map<string, number>): string {
  let best = ""
  let bestN = -1
  for (const [spelling, n] of spellings) {
    if (n > bestN || (n === bestN && spelling.localeCompare(best, "es") < 0)) {
      best = spelling
      bestN = n
    }
  }
  return best
}
