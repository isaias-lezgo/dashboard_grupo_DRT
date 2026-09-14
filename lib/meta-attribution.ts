// lib/meta-attribution.ts
// El cruce entre el gasto de Meta y las oportunidades del CRM. Puro: sin React,
// sin fetch. Lo prueba pnpm verify:meta-attribution y lo montan las cards de
// costo (entrega ②) y la pestaña PAUTA (entrega ③).
//
// Tres niveles de atribución de un lead, en orden, y nunca mezclados:
//   exact   — el AD ID (attributions[].utmAdId, o el custom field "ID Pauta").
//   byName  — sin id, el NOMBRE del ad (custom field "Nombre Pauta" de la opp,
//             o el registro Pauta del contacto) cuando ese nombre vive en UNA
//             sola campaña de Meta. Se cuenta aparte: es inferencia, no dato.
//   noAdId  — de pauta (isDePauta) pero sin nada que lo ate a un anuncio.
// Lo que no es de pauta (orgánico, referido, importado por CSV) es notPauta y
// jamás entra al costo por lead. Medido 2026-09-13: Palmyra y Zanda recibieron
// ~3 000 oportunidades por CSV el 28-31 de agosto; sin esta cubeta el costo por
// lead de agosto habría sido una mentira.
//
// El costo por etapa es por COHORTE DE CREACIÓN: gasto de la ventana ÷ leads
// creados en la ventana que alcanzaron la etapa. Con un ciclo de meses, el costo
// por venta de un periodo reciente siempre es alto; la UI lo dice en vez de fingir.
//
// No reparte gasto entre desarrollos, no convierte moneda y no toca lib/pauta.ts:
// isDePauta sigue siendo "es de pauta"; esto es "cuánto costó".
import type {
  MetaAccount,
  MetaAd,
  MetaAdset,
  MetaAdsData,
  MetaCampaign,
  MetaDailyRow,
  Opportunity,
  Pauta,
  Pipeline,
} from "./types";
import { desarrolloOf, NO_DESARROLLO, PANEL_SCOPES, resolvePipelineId, type PanelId } from "./panel-scope";
import { isWonOpp } from "./opportunity-status";
import { isDePauta, resolveCampaignName, SIN_NOMBRE_CAMPAIGN, type HasKey } from "./pauta";
import { PANEL_TIME_ZONE } from "./task-backlog";

/** Oportunidad de pauta sin ad id capturado: hueco de captura, en rojizo. */
export const NO_AD_ID = "Sin ad id";
/** Oportunidad con ad id que no está en ninguna cuenta conectada. */
export const UNKNOWN_AD = "Ad no conectado";

export type StageKey = "contactado" | "cita" | "visita" | "apartado" | "venta";

/** Las cinco etapas del embudo que se cobran, por su prefijo numérico en DRT. */
export const STAGE_TARGETS: { key: StageKey; label: string; minIndex: number }[] = [
  { key: "contactado", label: "Contactado", minIndex: 1 },
  { key: "cita", label: "Cita", minIndex: 4 },
  { key: "visita", label: "Visita", minIndex: 5 },
  { key: "apartado", label: "Apartado", minIndex: 7 },
  { key: "venta", label: "Venta", minIndex: 8 },
];

// ── Llave ───────────────────────────────────────────────────────────────────

function normalizeAdId(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return /^\d+$/.test(s) ? s : null;
}

// "ID Pauta" (el poblado en DRT) e "ID de Pauta" (existe, casi vacío). Nunca
// "URL Pauta" ni "Nombre Pauta".
const AD_ID_FIELD = /^id\s*(de\s*)?pauta$/i;

