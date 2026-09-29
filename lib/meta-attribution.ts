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
  Contact,
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
import { reachedStage, stageIndexOf } from "./desarrollo-funnel";
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

// Una importación masiva no es un lead de pauta aunque traiga ad id copiado.
function isImported(opp: Opportunity): boolean {
  return (opp.attributionMedium ?? "").toLowerCase() === "csv_import";
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
  campaignsById: Map<string, MetaCampaign>;
  accountsById: Map<string, MetaAccount>;
  /** Nombre plegado de ANUNCIO → ids de anuncio. Genéricos en DRT ("a1", "anuncio 2"). */
  adsByName: Map<string, Set<string>>;
  /** Nombre plegado de CAMPAÑA → ids de campaña. El nombre que el cliente reconoce. */
  campaignsByName: Map<string, Set<string>>;
  /** Nombre plegado (de ad o de campaña) → campañas donde aparece. Lo conserva el filtro Campaña. */
  byName: Map<string, Set<string>>;
}

function addTo(m: Map<string, Set<string>>, key: string, value: string) {
  const k = fold(key);
  if (!k) return;
  const set = m.get(k) ?? new Set<string>();
  set.add(value);
  m.set(k, set);
}

export function buildMetaIndex(meta: MetaAdsData): MetaIndex {
  const accountsById = new Map(meta.accounts.map((a) => [a.id, a]));
  const campaignsById = new Map(meta.campaigns.map((c) => [c.id, c]));
  const adsets = new Map(meta.adsets.map((s) => [s.id, s]));
  const byAd: MetaIndex["byAd"] = new Map();
  const adsByName = new Map<string, Set<string>>();
  const campaignsByName = new Map<string, Set<string>>();
  const byName = new Map<string, Set<string>>();
  for (const ad of meta.ads) {
    const adset = adsets.get(ad.adsetId);
    const campaign = adset ? campaignsById.get(adset.campaignId) : undefined;
    const account = campaign ? accountsById.get(campaign.accountId) : undefined;
    byAd.set(ad.id, { ad, adset, campaign, account });
    addTo(adsByName, ad.name, ad.id);
    if (campaign) addTo(byName, ad.name, campaign.id);
  }
  for (const c of meta.campaigns) {
    addTo(campaignsByName, c.name, c.id);
    addTo(byName, c.name, c.id);
  }
  const dailyByAd = new Map<string, MetaDailyRow[]>();
  for (const d of meta.daily) {
    const arr = dailyByAd.get(d.adId) ?? [];
    arr.push(d);
    dailyByAd.set(d.adId, arr);
  }
  return { byAd, dailyByAd, campaignsById, accountsById, adsByName, campaignsByName, byName };
}

/**
 * ad id → nombre de la campaña de Meta a la que pertenece. Base del primer
 * nivel del filtro global de campaña (lib/panel-filters.ts). Sin conexión con
 * Meta (`meta` null) el mapa sale vacío y el filtro cae al objeto Pauta.
 */
export function buildMetaCampaignByAd(meta: MetaAdsData | null | undefined): Map<string, string> {
  const m = new Map<string, string>();
  if (!meta) return m;
  const campaigns = new Map(meta.campaigns.map((c) => [c.id, c.name?.trim()]));
  const adsets = new Map(meta.adsets.map((s) => [s.id, s.campaignId]));
  for (const ad of meta.ads) {
    const campaignId = adsets.get(ad.adsetId);
    const name = campaignId ? campaigns.get(campaignId) : undefined;
    if (name) m.set(ad.id, name);
  }
  return m;
}

/** contactIds con al menos un registro Pauta — la mitad "objeto" de isDePauta. */
export function buildPautaContacts(pautas: Pauta[]): Set<string> {
  const s = new Set<string>();
  for (const p of pautas) if (p.contactId) s.add(p.contactId);
  return s;
}

// ── Llaves de una oportunidad ───────────────────────────────────────────────
// Cada nivel de classifyLead lee UNA clase de llave, de todas las fuentes en
// las que el CRM la guarda: la oportunidad primero, el contacto después;
// custom fields antes que attributions; isFirst antes que isLast. Sin repetir.

type Attr = Record<string, unknown>;

const URL_FIELD = /^url\s*(de\s*)?pauta$/i;
// "Nombre Pauta" y el campo "Pauta" a secas (6 320 oportunidades en DRT).
const NAME_FIELD = /^(nombre\s*(de\s*(la\s*)?)?pauta|pauta)$/i;

