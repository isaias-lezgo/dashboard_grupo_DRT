// La agencia que opera la pauta de una oportunidad: Domus, Genicrea o Inhouse.
//
// Sale de la nomenclatura de campañas de marketing (V1, sep 2026):
//
//   CAN-DOM-WSP-C3-A7  →  desarrollo · AGENCIA · tipo · campaña · anuncio
//
// con DOM = Domus, GEN = Genicrea, INH = Inhouse. La nomenclatura apenas empieza
// a aplicarse (medido 2026-09-23: una sola oportunidad la trae), así que también
// se reconoce el nombre completo de la agencia dentro de los nombres viejos
// ("CAÑADA | Domus |  FORM 2 Jul", "Form.Saggita - Inhouse") y en el `source`
// que el equipo ya captura a mano ("Campaña Inhouse").
//
// Puro y sin React: scripts/verify-panel-filters.ts lo afirma.
import type { Contact, Opportunity } from "./types"

export const AGENCIAS = ["Domus", "Genicrea", "Inhouse"] as const
export type Agencia = (typeof AGENCIAS)[number]

/** Cubeta centinela: ninguna fuente nombra una agencia. */
export const NO_AGENCIA = "Sin agencia"

const CODE_TO_AGENCIA: Record<string, Agencia> = { DOM: "Domus", GEN: "Genicrea", INH: "Inhouse" }

/**
 * Código de agencia en la SEGUNDA posición, detrás de un código de desarrollo.
 * Se exige el desarrollo delante porque "GEN" suelto aparece en texto libre; los
 * separadores toleran espacios ("ATR - DOM - FORM - C2" ya circula así).
 */
const NOMENCLATURA = /(?:^|[^A-Z0-9])(?:CAN|ATR|SIE|SAG|PAL|ZAN)\s*[-_|]\s*(DOM|GEN|INH)(?![A-Z0-9])/

/** El nombre completo, en cualquier parte del texto. */
const NOMBRE_COMPLETO: Array<[RegExp, Agencia]> = [
  [/\bDOMUS\b/, "Domus"],
  [/\bGENICREA\b/, "Genicrea"],
  [/\bIN[\s-]?HOUSE\b/, "Inhouse"],
]

/** La agencia que nombra un texto (nombre de Pauta, campaña, source), o null. */
export function detectAgencia(text: string | null | undefined): Agencia | null {
  if (!text) return null
  const t = text.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase()
  const code = t.match(NOMENCLATURA)
  if (code) return CODE_TO_AGENCIA[code[1]]
  for (const [re, agencia] of NOMBRE_COMPLETO) if (re.test(t)) return agencia
  return null
}

/** De dónde salió la agencia — ver resolveAgencias. */
export type AgenciaSource = "pauta" | "atribucion" | "source" | "none"

/**
 * La última atribución de la oportunidad (`isLast`, o la última del arreglo), o
 * la del contacto si la oportunidad no trae ninguna.
 */
function lastAttribution(
  opp: Opportunity,
  contactById?: ReadonlyMap<string, Contact>
): Record<string, unknown> | undefined {
  const attrs = opp.attributions?.length
    ? opp.attributions
    : contactById?.get(opp.contactId)?.attributions
  if (!attrs?.length) return undefined
  return attrs.find((a) => a.isLast) ?? attrs[attrs.length - 1]
}

/**
 * Las agencias de una oportunidad, con una cadena de respaldo — cada nivel solo
 * cuando el anterior no nombró ninguna:
 *
 *   1. `pauta` — los nombres de las Pautas del contacto. Un contacto con Pautas
 *      de dos agencias tiene las dos, igual que en el filtro de campaña.
 *   2. `atribucion` — la ÚLTIMA atribución: su campaña (`utmCampaign`) y, si no,
 *      el nombre del anuncio (`adName`), que la nomenclatura también cubre.
 *   3. `source` — el source de la oportunidad ("Campaña Inhouse").
 *   4. `none` — [NO_AGENCIA].
 *
 * `pautaNamesByContact` es el mismo mapa sin acotar que usa la campaña.
 */
export function resolveAgencias(
  opp: Opportunity,
  pautaNamesByContact: ReadonlyMap<string, string[]>,
  contactById?: ReadonlyMap<string, Contact>
): { names: string[]; source: AgenciaSource } {
  const fromPauta = new Set<string>()
  for (const name of pautaNamesByContact.get(opp.contactId) ?? []) {
    const a = detectAgencia(name)
    if (a) fromPauta.add(a)
  }
  if (fromPauta.size > 0) {
    return { names: AGENCIAS.filter((a) => fromPauta.has(a)), source: "pauta" }
  }

  const last = lastAttribution(opp, contactById)
  const fromAttr =
    detectAgencia(last?.utmCampaign as string | undefined) ??
    detectAgencia(last?.adName as string | undefined)
  if (fromAttr) return { names: [fromAttr], source: "atribucion" }

  const fromSource = detectAgencia(opp.source)
  if (fromSource) return { names: [fromSource], source: "source" }

  return { names: [NO_AGENCIA], source: "none" }
}

/** Una opción del menú de agencia con su volumen. */
export interface AgenciaOption {
  value: string
  count: number
  muted: boolean
}

/**
 * Las tres agencias SIEMPRE, en su orden fijo y aunque estén en cero — una
 * agencia que todavía no aparece en los datos es un dato, no una opción a
 * esconder —, y "Sin agencia" al final.
 */
export function buildAgenciaOptions(
  opps: Opportunity[],
  pautaNamesByContact: ReadonlyMap<string, string[]>,
  contactById?: ReadonlyMap<string, Contact>
): AgenciaOption[] {
  const counts = new Map<string, number>()
  for (const o of opps) {
    for (const name of resolveAgencias(o, pautaNamesByContact, contactById).names) {
      counts.set(name, (counts.get(name) ?? 0) + 1)
    }
  }
  return [
    ...AGENCIAS.map((value) => ({ value, count: counts.get(value) ?? 0, muted: false })),
    { value: NO_AGENCIA, count: counts.get(NO_AGENCIA) ?? 0, muted: true },
  ]
}
