// lib/meta-normalize.ts
// Lo puro de la integración con Meta Ads: de la respuesta cruda de Graph a las
// tablas de MetaAdsData, la ventana de historia y su partición por mes. Sin
// fetch, sin Next: lo prueba pnpm verify:meta y lo importa lib/meta-client.ts.
import type {
  MetaAccount,
  MetaAd,
  MetaAdset,
  MetaAdsData,
  MetaCampaign,
  MetaDailyRow,
} from "./types";

/** action_type de un lead por formulario ("Pauta Formulario"). */
export const LEAD_FORM_ACTION = "lead";
/** action_type de una conversación iniciada desde un anuncio de WhatsApp ("Pauta WhatsApp"). */
export const LEAD_MSG_ACTION = "onsite_conversion.messaging_conversation_started_7d";
/** Hasta dónde atrás se pide gasto, aunque haya oportunidades más viejas. */
export const MAX_HISTORY_MONTHS = 24;

export interface RawInsightRow {
  ad_id: string;
  date_start: string;
  spend?: string;
  impressions?: string;
  clicks?: string;
  inline_link_clicks?: string;
  actions?: { action_type: string; value: string }[];
}

export interface RawAd {
  id: string;
  name: string;
  effective_status?: string;
  created_time?: string;
  adset?: { id: string; name: string };
  campaign?: { id: string; name: string; objective?: string };
}

function num(v: string | number | undefined): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function action(r: RawInsightRow, type: string): number {
  return num(r.actions?.find((a) => a.action_type === type)?.value);
}

export function normalizeInsightRow(r: RawInsightRow, accountId: string): MetaDailyRow {
  return {
    adId: String(r.ad_id),
    accountId,
    date: r.date_start,
    spend: num(r.spend),
    impressions: num(r.impressions),
    clicks: num(r.clicks),
    linkClicks: num(r.inline_link_clicks),
    leadsForm: action(r, LEAD_FORM_ACTION),
    leadsMsg: action(r, LEAD_MSG_ACTION),
  };
}

// Tablas planas con ids de padre. Un ad cuyo adset o campaña ya no existe (Meta
// los devuelve sin esos objetos) se conserva con padre vacío: su gasto histórico
// sigue siendo real.
export function normalizeAds(
  accountId: string,
  raw: RawAd[]
): { campaigns: MetaCampaign[]; adsets: MetaAdset[]; ads: MetaAd[] } {
  const campaigns = new Map<string, MetaCampaign>();
  const adsets = new Map<string, MetaAdset>();
  const ads: MetaAd[] = [];
  for (const a of raw) {
    if (a.campaign && !campaigns.has(a.campaign.id)) {
      campaigns.set(a.campaign.id, {
        id: a.campaign.id,
        name: a.campaign.name,
        objective: a.campaign.objective,
        accountId,
      });
    }
    if (a.adset && !adsets.has(a.adset.id)) {
      adsets.set(a.adset.id, { id: a.adset.id, name: a.adset.name, campaignId: a.campaign?.id ?? "" });
    }
    ads.push({
      id: String(a.id),
      name: a.name,
      adsetId: a.adset?.id ?? "",
      status: a.effective_status,
      ...(a.created_time ? { createdTime: a.created_time } : {}),
    });
  }
  return { campaigns: [...campaigns.values()], adsets: [...adsets.values()], ads };
}

/**
 * Solo anuncios creados desde la subcuenta (`since` = YYYY-MM-DD del
 * `dateAdded` de GHL). Pedido del cliente, 2026-09-28: Zanda arrastra campañas
 * de 2020-2021 sin nada que cruzar. Se compara el día calendario de
 * `created_time` tal como Graph lo escribe (con su offset); un anuncio del
 * mismo día se conserva. Sin `created_time` no hay con qué juzgar: se conserva.
 * `droppedIds` sirve para tirar también sus filas de insights.
 */
export function filterAdsCreatedSince(
  raw: RawAd[],
  since: string | null
): { kept: RawAd[]; droppedIds: Set<string> } {
  const droppedIds = new Set<string>();
  if (!since) return { kept: raw, droppedIds };
  const kept: RawAd[] = [];
  for (const a of raw) {
    const day = (a.created_time ?? "").slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(day) && day < since) {
      droppedIds.add(String(a.id));
      continue;
    }
    kept.push(a);
  }
  return { kept, droppedIds };
}

/**
 * De un `paging.next` de Graph a la ruta y parámetros con que pedir la página
 * siguiente por el camino normal (que vuelve a poner el token).
 *
 * Graph NO respeta la versión de la petición en `next`: se pidió con v23.0 y
 * el enlace vuelve bajo `/v26.0/`. Quitar solo `/${GRAPH_VERSION}/` dejaba el
 * prefijo ajeno y la segunda página iba a `v23.0//v26.0/act_…/insights` →
 * 400 "Unknown path components". Solo pagina quien tiene más de 500 filas de
 * insights en un mes, así que fallaban exactamente las cuatro cuentas grandes
 * de DRT y las dos chicas pasaban (medido 2026-09-28: `code_2500` en La
 * Sierra, Cañadas, Saggita y Átria). Se quita CUALQUIER `/vNN.N/`.
 */
