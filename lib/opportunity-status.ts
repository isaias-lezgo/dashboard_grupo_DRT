// Canonical "won" detection, shared by the Marketing and Ventas dashboards so
// every won-based metric (counts, revenue, close rate, funnel) agrees.
//
// Some sub-accounts never flip GHL's `status` to "won": they record the sale by
// moving the opportunity into a late pipeline stage such as "09. Negocio Ganado"
// ("Closed Won") while leaving `status === "open"`. Treat either signal as a win
// so the dashboards work regardless of how a location operates. Detection is
// stage-name based (no hardcoded stage IDs) to stay portable across locations.
import type { Opportunity } from "./types"

// "Negocio Ganado" / "Negocio Ganada(s)" (es) and "Won" / "Closed Won" (en).
// Word-boundary on "won" avoids matching it as a substring of unrelated words.
const WON_STAGE_PATTERN = /ganad[oa]|\bwon\b/i

export function isWonOpp(opp: Opportunity): boolean {
  if (opp.status === "won") return true
  // An explicitly lost/abandoned opp is never a win, even if it lingers in a
  // stage whose name happens to match (e.g. moved then marked lost).
  if (opp.status === "lost" || opp.status === "abandoned") return false
  return WON_STAGE_PATTERN.test(opp.stage ?? "")
}
