// Canonical "Origen de lead" platform normalization, shared by the
// Marketing and Ventas dashboards so both tabs bucket sources identically.
import type { Opportunity } from "./types"

export const PLATFORM_COLORS: Record<string, string> = {
  "Instagram":  "#E1306C",
  "Facebook":   "#1877F2",
  "TikTok":     "#010101",
  "Google":     "#EA4335",
  "Otro":       "#6b7280",
}

export const PLATFORM_ORDER = ["Instagram", "Facebook", "TikTok", "Google", "Otro"]

// Classify a single free-text origin hint into a platform bucket, or null if it
// carries no platform signal. WhatsApp is deliberately absent: it is a contact
// channel, not a lead origin, so a bare "whatsapp" never promotes out of "Otro".
function classifyHint(h: string): string | null {
  if (h.includes("instagram") || /\big\b/.test(h)) return "Instagram"
  if (
    h.includes("facebook") || h.includes("messenger") || h.includes("meta") ||
    /\bfb\b/.test(h)
  ) return "Facebook"
  if (h.includes("tiktok") || h.includes("tik tok")) return "TikTok"
  if (
    h.includes("google") || h.includes("bing") || h.includes("yahoo") ||
    h.includes("adwords") || h.includes("gclid")
  ) return "Google"
  return null
}

// Opportunity custom fields that can carry an explicit origin / ad-type signal.
// Field NAMES vary across GHL sub-accounts ("Origen de Lead" vs "Origen del
// Lead", "Tipo de pauta" vs "Tipo de anuncio"…), so match loosely by substring.
const ORIGIN_FIELD_HINTS = [
  "origen",          // Origen de Lead / Origen del Lead / Origen
  "tipo de pauta",   // Tipo de pauta (Google Ads / Formulario / …)
  "tipo de anuncio",
  "nombre pauta",    // Nombre pauta (sometimes literally "Google Ads")
  "nombre de pauta",
]

// Concatenated, lowercased text of every origin/ad-type custom field on an
// opportunity. Website leads pushed in via Zapier lose their UTM platform, but
// the CRM still records e.g. Origen de Lead = "Sitio Web Inicio" and Tipo de
// pauta = "Google Ads" — so this is often the only surviving platform signal.
export function originSignalText(opp: Opportunity): string {
  const resolved = opp.customFieldsResolved
  if (!resolved) return ""
  const parts: string[] = []
  for (const [name, val] of Object.entries(resolved)) {
    const n = name.toLowerCase()
    if (!ORIGIN_FIELD_HINTS.some((h) => n.includes(h))) continue
    const s = Array.isArray(val) ? val.join(" ") : String(val ?? "")
    if (s.trim()) parts.push(s)
  }
  return parts.join(" ").toLowerCase()
}

// Tolerant Google-Ads / paid-search detector for the origin-signal text above.
// Clients label the pauta differently ("Google Ads", "Google", "Adwords",
// "Google Ads Search"…), so accept any of these forms.
export function hasGoogleAdsSignal(text: string): boolean {
  return (
    text.includes("google ad") ||  // "google ads", "google adwords"
    text.includes("adwords") ||
    text.includes("gclid") ||
    /\bgoogle\b/.test(text)
  )
}

// Website / landing-page origin signal. The picklist value varies by client
// ("Sitio Web Inicio", "Sitio Web", "Página Web", "Web", "Landing", "Website"…).
export function hasWebsiteSignal(text: string): boolean {
  return (
    text.includes("sitio web") || text.includes("pagina web") ||
    text.includes("página web") || text.includes("website") ||
    text.includes("landing") || /\bweb\b/.test(text)
  )
}

export function platformLabel(opp: Opportunity): string {
  const url  = (opp.attributionUrl ?? "").toLowerCase()
  const src  = (opp.source ?? "").toLowerCase()
  if (url.includes("instagram.com") || src.includes("instagram")) return "Instagram"
  if (
    url.includes("fb.me") || url.includes("facebook.com") || url.includes("fb.com") ||
    src.includes("facebook") || src.includes("meta") || src === "fb" ||
    /^\d{10,}$/.test(opp.source ?? "")
  ) return "Facebook"
  if (src.includes("tiktok")) return "TikTok"
  if (src.includes("google") || src.includes("bing") || src.includes("yahoo")) return "Google"

  // Fallback cascade — the primary signals above (attribution URL / source) are
  // frequently empty for ad/organic-social leads even though GHL knows the
  // origin. Probe every remaining hint, strongest → weakest, before giving up:
  //   1. originPlatform     — contact's explicit "Origen de Lead" custom field
  //   2. originSignalText   — opportunity custom fields (Origen de Lead / Tipo
  //                           de pauta / Nombre pauta) — e.g. a website lead
  //                           pushed via Zapier whose Tipo de pauta = "Google Ads"
  //                           folds into Google here.
  //   3. attributionMedium  — GHL-internal medium (facebook, instagram, tiktok…)
  //   4. adType             — utmMedium / utmSessionSource
  //   5. campaign           — built from utmContent / utmCampaign
  //   6. attributionUrl/src — re-scan the full strings for non-".com" forms
  for (const raw of [
    opp.originPlatform,
    originSignalText(opp),
    opp.attributionMedium,
    opp.adType,
    opp.campaign,
    opp.attributionUrl,
    opp.source,
  ]) {
    if (!raw) continue
    const hit = classifyHint(String(raw).toLowerCase())
    if (hit) return hit
  }

  // Note: a website-origin lead WITH a Google Ads pauta already resolved to
  // "Google" above (the cascade sees "google ads" in originSignalText). A purely
  // organic website lead carries no platform signal, so it stays "Otro" on the
  // platform axis — the Marketing dashboard distinguishes it as "Orgánico Web" in
  // the fuente segment via hasWebsiteSignal().
  return "Otro"
}
