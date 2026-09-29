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
import { hadCita, reachedStage, stageIndexOf } from "./desarrollo-funnel";
import { isDePauta, SIN_NOMBRE_CAMPAIGN, type HasKey } from "./pauta";
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

/**
 * oppId → nombre de la campaña de Meta por la cadena completa (classifyLead).
 * Base del primer nivel del filtro global de campaña. Se arma en app/page.tsx
 * sobre el set sin filtrar, una vez por payload.
 */
export function buildMetaCampaignByOpp(opps: Opportunity[], ctx: AttributionContext): Map<string, string> {
  const m = new Map<string, string>();
  for (const o of opps) {
    const a = classifyLead(o, ctx);
    const cid = a.kind === "ad" ? a.campaignId : a.kind === "campaign" ? a.campaignId : null;
    const name = cid ? ctx.index.campaignsById.get(cid)?.name?.trim() : undefined;
    if (name) m.set(o.id, name);
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
// Cuatro niveles, cada uno SOLO si el anterior no dio nada, y nunca sumados:
// contar "tiene ad id Y URL" contaría dos veces. Un lead se ata a un ANUNCIO
// cuando la llave lo identifica, o solo a una CAMPAÑA cuando la llave no baja
// más; los dos son leads CRM de la campaña, solo el primero entra a la fila
// del anuncio. `via` dice por qué nivel entró, para el pie y el drill.

export type AttributionVia = "adId" | "campaignId" | "url" | "name";

export type LeadAttribution =
  | { kind: "ad"; adId: string; campaignId: string | null; via: AttributionVia }
  | { kind: "campaign"; campaignId: string; via: AttributionVia }
  | { kind: "unknownAd"; adId: string }
  | { kind: "noAdId" }
  | { kind: "notPauta" };

export interface AttributionContext {
  index: MetaIndex;
  pautaContacts: HasKey;
  /** buildPautaNamesByContact(allPautas) de lib/pauta.ts (re-exportada por pauta-performance): TODOS los nombres del contacto. */
  pautaNamesByContact: ReadonlyMap<string, string[]>;
  /** Para leer custom fields y attributions del contacto. Sin él, solo lo que la opp trae. */
  contactById?: ReadonlyMap<string, Contact>;
  /** buildLearnedIndex(allOpportunities, index, contactById). Sin él, el nivel 3 no existe. */
  learned?: LearnedIndex;
}

function campaignOfAd(ctx: AttributionContext, adId: string): string | null {
  return ctx.index.byAd.get(adId)?.campaign?.id ?? ctx.learned?.campaignOfDeletedAd.get(adId) ?? null;
}

export function classifyLead(opp: Opportunity, ctx: AttributionContext): LeadAttribution {
  if (isImported(opp)) return { kind: "notPauta" };

  // 1. ad id, de cualquiera de sus fuentes; el primero que Meta reconozca.
  const ids = adIdCandidates(opp, ctx.contactById);
  for (const adId of ids) {
    if (knownAd(ctx.index, adId)) return { kind: "ad", adId, campaignId: campaignOfAd(ctx, adId), via: "adId" };
  }

  // 2. la campaña que GHL guardó en la attribution.
  for (const a of attrsOf(opp, ctx.contactById)) {
    const cid = String(a.utmCampaignId ?? "").trim();
    if (cid && ctx.index.campaignsById.has(cid)) return { kind: "campaign", campaignId: cid, via: "campaignId" };
  }

  // 3. la URL con la que entró, si otros leads enseñaron de qué anuncio es.
  if (ctx.learned) {
    for (const u of urlCandidates(opp, ctx.contactById)) {
      const e = ctx.learned.byUrl.get(u);
      if (!e) continue;
      if (e.ads.size === 1) {
        const adId = [...e.ads][0];
        return { kind: "ad", adId, campaignId: campaignOfAd(ctx, adId), via: "url" };
      }
      if (e.campaigns.size === 1) return { kind: "campaign", campaignId: [...e.campaigns][0], via: "url" };
    }
  }

  // 4. nombres: campaña si es el nombre de UNA campaña; anuncio si es el de UN anuncio.
  const names = nameCandidates(opp, ctx.contactById, ctx.pautaNamesByContact);
  for (const name of names) {
    const k = fold(name);
    const campaigns = ctx.index.campaignsByName.get(k);
    if (campaigns?.size === 1) return { kind: "campaign", campaignId: [...campaigns][0], via: "name" };
    const ads = ctx.index.adsByName.get(k);
    if (ads?.size === 1) {
      const adId = [...ads][0];
      return { kind: "ad", adId, campaignId: campaignOfAd(ctx, adId), via: "name" };
    }
  }

  if (ids.length > 0) return { kind: "unknownAd", adId: ids[0] };
  return isDePauta(opp, ctx.pautaContacts) || names.length > 0 ? { kind: "noAdId" } : { kind: "notPauta" };
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

// ── La agregación de la tarjeta ─────────────────────────────────────────────
// Una sola función produce TODO lo que "Inversión y rendimiento de pauta"
// pinta: la fila KPI, las campañas con sus anuncios, y los residuos del pie.
// Sustituye a buildCostPerStage y buildCampaignPerformance de la entrega ①:
// dos agregaciones sobre el mismo universo se desincronizan al primer cambio.

export const SIN_CAMPANA = "Sin campaña";
export const ANUNCIO_ELIMINADO = "Anuncio eliminado";

export interface PautaMetrics {
  spend: number;
  impressions: number;
  clicks: number;
  cpm: number | null;
  ctr: number | null;
  leadsMeta: number;
  leadsCrm: number;
  citas: number;
  visitas: number;
  ventas: number;
  cpl: number | null;
  costPerVenta: number | null;
  oppIds: { leads: string[]; citas: string[]; visitas: string[]; ventas: string[] };
}

export interface PautaAdRow {
  adId: string;
  name: string;
  /** URLs con las que entraron sus leads (aprendidas), las más frecuentes primero. */
  urls: string[];
  /** Con gasto pero fuera de /ads. */
  deleted: boolean;
  metrics: PautaMetrics;
}

export interface PautaCampaignRow {
  campaignId: string;
  name: string;
  accountId: string;
  accountName: string;
  /** La cubeta "Sin campaña": anuncios borrados cuya campaña nadie enseñó. */
  missing: boolean;
  metrics: PautaMetrics;
  /** Leads atados a la campaña sin anuncio (niveles 2-4). Ya están en metrics.leadsCrm. */
  campaignOnlyLeads: number;
  ads: PautaAdRow[];
}

export interface PautaCell {
  count: number;
  oppIds: string[];
}

export interface PautaInvestment {
  /** "" cuando las cuentas mezclan monedas. */
  currency: string;
  mixedCurrency: boolean;
  kpi: PautaMetrics;
  /** Por gasto desc; "Sin campaña" siempre al final. */
  campaigns: PautaCampaignRow[];
  /** De pauta, sin ninguna llave que pegue. */
  noAdId: PautaCell;
  /** Con ad id de una cuenta no conectada. */
  unknownAd: PautaCell;
  /** Atados a un anuncio o campaña de una cuenta que no es la de esta pestaña. */
  otherAccount: PautaCell;
  notPauta: number;
  /** Cuántos leads CRM entraron por cada nivel. */
  via: Record<AttributionVia, number>;
  /** Gasto de "Sin campaña". */
  unlinkedSpend: number;
}

export interface PautaInvestmentInput {
  /** La cohorte: oportunidades ya acotadas a pestaña, filtros y fecha (createdAt). */
  opportunities: Opportunity[];
  /** Filas diarias ya acotadas a la pestaña (scopeMetaDaily); el rango se aplica aquí. */
  daily: MetaDailyRow[];
  /** YYYY-MM-DD inclusivo, en la zona horaria del panel; null = toda la ventana. */
  range: { start: string; end: string } | null;
  ctx: AttributionContext;
  /** contactIds con cita en el objeto Citas, sin filtrar por fecha. */
  contactsWithCita: ReadonlySet<string>;
  /** Cuentas de ESTA pestaña; null en GENERAL = todas. */
  accountIds: ReadonlySet<string> | null;
}

const VISITA = { key: "visita", minIndex: 5 };
const VENTA = { key: "venta", minIndex: 8 };

function emptyMetrics(): PautaMetrics {
  return {
    spend: 0, impressions: 0, clicks: 0, cpm: null, ctr: null,
    leadsMeta: 0, leadsCrm: 0, citas: 0, visitas: 0, ventas: 0, cpl: null, costPerVenta: null,
    oppIds: { leads: [], citas: [], visitas: [], ventas: [] },
  };
}

function addDaily(m: PautaMetrics, d: MetaDailyRow) {
  m.spend += d.spend;
  m.impressions += d.impressions;
  m.clicks += d.clicks;
  m.leadsMeta += d.leadsForm + d.leadsMsg;
}

function addLead(m: PautaMetrics, o: Opportunity, contactsWithCita: ReadonlySet<string>) {
  m.leadsCrm++;
  m.oppIds.leads.push(o.id);
  if (hadCita(o, contactsWithCita)) {
    m.citas++;
    m.oppIds.citas.push(o.id);
  }
  // Visita: ≥05 o ganada — el embudo es monótono, como en "Visitas por desarrollo".
  if (reachedStage(o, VISITA) || reachedStage(o, VENTA)) {
    m.visitas++;
    m.oppIds.visitas.push(o.id);
  }
  if (reachedStage(o, VENTA)) {
    m.ventas++;
    m.oppIds.ventas.push(o.id);
  }
}

// `costs` apaga CPL y costo por venta: solo el KPI global lo hace, cuando las
// cuentas mezclan monedas. Una campaña o un anuncio viven en UNA cuenta, así
// que sus costos siempre valen.
function finishMetrics(m: PautaMetrics, costs: boolean) {
  m.cpm = m.impressions > 0 ? (m.spend / m.impressions) * 1000 : null;
  m.ctr = ratio(m.clicks, m.impressions);
  m.cpl = costs && m.spend > 0 ? ratio(m.spend, m.leadsCrm) : null;
  m.costPerVenta = costs && m.spend > 0 ? ratio(m.spend, m.ventas) : null;
}

function accountOfAd(ctx: AttributionContext, adId: string): string | null {
  return (
    ctx.index.byAd.get(adId)?.account?.id ??
    ctx.index.dailyByAd.get(adId)?.find((r) => r.accountId)?.accountId ??
    null
  );
}

const OPP_KEYS = ["leads", "citas", "visitas", "ventas"] as const;

function foldInto(target: PautaMetrics, src: PautaMetrics) {
  target.spend += src.spend;
  target.impressions += src.impressions;
  target.clicks += src.clicks;
  target.leadsMeta += src.leadsMeta;
  target.leadsCrm += src.leadsCrm;
  target.citas += src.citas;
  target.visitas += src.visitas;
  target.ventas += src.ventas;
  for (const k of OPP_KEYS) target.oppIds[k].push(...src.oppIds[k]);
}

export function buildPautaInvestment(p: PautaInvestmentInput): PautaInvestment {
  const { ctx } = p;
  const rows = new Map<string, PautaCampaignRow>();
  const adRows = new Map<string, PautaAdRow>();
  const urlCounts = new Map<string, Map<string, number>>();

  const campaignRow = (campaignId: string | null, accountId: string | null): PautaCampaignRow => {
    const key = campaignId ?? "";
    let r = rows.get(key);
    if (r) return r;
    const c = campaignId ? ctx.index.campaignsById.get(campaignId) : undefined;
    const acc = c?.accountId ?? accountId ?? "";
    r = {
      campaignId: key,
      name: c?.name ?? (campaignId ? campaignId : SIN_CAMPANA),
      accountId: acc,
      accountName: ctx.index.accountsById.get(acc)?.name?.trim() ?? "",
      missing: !campaignId,
      metrics: emptyMetrics(),
      campaignOnlyLeads: 0,
      ads: [],
    };
    rows.set(key, r);
    return r;
  };
  const adRow = (adId: string): PautaAdRow => {
    let a = adRows.get(adId);
    if (a) return a;
    const entry = ctx.index.byAd.get(adId);
    a = {
      adId,
      name: entry ? entry.ad.name : ANUNCIO_ELIMINADO,
      urls: [],
      deleted: !entry,
      metrics: emptyMetrics(),
    };
    adRows.set(adId, a);
    const campaignId = entry?.campaign?.id ?? ctx.learned?.campaignOfDeletedAd.get(adId) ?? null;
    campaignRow(campaignId, accountOfAd(ctx, adId)).ads.push(a);
    return a;
  };

  // Gasto: solo el rango; cada fila va a su anuncio y a su campaña.
  const currencies = new Set<string>();
  for (const d of p.daily) {
    if (!inRange(d.date, p.range)) continue;
    const a = adRow(d.adId);
    addDaily(a.metrics, d);
    const acc = accountOfAd(ctx, d.adId);
    if (acc) currencies.add(ctx.index.accountsById.get(acc)?.currency ?? "");
  }
  const mixedCurrency = currencies.size > 1;
  const currency = mixedCurrency ? "" : ([...currencies][0] ?? "");

  // Leads: la cohorte ya viene cortada; aquí solo se clasifica y se reparte.
  const via: Record<AttributionVia, number> = { adId: 0, campaignId: 0, url: 0, name: 0 };
  const noAdId: PautaCell = { count: 0, oppIds: [] };
  const unknownAd: PautaCell = { count: 0, oppIds: [] };
  const otherAccount: PautaCell = { count: 0, oppIds: [] };
  let notPauta = 0;
  const inScope = (accountId: string | null) => p.accountIds === null || (!!accountId && p.accountIds.has(accountId));

  for (const o of p.opportunities) {
    const a = classifyLead(o, ctx);
    if (a.kind === "notPauta") {
      notPauta++;
      continue;
    }
    if (a.kind === "noAdId") {
      noAdId.count++;
      noAdId.oppIds.push(o.id);
      continue;
    }
    if (a.kind === "unknownAd") {
      unknownAd.count++;
      unknownAd.oppIds.push(o.id);
      continue;
    }
    const accountId =
      a.kind === "ad" ? accountOfAd(ctx, a.adId) : (ctx.index.campaignsById.get(a.campaignId)?.accountId ?? null);
    if (!inScope(accountId)) {
      otherAccount.count++;
      otherAccount.oppIds.push(o.id);
      continue;
    }
    via[a.via]++;
    if (a.kind === "ad") {
      const ad = adRow(a.adId);
      addLead(ad.metrics, o, p.contactsWithCita);
      for (const u of urlCandidates(o, ctx.contactById)) {
        const m = urlCounts.get(a.adId) ?? new Map<string, number>();
        m.set(u, (m.get(u) ?? 0) + 1);
        urlCounts.set(a.adId, m);
      }
    } else {
      const r = campaignRow(a.campaignId, accountId);
      r.campaignOnlyLeads++;
      addLead(r.metrics, o, p.contactsWithCita);
    }
  }

  // Cerrar: los anuncios suman a su campaña; la campaña suma al KPI.
  const kpi = emptyMetrics();
  for (const r of rows.values()) {
    for (const ad of r.ads) {
      ad.urls = [...(urlCounts.get(ad.adId) ?? new Map<string, number>()).entries()]
        .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
        .map(([u]) => u);
      finishMetrics(ad.metrics, true);
      foldInto(r.metrics, ad.metrics);
    }
    r.ads.sort((x, y) => y.metrics.spend - x.metrics.spend || y.metrics.leadsCrm - x.metrics.leadsCrm || x.adId.localeCompare(y.adId));
    finishMetrics(r.metrics, true);
    foldInto(kpi, r.metrics);
  }
  finishMetrics(kpi, !mixedCurrency);

  const campaigns = [...rows.values()].sort((x, y) => {
    if (x.missing !== y.missing) return x.missing ? 1 : -1;
    return y.metrics.spend - x.metrics.spend || y.metrics.leadsCrm - x.metrics.leadsCrm || x.name.localeCompare(y.name, "es");
  });
  const unlinkedSpend = rows.get("")?.metrics.spend ?? 0;

  return { currency, mixedCurrency, kpi, campaigns, noAdId, unknownAd, otherAccount, notPauta, via, unlinkedSpend };
}