// La attribution nativa manda: es lo que GHL recibió del click-to-WhatsApp; el
// custom field es una copia que escribe Make. Difieren en ~0.3 % de los casos.
export function oppAdId(opp: Opportunity): string | null {
  const own = normalizeAdId(opp.adId);
  if (own) return own;
  const cf = opp.customFieldsResolved;
  if (!cf) return null;
  for (const [name, val] of Object.entries(cf)) {
    if (!AD_ID_FIELD.test(name.trim())) continue;
    const id = normalizeAdId(Array.isArray(val) ? val[0] : val);
    if (id) return id;
  }
  return null;
}

// ── Índice ──────────────────────────────────────────────────────────────────

function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

export interface MetaIndex {
  byAd: Map<string, { ad: MetaAd; adset?: MetaAdset; campaign?: MetaCampaign; account?: MetaAccount }>;
  dailyByAd: Map<string, MetaDailyRow[]>;
  /** Nombre plegado (de ad o de campaña) → campañas donde aparece. Base del nivel byName. */
  byName: Map<string, Set<string>>;
}

export function buildMetaIndex(meta: MetaAdsData): MetaIndex {
  const accounts = new Map(meta.accounts.map((a) => [a.id, a]));
  const campaigns = new Map(meta.campaigns.map((c) => [c.id, c]));
  const adsets = new Map(meta.adsets.map((s) => [s.id, s]));
  const byAd: MetaIndex["byAd"] = new Map();
  const byName: MetaIndex["byName"] = new Map();
  const addName = (name: string, campaignId: string | undefined) => {
    if (!campaignId) return;
    const k = fold(name);
    if (!k) return;
    const set = byName.get(k) ?? new Set<string>();
    set.add(campaignId);
    byName.set(k, set);
  };
  for (const ad of meta.ads) {
    const adset = adsets.get(ad.adsetId);
    const campaign = adset ? campaigns.get(adset.campaignId) : undefined;
    const account = campaign ? accounts.get(campaign.accountId) : undefined;
    byAd.set(ad.id, { ad, adset, campaign, account });
    addName(ad.name, campaign?.id);
  }
  for (const c of meta.campaigns) addName(c.name, c.id);
  const dailyByAd = new Map<string, MetaDailyRow[]>();
  for (const d of meta.daily) {
    const arr = dailyByAd.get(d.adId) ?? [];
    arr.push(d);
    dailyByAd.set(d.adId, arr);
  }
  return { byAd, dailyByAd, byName };
}

/** contactIds con al menos un registro Pauta — la mitad "objeto" de isDePauta. */
export function buildPautaContacts(pautas: Pauta[]): Set<string> {
  const s = new Set<string>();
  for (const p of pautas) if (p.contactId) s.add(p.contactId);
  return s;
}

// ── Clasificación de un lead ────────────────────────────────────────────────

export type LeadAttribution =
  | { kind: "exact"; adId: string; campaignId: string | null }
  | { kind: "byName"; name: string; campaignId: string }
  | { kind: "unknownAd"; adId: string }
  | { kind: "noAdId" }
  | { kind: "notPauta" };

export interface AttributionContext {
  index: MetaIndex;
  pautaContacts: HasKey;
  /** buildPautaNameByContact(allPautas), de lib/pauta.ts. */
  pautaNameByContact: Map<string, string>;
}

// Una importación masiva no es un lead de pauta aunque traiga ad id copiado.
function isImported(opp: Opportunity): boolean {
  return (opp.attributionMedium ?? "").toLowerCase() === "csv_import";
}

export function classifyLead(opp: Opportunity, ctx: AttributionContext): LeadAttribution {
  if (isImported(opp)) return { kind: "notPauta" };
  const adId = oppAdId(opp);
  if (adId) {
    const hit = ctx.index.byAd.get(adId);
    return hit ? { kind: "exact", adId, campaignId: hit.campaign?.id ?? null } : { kind: "unknownAd", adId };
  }
  // Sin id: el nombre del ad, si es inequívoco. resolveCampaignName ya recorre
  // utmCampaign → "Nombre Pauta" → utmContent → registro Pauta del contacto.
  const name = resolveCampaignName(opp, ctx.pautaNameByContact);
  if (name && name !== SIN_NOMBRE_CAMPAIGN) {
    const campaigns = ctx.index.byName.get(fold(name));
    if (campaigns && campaigns.size === 1) {
      return { kind: "byName", name, campaignId: [...campaigns][0] };
    }
  }
  return isDePauta(opp, ctx.pautaContacts) || !!name ? { kind: "noAdId" } : { kind: "notPauta" };
}