export function nextPageRequest(nextUrl: string): { path: string; params: Record<string, string> } {
  const next = new URL(nextUrl);
  const params: Record<string, string> = {};
  next.searchParams.forEach((v, k) => {
    if (k !== "access_token") params[k] = v;
  });
  const path = next.pathname.replace(/^\/v\d+\.\d+\//, "").replace(/^\//, "");
  return { path, params };
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function ymd(y: number, m: number, d: number): string {
  return `${y}-${pad(m)}-${pad(d)}`;
}

function lastDayOfMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function addDays(ymdStr: string, n: number): string {
  const [y, m, d] = ymdStr.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/**
 * Días por petición de insights. Un mes entero a nivel anuncio × día rebasa
 * los ~30 s que Meta se da a sí misma en cuentas de más de 500 anuncios (Átria
 * y Saggita: code 2 / subcode 1504044 y code 1 / subcode 99, medido
 * 2026-09-29), y eso no es transitorio: reintentar igual solo quema 90 s. Una
 * semana cabe de sobra; el tramo que aun así truene se parte (splitRange).
 */
export const INSIGHTS_CHUNK_DAYS = 7;

/** Tramos contiguos de `days` días, el último recortado a `until`. */
export function dateChunks(since: string, until: string, days: number): { since: string; until: string }[] {
  if (since > until || days < 1) return [];
  const out: { since: string; until: string }[] = [];
  let cursor = since;
  while (cursor <= until) {
    const end = addDays(cursor, days - 1);
    out.push({ since: cursor, until: end < until ? end : until });
    cursor = addDays(end, 1);
  }
  return out;
}

/** Las dos mitades de un tramo, o null si ya es un solo día. */
export function splitRange(since: string, until: string): [{ since: string; until: string }, { since: string; until: string }] | null {
  if (since >= until) return null;
  const [y1, m1, d1] = since.split("-").map(Number);
  const [y2, m2, d2] = until.split("-").map(Number);
  const a = Date.UTC(y1, m1 - 1, d1);
  const b = Date.UTC(y2, m2 - 1, d2);
  const days = Math.round((b - a) / 86_400_000) + 1;
  const firstLen = Math.ceil(days / 2);
  const mid = addDays(since, firstLen - 1);
  return [
    { since, until: mid },
    { since: addDays(mid, 1), until },
  ];
}

// Tramos por mes calendario (la ventana de historia se razona en meses).
export function monthChunks(since: string, until: string): { since: string; until: string }[] {
  if (since > until) return [];
  const out: { since: string; until: string }[] = [];
  let [y, m] = since.split("-").map(Number);
  let cursor = since;
  while (cursor <= until) {
    const end = ymd(y, m, lastDayOfMonth(y, m));
    out.push({ since: cursor, until: end < until ? end : until });
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
    cursor = ymd(y, m, 1);
  }
  return out;
}

// Desde el primer día del mes en que se creó la subcuenta de GHL, con tope de
// MAX_HISTORY_MONTHS. Pedido del cliente (2026-09-28): lo que se pautó antes de
// que existiera el CRM no tiene con qué cruzarse. Sin fecha (GHL no la devolvió
// o no parsea): solo el mes en curso. `today` es YYYY-MM-DD ya en la zona
// horaria del panel; este módulo no sabe de zonas.
export function historyWindow(
  locationCreatedAt: string | null | undefined,
  today: string
): { since: string; until: string } {
  const [ty, tm] = today.split("-").map(Number);
  const thisMonth = ymd(ty, tm, 1);
  let since = thisMonth;
  const created = (locationCreatedAt ?? "").slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(created)) {
    const [cy, cm] = created.split("-").map(Number);
    since = ymd(cy, cm, 1);
  }
  // Tope: MAX_HISTORY_MONTHS meses atrás, primer día de ese mes.
  let fy = ty;
  let fm = tm - MAX_HISTORY_MONTHS;
  while (fm <= 0) {
    fm += 12;
    fy -= 1;
  }
  const floor = ymd(fy, fm, 1);
  if (since < floor) since = floor;
  if (since > today) since = thisMonth;
  return { since, until: today };
}

export function mergeMetaAds(
  parts: {
    account: MetaAccount;
    hierarchy: { campaigns: MetaCampaign[]; adsets: MetaAdset[]; ads: MetaAd[] };
    daily: MetaDailyRow[];
  }[],
  failed: { id: string; reason: string }[],
  window: { since: string; until: string }
): MetaAdsData {
  return {
    accounts: parts.map((p) => p.account),
    campaigns: parts.flatMap((p) => p.hierarchy.campaigns),
    adsets: parts.flatMap((p) => p.hierarchy.adsets),
    ads: parts.flatMap((p) => p.hierarchy.ads),
    daily: parts.flatMap((p) => p.daily),
    window,
    failedAccounts: failed,
  };
}
