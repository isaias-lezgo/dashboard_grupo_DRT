// Canonical "won" detection, shared by the Marketing and Ventas dashboards so
// every won-based metric (counts, revenue, close rate, funnel) agrees.
//
// Some sub-accounts never flip GHL's `status` to "won": they record the sale by
// moving the opportunity into a late pipeline stage such as "09. Negocio Ganado"
// ("Closed Won") while leaving `status === "open"`. Treat either signal as a win
// so the dashboards work regardless of how a location operates. Detection is
// stage-name based (no hardcoded stage IDs) to stay portable across locations.
//
// Grupo DRT es exactamente ese caso, con otro vocabulario: su etapa ganadora se
// llama "08. Venta", no "Ganado". Medido el 2026-08-24 sobre los seis embudos:
// 74 oportunidades están en "08. Venta" pero solo 47 de ellas traen
// `status: "won"`. Sin "venta" en el patrón el panel reportaría 47 ventas en vez
// de las 74 reales — la fuga silenciosa que este módulo existe para evitar.
import type { Opportunity } from "./types"

// "Negocio Ganado" / "Negocio Ganada(s)" (es), "08. Venta" / "Ventas" (es) y
// "Won" / "Closed Won" (en). El límite de palabra en "won" evita que case como
// subcadena de palabras ajenas, y el de "venta" evita "Ventana" o "Aventaja".
const WON_STAGE_PATTERN = /ganad[oa]|\bwon\b|\bventas?\b/i

export function isWonOpp(opp: Opportunity): boolean {
  if (opp.status === "won") return true
  // An explicitly lost/abandoned opp is never a win, even if it lingers in a
  // stage whose name happens to match (e.g. moved then marked lost).
  if (opp.status === "lost" || opp.status === "abandoned") return false
  return WON_STAGE_PATTERN.test(opp.stage ?? "")
}