function cfValues(cf: Record<string, string | string[]> | undefined, re: RegExp): string[] {
  const out: string[] = [];
  if (!cf) return out;
  for (const [name, val] of Object.entries(cf)) {
    if (!re.test(name.trim())) continue;
    for (const v of Array.isArray(val) ? val : [val]) {
      const s = String(v ?? "").trim();
      if (s) out.push(s);
    }
  }
  return out;
}

function orderedAttrs(attrs: unknown): Attr[] {
  if (!Array.isArray(attrs)) return [];
  const list = attrs as Attr[];
  return [...list.filter((a) => a.isFirst === true), ...list.filter((a) => a.isFirst !== true)];
}

/** attributions de la oportunidad y luego las de su contacto. */
function attrsOf(opp: Opportunity, contactById?: ReadonlyMap<string, Contact>): Attr[] {
  return [...orderedAttrs(opp.attributions), ...orderedAttrs(contactById?.get(opp.contactId)?.attributions)];
}

function dedupe(values: (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const s = String(v ?? "").trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

export function adIdCandidates(opp: Opportunity, contactById?: ReadonlyMap<string, Contact>): string[] {
  const contact = contactById?.get(opp.contactId);
  return dedupe([
    normalizeAdId(opp.adId),
    ...cfValues(opp.customFieldsResolved, AD_ID_FIELD).map(normalizeAdId),
    ...cfValues(contact?.customFieldsResolved, AD_ID_FIELD).map(normalizeAdId),
    ...attrsOf(opp, contactById).map((a) => normalizeAdId(a.utmAdId) ?? normalizeAdId(a.adId)),
  ]);
}

/** Sin espacios, sin query ni fragmento, sin "/" final. fb.me distingue mayúsculas: no se pliega. */
export function normalizeUrl(u: string): string {
  return u.trim().replace(/[?#].*$/, "").replace(/\/+$/, "");
}

export function urlCandidates(opp: Opportunity, contactById?: ReadonlyMap<string, Contact>): string[] {
  const contact = contactById?.get(opp.contactId);
  return dedupe(
    [
      ...cfValues(opp.customFieldsResolved, URL_FIELD),
      opp.attributionUrl,
      ...cfValues(contact?.customFieldsResolved, URL_FIELD),
      contact?.attributionUrl,
      ...attrsOf(opp, contactById).map((a) => (typeof a.url === "string" ? a.url : "")),
    ].map((u) => (u ? normalizeUrl(u) : ""))
  );
}

export function nameCandidates(
  opp: Opportunity,
  contactById?: ReadonlyMap<string, Contact>,
  pautaNamesByContact?: ReadonlyMap<string, string[]>
): string[] {
  const contact = contactById?.get(opp.contactId);
  const attrs = attrsOf(opp, contactById);
  return dedupe([
    ...cfValues(opp.customFieldsResolved, NAME_FIELD),
    ...cfValues(contact?.customFieldsResolved, NAME_FIELD),
    ...attrs.map((a) => a.utmCampaign as string | undefined),
    ...attrs.map((a) => a.adName as string | undefined),
    ...(pautaNamesByContact?.get(opp.contactId) ?? []),
  ]).filter((n) => n !== SIN_NOMBRE_CAMPAIGN);
}

// ── Lo que los leads enseñan sobre Meta ─────────────────────────────────────
// Meta no expone la URL corta (fb.me/…) de un anuncio ni la campaña de un
// anuncio ya borrado. Los leads que traen las dos cosas — URL y ad id resuelto,
// o ad id borrado y utmCampaignId — sí lo dicen. Se aprende sobre el set SIN
// filtrar, como assignAdDesarrollos; las importaciones no enseñan nada.

export interface LearnedIndex {
  byUrl: Map<string, { ads: Set<string>; campaigns: Set<string> }>;
  /** ad id con gasto pero fuera de /ads → campaña, según el utmCampaignId de sus leads. */
  campaignOfDeletedAd: Map<string, string>;
}

/** Un ad id "nuestro": está en la jerarquía o, borrado, todavía reporta gasto. */
function knownAd(index: MetaIndex, adId: string): boolean {
  return index.byAd.has(adId) || index.dailyByAd.has(adId);
}

export function buildLearnedIndex(
  allOpportunities: Opportunity[],
  index: MetaIndex,
  contactById?: ReadonlyMap<string, Contact>
): LearnedIndex {
  const byUrl: LearnedIndex["byUrl"] = new Map();
  const campaignOfDeletedAd = new Map<string, string>();
  for (const o of allOpportunities) {
    if (isImported(o)) continue;
    const adId = adIdCandidates(o, contactById).find((id) => knownAd(index, id));
    if (!adId) continue;
    let campaignId = index.byAd.get(adId)?.campaign?.id;
    if (!campaignId) {
      const cid = attrsOf(o, contactById)
        .map((a) => String(a.utmCampaignId ?? "").trim())
        .find((c) => c && index.campaignsById.has(c));
      if (cid) {
        campaignId = cid;
        if (!campaignOfDeletedAd.has(adId)) campaignOfDeletedAd.set(adId, cid);
      }
    }
    for (const u of urlCandidates(o, contactById)) {
      const e = byUrl.get(u) ?? { ads: new Set<string>(), campaigns: new Set<string>() };
      e.ads.add(adId);
      if (campaignId) e.campaigns.add(campaignId);
      byUrl.set(u, e);
    }
  }
  return { byUrl, campaignOfDeletedAd };
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
// En DRT cada cuenta publicitaria ES un desarrollo ("Cañadas by El Mirador ",
// "Átria "…), así que la cuenta manda. Solo si la cuenta no se llama como
// ningún pipeline se cae a la inferencia de la entrega ①: la moda de los
// pipelines de sus leads, luego el nombre de un desarrollo en campaña → adset →
// ad, luego Sin desarrollo. El gasto no se reparte: un ad es de UN desarrollo.
// `mixed` lista los ads con leads en más de un desarrollo, para que la UI lo
// diga en vez de callarlo.
//
// El valor siempre es el nombre REAL del pipeline (el mismo string que
// desarrolloOf), no la etiqueta de PANEL_SCOPES: scopeMetaDaily compara contra
// el pipeline, y una etiqueta distinta haría desaparecer esos ads del tab.

// Agujas: el nombre de cada pipeline (así un séptimo desarrollo aparece sin
// tocar PANEL_SCOPES) más las etiquetas de PANEL_SCOPES resueltas a su
// pipeline real. Las más largas primero: "cañadas by el mirador" antes que
// "cañadas".
function desarrolloNeedles(pipelines: Pipeline[] | undefined): { folded: string; name: string }[] {
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
  return [...needles.entries()]
    .map(([folded, name]) => ({ folded, name }))
    .sort((a, b) => b.folded.length - a.folded.length);
}

/** id de cuenta ("act_…") → nombre real del pipeline, para las cuentas que se llaman como un desarrollo. */
export function accountToPipeline(accounts: MetaAccount[], pipelines: Pipeline[] | undefined): Map<string, string> {
  const labels = desarrolloNeedles(pipelines);
  const m = new Map<string, string>();
  for (const a of accounts) {
    const hay = fold(a.name);
    const hit = labels.find((l) => hay.includes(l.folded));
    if (hit) m.set(a.id, hit.name);
  }
  return m;
}

export function assignAdDesarrollos(
  meta: MetaAdsData,
  index: MetaIndex,
  allOpportunities: Opportunity[],
  pipelines: Pipeline[] | undefined
): { byAd: Map<string, string>; mixed: string[] } {
  const byAccount = accountToPipeline(meta.accounts, pipelines);
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
  const labels = desarrolloNeedles(pipelines);

  const byAd = new Map<string, string>();
  const mixed: string[] = [];
  for (const ad of meta.ads) {
    const v = votes.get(ad.id);
    if (v && v.size > 1) mixed.push(ad.id);
    const entry = index.byAd.get(ad.id);
    const fromAccount = entry?.account ? byAccount.get(entry.account.id) : undefined;
    if (fromAccount) {
      byAd.set(ad.id, fromAccount);
      continue;
    }
    if (v && v.size > 0) {
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
    const haystack = fold([entry?.campaign?.name, entry?.adset?.name, ad.name].filter(Boolean).join(" | "));
    const hit = labels.find((l) => haystack.includes(l.folded));
    byAd.set(ad.id, hit ? hit.name : NO_DESARROLLO);
  }
  // Anuncios borrados: tienen filas diarias pero no están en /ads. Su cuenta
  // viene en la fila; sin cuenta reconocible, Sin desarrollo.
  for (const [adId, rows] of index.dailyByAd) {
    if (byAd.has(adId)) continue;
    const acc = rows.find((r) => r.accountId)?.accountId;
    byAd.set(adId, (acc && byAccount.get(acc)) || NO_DESARROLLO);
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

// "Alcanzó la etapa" vive en lib/desarrollo-funnel.ts: el embudo de GENERAL y
// el costo por etapa tienen que decir lo mismo de la misma oportunidad. Se
// re-exportan para que verify-meta-attribution siga leyéndolas de aquí.
export { reachedStage, stageIndexOf };

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