// ── Desarrollo de cada ad ───────────────────────────────────────────────────

// 1) la moda de los pipelines de sus leads (sobre el set SIN filtrar); 2) el
// nombre de un desarrollo en campaña → adset → ad; 3) Sin desarrollo. El gasto
// no se reparte: un ad es de UN desarrollo. `mixed` lista los ads con leads en
// más de un desarrollo, para que la UI lo diga en vez de callarlo.
//
// El fallback por nombre devuelve el nombre REAL del pipeline (el mismo string
// que desarrolloOf), no la etiqueta de PANEL_SCOPES: scopeMetaDaily compara
// contra el pipeline, y una etiqueta distinta haría desaparecer esos ads del tab.
export function assignAdDesarrollos(
  meta: MetaAdsData,
  index: MetaIndex,
  allOpportunities: Opportunity[],
  pipelines: Pipeline[] | undefined
): { byAd: Map<string, string>; mixed: string[] } {
  const votes = new Map<string, Map<string, number>>();
  for (const o of allOpportunities) {
    if (isImported(o)) continue;
    const adId = oppAdId(o);
    if (!adId || !index.byAd.has(adId)) continue;
    const d = desarrolloOf(o, pipelines);
    if (d === NO_DESARROLLO) continue;
    const m = votes.get(adId) ?? new Map<string, number>();
    m.set(d, (m.get(d) ?? 0) + 1);
    votes.set(adId, m);
  }

  // Agujas para el fallback por nombre: el nombre de cada pipeline (así un
  // séptimo desarrollo aparece sin tocar PANEL_SCOPES) más las etiquetas de
  // PANEL_SCOPES resueltas a su pipeline real. El valor siempre es el string que
  // devolvería desarrolloOf, para que scopeMetaDaily lo encuentre.
  const needles = new Map<string, string>();
  for (const p of pipelines ?? []) {
    const name = p.name?.trim();
    if (name) needles.set(fold(name), name);
  }
  for (const panel of Object.keys(PANEL_SCOPES) as PanelId[]) {
    const scope = PANEL_SCOPES[panel];
    if (scope.pipelineId === null) continue;
    const pipelineId = resolvePipelineId(pipelines, panel);
    const real = pipelines?.find((x) => x.id === pipelineId)?.name?.trim();
    const k = fold(scope.label);
    if (!needles.has(k)) needles.set(k, real || scope.label);
  }
  // Las agujas más largas primero: "cañadas by el mirador" antes que "cañadas".
  const labels = [...needles.entries()]
    .map(([folded, name]) => ({ folded, name }))
    .sort((a, b) => b.folded.length - a.folded.length);

  const byAd = new Map<string, string>();
  const mixed: string[] = [];
  for (const ad of meta.ads) {
    const v = votes.get(ad.id);
    if (v && v.size > 0) {
      if (v.size > 1) mixed.push(ad.id);
      let best = "";
      let bestN = -1;
      for (const [d, n] of v) {
        if (n > bestN || (n === bestN && d.localeCompare(best, "es") < 0)) {
          best = d;
          bestN = n;
        }
      }
      byAd.set(ad.id, best);
      continue;
    }
    const entry = index.byAd.get(ad.id);
    const haystack = fold([entry?.campaign?.name, entry?.adset?.name, ad.name].filter(Boolean).join(" | "));
    const hit = labels.find((l) => haystack.includes(l.folded));
    byAd.set(ad.id, hit ? hit.name : NO_DESARROLLO);
  }
  return { byAd, mixed };
}

