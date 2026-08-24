// Single source of truth for "this opportunity arrived already closed from the
// HubSpot migration" — the panel-wide "Importación HubSpot" toggle.
//
// Grupo VAEO migrated from HubSpot on 2026-03-20: every migrated opportunity in
// the VAEO pipeline carries that same `createdAt`. Deals that HubSpot had
// ALREADY closed came over with their old close date rewritten into the
// migration month, so 485 of the 648 won opportunities pile onto mar 2026 and
// dwarf every real month on any chart that measures money over time.
//
// Two signals, and BOTH are required:
//
//  1. The HubSpot record id the migration wrote into a custom field. Matched by
//     FIELD NAME, loosely: this account calls it "ID Oportunidad HS", but the
//     same migration elsewhere writes "ID Hubspot" / "HubSpot ID", and a renamed
//     field must not silently turn every imported deal back into an organic one.
//
//  2. A close date inside the calendar month the record was created in the CRM.
//     This is what separates "HubSpot closed it" from "we closed it": 10 deals
//     came over still open and were then worked and won in GHL months later
//     (abr–ago 2026, $267,163). Those are real sales and must keep counting.
//
// Rule (2) is calibrated against the client's own Looker Studio report, whose
// "No es de Importación" filter makes the identical split. With both rules the
// panel matches that report **to the cent** in every settled month — verified
// 2026-08-04 across null / abr 2025 / mar–jul 2026. The known cost: 7 deals
// closed 21–31 mar 2026 ($327,638) may genuinely have been worked in the CRM
// during that month, and are counted as imports anyway. Looker makes that same
// call, and matching the report the client already trusts is the point.
import type { Opportunity } from "./types"
import { CLOSE_DATE_FIELD } from "./sales-pivot"

/** The field name in this sub-account. Others are matched by the pattern below. */
export const KNOWN_HS_ID_FIELD = "ID Oportunidad HS"

// Requires BOTH an id-ish word and a HubSpot-ish word, so "Fecha de Creación
// import" (a different migration leftover) does not qualify. \bhs\b keeps it
// from matching unrelated words that merely contain "hs".
const HS_MENTION = /hubspot|\bhs\b/i
const ID_MENTION = /\bid\b/i

function hasValue(v: string | string[] | undefined): boolean {
  if (Array.isArray(v)) return v.some((s) => s.trim() !== "")
  return (v ?? "").trim() !== ""
}

/** True when the opportunity carries a non-empty HubSpot record id. */
export function hasHubspotId(opp: Opportunity): boolean {
  const resolved = opp.customFieldsResolved
  if (!resolved) return false
  for (const [name, value] of Object.entries(resolved)) {
    if (!HS_MENTION.test(name) || !ID_MENTION.test(name)) continue
    if (hasValue(value)) return true
  }
  return false
}

/** Last millisecond of the UTC calendar month `iso` falls in. */
function endOfUtcMonth(iso: string): number {
  const d = new Date(iso)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - 1
}

/**
 * True when the opportunity came over from HubSpot **already closed** — the
 * migration's own bookkeeping rather than a sale anyone worked in the CRM.
 *
 * A migrated deal with no close date at all counts as an import: there is no
 * evidence it was ever worked here, and the migration is the only reason the
 * record exists.
 */
export function isHubspotImport(opp: Opportunity): boolean {
  if (!hasHubspotId(opp)) return false

  const closeRaw = opp.customFieldsResolved?.[CLOSE_DATE_FIELD]
  const close = Array.isArray(closeRaw) ? closeRaw[0] : closeRaw
  if (!close?.trim()) return true

  const closedAt = new Date(close).getTime()
  if (Number.isNaN(closedAt)) return true

  const createdAt = opp.createdAt
  if (!createdAt) return true
  const migratedMonthEnd = endOfUtcMonth(createdAt)
  if (Number.isNaN(migratedMonthEnd)) return true

  // Closed after the migration month ⇒ worked and won in the CRM.
  return closedAt <= migratedMonthEnd
}

/**
 * Apply the panel-wide "Importación HubSpot" toggle.
 *
 * `include === true` is the identity function on purpose: the caller keeps one
 * code path, and the returned array is the SAME reference when nothing is
 * dropped, so downstream useMemo dependencies don't churn.
 */
export function applyHubspotFilter(
  opps: Opportunity[],
  include: boolean
): Opportunity[] {
  if (include) return opps
  return opps.filter((o) => !isHubspotImport(o))
}