// Misma convención que scopeOpportunities: GENERAL devuelve el array original.
export function scopeMetaDaily(
  meta: MetaAdsData,
  desarrolloByAd: Map<string, string>,
  panel: PanelId,
  pipelines: Pipeline[] | undefined
): MetaDailyRow[] {
  if (panel === "general") return meta.daily;
  const pipelineId = resolvePipelineId(pipelines, panel);
  const name = pipelines?.find((p) => p.id === pipelineId)?.name?.trim() || PANEL_SCOPES[panel].label;
  return meta.daily.filter((d) => desarrolloByAd.get(d.adId) === name);
}

// ── Cohorte y etapas ────────────────────────────────────────────────────────

export function localDay(iso: string, timeZone: string = PANEL_TIME_ZONE): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

// "05. Visita al Desarrollo" → 5. Los side buckets no tienen prefijo → null.
export function stageIndexOf(stage: string | undefined): number | null {
  const m = /^\s*(\d{1,2})\s*\./.exec(stage ?? "");
  return m ? Number(m[1]) : null;
}

export function reachedStage(opp: Opportunity, target: { key: StageKey; minIndex: number }): boolean {
  if (target.key === "venta" && isWonOpp(opp)) return true;
  const idx = stageIndexOf(opp.stage);
  return idx !== null && idx >= target.minIndex;
}

function inRange(day: string, range: { start: string; end: string } | null): boolean {
  if (!range) return true;
  return day >= range.start && day <= range.end;
}

function ratio(num: number, den: number): number | null {
  return den > 0 ? num / den : null;
}

interface CostInput {
  opportunities: Opportunity[];
  daily: MetaDailyRow[];
  ctx: AttributionContext;
  accounts: MetaAccount[];
  /** YYYY-MM-DD inclusivo, en la zona horaria del panel; null = toda la ventana. */
  range: { start: string; end: string } | null;
}

export interface CostPerStage {
  spendByCurrency: Record<string, number>;
  mixedCurrency: boolean;
  /** exact + byName: los que entran a la cohorte. */
  leadsCrm: number;
  leadsExact: number;
  leadsByName: number;
  leadsMeta: number;
  /** De pauta, sin ad id ni nombre resoluble. */
  noAdId: number;
  /** Con ad id que no está en ninguna cuenta conectada. */
  unknownAdLeads: number;
  /** Orgánicos, referidos, importados: fuera del costo por definición. */
  notPauta: number;
  stages: { key: StageKey; label: string; reached: number; costPerResult: number | null; oppIds: string[] }[];
}

function currencyOfAd(index: MetaIndex, adId: string): string {
  return index.byAd.get(adId)?.account?.currency || "";
}

export function buildCostPerStage(p: CostInput): CostPerStage {
  const spendByCurrency: Record<string, number> = {};
  let leadsMeta = 0;
  for (const d of p.daily) {
    if (!inRange(d.date, p.range)) continue;
    const cur = currencyOfAd(p.ctx.index, d.adId);
    spendByCurrency[cur] = (spendByCurrency[cur] ?? 0) + d.spend;
    leadsMeta += d.leadsForm + d.leadsMsg;
  }
  const currencies = Object.keys(spendByCurrency);
  const mixedCurrency = currencies.length > 1;
  const totalSpend = mixedCurrency ? null : (spendByCurrency[currencies[0] ?? ""] ?? 0);

  let leadsExact = 0;
  let leadsByName = 0;
  let noAdId = 0;
  let unknownAdLeads = 0;
  let notPauta = 0;
  const cohort: Opportunity[] = [];
  for (const o of p.opportunities) {
    if (!inRange(localDay(o.createdAt), p.range)) continue;
    const a = classifyLead(o, p.ctx);
    switch (a.kind) {
      case "exact":
        leadsExact++;
        cohort.push(o);
        break;
      case "byName":
        leadsByName++;
        cohort.push(o);
        break;
      case "unknownAd":
        unknownAdLeads++;
        break;
      case "noAdId":
        noAdId++;
        break;
      case "notPauta":
        notPauta++;
        break;
    }
  }

  const stages = STAGE_TARGETS.map((t) => {
    const hit = cohort.filter((o) => reachedStage(o, t));
    return {
      key: t.key,
      label: t.label,
      reached: hit.length,
      costPerResult: totalSpend === null ? null : ratio(totalSpend, hit.length),
      oppIds: hit.map((o) => o.id),
    };
  });

  return {
    spendByCurrency,
    mixedCurrency,
    leadsCrm: leadsExact + leadsByName,
    leadsExact,
    leadsByName,
    leadsMeta,
    noAdId,
    unknownAdLeads,
    notPauta,
    stages,
  };
}

// ── Por campaña ─────────────────────────────────────────────────────────────

export interface CampaignPerformanceRow {
  campaignId: string;
  name: string;
  accountId: string;
  currency: string;
  spend: number;
  impressions: number;
  clicks: number;
  cpm: number | null;
  ctr: number | null;
  leadsMeta: number;
  /** exact + byName. */
  leadsCrm: number;
  leadsByName: number;
  reached: Record<StageKey, number>;
  cpl: number | null;
  costPerApartado: number | null;
  costPerVenta: number | null;
  adIds: string[];
}

export function buildCampaignPerformance(p: CostInput): CampaignPerformanceRow[] {
  const rows = new Map<string, CampaignPerformanceRow>();
  const rowFor = (campaignId: string): CampaignPerformanceRow => {
    let r = rows.get(campaignId);
    if (!r) {
      const c = [...p.ctx.index.byAd.values()].find((e) => e.campaign?.id === campaignId);
      r = {
        campaignId,
        name: c?.campaign?.name ?? campaignId,
        accountId: c?.campaign?.accountId ?? "",
        currency: c?.account?.currency ?? "",
        spend: 0,
        impressions: 0,
        clicks: 0,
        cpm: null,
        ctr: null,
        leadsMeta: 0,
        leadsCrm: 0,
        leadsByName: 0,
        reached: { contactado: 0, cita: 0, visita: 0, apartado: 0, venta: 0 },
        cpl: null,
        costPerApartado: null,
        costPerVenta: null,
        adIds: [],
      };
      rows.set(campaignId, r);
    }
    return r;
  };

  for (const d of p.daily) {
    if (!inRange(d.date, p.range)) continue;
    const cid = p.ctx.index.byAd.get(d.adId)?.campaign?.id;
    if (!cid) continue;
    const r = rowFor(cid);
    r.spend += d.spend;
    r.impressions += d.impressions;
    r.clicks += d.clicks;
    r.leadsMeta += d.leadsForm + d.leadsMsg;
    if (!r.adIds.includes(d.adId)) r.adIds.push(d.adId);
  }

  for (const o of p.opportunities) {
    if (!inRange(localDay(o.createdAt), p.range)) continue;
    const a = classifyLead(o, p.ctx);
    if (a.kind !== "exact" && a.kind !== "byName") continue;
    if (!a.campaignId || !rows.has(a.campaignId)) continue;
    const r = rows.get(a.campaignId)!;
    r.leadsCrm++;
    if (a.kind === "byName") r.leadsByName++;
    for (const t of STAGE_TARGETS) if (reachedStage(o, t)) r.reached[t.key]++;
  }

  for (const r of rows.values()) {
    r.cpm = r.impressions > 0 ? (r.spend / r.impressions) * 1000 : null;
    r.ctr = ratio(r.clicks, r.impressions);
    r.cpl = ratio(r.spend, r.leadsCrm);
    r.costPerApartado = ratio(r.spend, r.reached.apartado);
    r.costPerVenta = ratio(r.spend, r.reached.venta);
  }

  return [...rows.values()].sort((a, b) => b.spend - a.spend || a.name.localeCompare(b.name, "es"));
}
