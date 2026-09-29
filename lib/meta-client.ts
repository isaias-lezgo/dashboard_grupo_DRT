// lib/meta-client.ts
// Cliente de la Marketing API de Meta (Graph). Server-only: nunca lo importes
// desde un componente — el token vive aquí y en el sync, y en ningún otro lado.
// Mismo estatus que lib/ghl-client.ts.
//
// Solo lectura (ads_read). La única llamada que no es GET es el canje del `code`
// del OAuth, y esa tampoco escribe nada en Meta.
import { GRAPH_VERSION } from "./meta-oauth";
import {
  dateChunks,
  filterAdsCreatedSince,
  INSIGHTS_CHUNK_DAYS,
  mergeMetaAds,
  nextPageRequest,
  splitRange,
  normalizeAds,
  normalizeInsightRow,
  type RawAd,
  type RawInsightRow,
} from "./meta-normalize";
import type { MetaAccountInfo } from "./meta-connection-store";
import type { MetaAdsData, MetaDailyRow } from "./types";

const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

// Códigos de throttling de Graph que vale la pena reintentar. 190 (token
// inválido/revocado) NO está aquí a propósito: es terminal. Tampoco 1 y 2
// ("Unknown error" / "Service temporarily unavailable"): en insights significan
// "consulta demasiado pesada" y se resuelven partiendo el tramo
// (fetchInsightsRange), no repitiéndolo.
const RETRYABLE_CODES = new Set([4, 17, 32, 613, 80004]);
// Códigos con los que Meta se rinde antes de terminar de calcular un tramo.
const TOO_HEAVY_CODES = new Set([1, 2]);
const MAX_ATTEMPTS = 3;
// Graph limita por AD ACCOUNT, no por token: todas las cuentas pueden ir a la
// vez. Dentro de una cuenta, ocho tramos semanales en paralelo. Medido
// 2026-09-29 en Átria: una semana tarda 7-12 s sola y seis en paralelo tardan
// 13 s en total, con la utilización del límite de insights en 0.01 %; con tres
// en paralelo las seis cuentas tardaban 285 s, arriba del techo de 300 s del
// refresco en segundo plano junto con el sync de GHL.
const ACCOUNT_CONCURRENCY = 8;
const CHUNK_CONCURRENCY = 8;

export class MetaApiError extends Error {
  code: number;
  subcode?: number;
  status: number;
  constructor(message: string, status: number, code: number, subcode?: number) {
    super(message);
    this.name = "MetaApiError";
    this.status = status;
    this.code = code;
    this.subcode = subcode;
  }
  /** Token revocado, caducado o de otra app: hay que reconectar, no reintentar. */
  get isTokenInvalid(): boolean {
    return this.code === 190 || this.code === 102;
  }
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

interface GraphErrorBody {
  error?: { message?: string; code?: number; error_subcode?: number; type?: string };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// GET con reintento en throttling y 5xx. El token va en el query string porque
// así lo espera Graph; nunca en un log — por eso los errores citan la ruta y el
// código, no la URL completa.
async function graphGet<T>(path: string, params: Record<string, string>, token?: string): Promise<T> {
  const url = new URL(`${GRAPH}/${path.replace(/^\//, "")}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  if (token) url.searchParams.set("access_token", token);

  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { headers: { Accept: "application/json" } });
    } catch (err) {
      // Solo el mensaje: el `cause` de un TypeError de fetch trae la URL, y la
      // URL trae el token.
      lastErr = new Error(`Graph ${path}: ${err instanceof Error ? err.message : String(err)}`);
      await sleep(1000 * 2 ** (attempt - 1));
      continue;
    }
    if (res.ok) return (await res.json()) as T;

    const body = (await res.json().catch(() => ({}))) as GraphErrorBody;
    const code = body.error?.code ?? 0;
    const err = new MetaApiError(
      `Graph ${path} → ${res.status} (code ${code}): ${body.error?.message ?? res.statusText}`,
      res.status,
      code,
      body.error?.error_subcode
    );
    if (err.isTokenInvalid) throw err;
    const retryable = RETRYABLE_CODES.has(code) || res.status >= 500;
    if (!retryable || attempt === MAX_ATTEMPTS) throw err;
    lastErr = err;
    await sleep(2000 * 2 ** (attempt - 1));
  }
  throw lastErr instanceof Error ? lastErr : new Error(`Graph ${path} failed`);
}

// Sigue `paging.next` hasta agotar. Graph ya incluye el token en `next`; se
// quita y se vuelve a poner por el camino normal para que nunca haya dos. La
// versión del enlace tampoco es la nuestra (ver nextPageRequest).
async function graphGetAll<T>(path: string, params: Record<string, string>, token: string): Promise<T[]> {
  const out: T[] = [];
  let page = await graphGet<{ data: T[]; paging?: { next?: string } }>(path, params, token);
  out.push(...page.data);
  while (page.paging?.next) {
    const next = nextPageRequest(page.paging.next);
    page = await graphGet(next.path, next.params, token);
    out.push(...page.data);
  }
  return out;
}

// ── OAuth ───────────────────────────────────────────────────────────────────

export async function exchangeCode(p: { code: string; redirectUri: string }): Promise<{ accessToken: string }> {
  const body = await graphGet<{ access_token: string }>("oauth/access_token", {
    client_id: requireEnv("META_APP_ID"),
    client_secret: requireEnv("META_APP_SECRET"),
    redirect_uri: p.redirectUri,
    code: p.code,
  });
  if (!body.access_token) throw new Error("Graph oauth/access_token: sin access_token");
  return { accessToken: body.access_token };
}

// Qué clase de token nos dieron y cuándo caduca. `expires_at: 0` = nunca, que es
// lo que devuelve un token de usuario del sistema.
export async function debugToken(token: string): Promise<{ type: string; expiresAt: string | null; isValid: boolean }> {
  const appToken = `${requireEnv("META_APP_ID")}|${requireEnv("META_APP_SECRET")}`;
  const body = await graphGet<{ data: { type?: string; expires_at?: number; is_valid?: boolean } }>(
    "debug_token",
    { input_token: token, access_token: appToken }
  );
  const d = body.data ?? {};
  return {
    type: (d.type ?? "").toUpperCase(),
    expiresAt: d.expires_at ? new Date(d.expires_at * 1000).toISOString() : null,
    isValid: d.is_valid !== false,
  };
}

export async function fetchMe(token: string): Promise<{ id: string; name: string }> {
  const me = await graphGet<{ id: string; name?: string }>("me", { fields: "id,name" }, token);
  return { id: me.id, name: me.name ?? "" };
}

export async function listAdAccounts(token: string): Promise<MetaAccountInfo[]> {
  const rows = await graphGetAll<{
    id: string;
    name?: string;
    account_status?: number;
    currency?: string;
    timezone_name?: string;
  }>("me/adaccounts", { fields: "id,name,account_status,currency,timezone_name", limit: "100" }, token);
  return rows.map((r) => ({
    id: r.id,
    name: r.name ?? r.id,
    currency: r.currency ?? "",
    timezone: r.timezone_name ?? "",
    status: r.account_status ?? 0,
  }));
}

// ── Dataset ─────────────────────────────────────────────────────────────────

// Corre `fn` sobre `items` con a lo más `limit` en vuelo, conservando el orden
// de los resultados. Una excepción tumba el pool entero: para una cuenta, un
// mes que falla invalida la cuenta (no se puede reportar medio gasto).
async function runPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) results[i] = await fn(items[i]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function listAds(token: string, accountId: string): Promise<RawAd[]> {
  return graphGetAll<RawAd>(
    `${accountId}/ads`,
    { fields: "id,name,effective_status,created_time,adset{id,name},campaign{id,name,objective}", limit: "500" },
    token
  );
}

async function adInsightsDaily(
  token: string,
  accountId: string,
  since: string,
  until: string
): Promise<MetaDailyRow[]> {
  const rows = await graphGetAll<RawInsightRow>(
    `${accountId}/insights`,
    {
      level: "ad",
      time_increment: "1",
      time_range: JSON.stringify({ since, until }),
      fields: "ad_id,date_start,spend,impressions,reach,clicks,inline_link_clicks,actions",
      limit: "500",
    },
    token
  );
  return rows.map((r) => normalizeInsightRow(r, accountId));
}

// Un tramo de insights. Si Meta no alcanza a calcularlo (code 1 / 2), se parte
// a la mitad y se piden las mitades; un solo día que truene sí es un fallo.
async function fetchInsightsRange(
  token: string,
  accountId: string,
  since: string,
  until: string
): Promise<MetaDailyRow[]> {
  try {
    return await adInsightsDaily(token, accountId, since, until);
  } catch (err) {
    if (!(err instanceof MetaApiError) || !TOO_HEAVY_CODES.has(err.code)) throw err;
    const halves = splitRange(since, until);
    if (!halves) throw err;
    console.warn(`[meta] ${accountId} insights ${since}..${until} demasiado pesado (code ${err.code}); se parte en dos`);
    const [a, b] = await Promise.all(halves.map((h) => fetchInsightsRange(token, accountId, h.since, h.until)));
    return [...a, ...b];
  }
}

// Una cuenta completa: jerarquía + gasto diario por tramos de una semana. Las excepciones suben
// al llamador, que decide si es la cuenta o el token lo que falló.
async function fetchAccount(
  token: string,
  account: MetaAccountInfo,
  window: { since: string; until: string },
  adsCreatedSince: string | null,
  onAds: (n: number) => void
) {
  const { kept, droppedIds } = filterAdsCreatedSince(await listAds(token, account.id), adsCreatedSince);
  onAds(kept.length);
  const chunks = await runPool(dateChunks(window.since, window.until, INSIGHTS_CHUNK_DAYS), CHUNK_CONCURRENCY, (chunk) =>
    fetchInsightsRange(token, account.id, chunk.since, chunk.until)
  );
  // Las filas de los anuncios descartados se van con ellos; las de un anuncio
  // que Graph ya no lista en /ads (borrado) se quedan: su gasto fue real.
  const daily = chunks.flat().filter((d) => !droppedIds.has(d.adId));
  return {
    account: { id: account.id, name: account.name, currency: account.currency, timezone: account.timezone },
    hierarchy: normalizeAds(account.id, kept),
    daily,
  };
}

/**
 * Trae el dataset completo de las cuentas dadas. Concurrencia 2 entre cuentas.
 * Una cuenta que falla queda en `failedAccounts` y las demás siguen; un token
 * revocado (190) aborta todo con MetaApiError.isTokenInvalid — no tiene sentido
 * seguir pidiendo con un token muerto.
 */
export async function fetchMetaAds(p: {
  token: string;
  accounts: MetaAccountInfo[];
  window: { since: string; until: string };
  /** YYYY-MM-DD: anuncios creados antes se descartan. null = sin filtro. */
  adsCreatedSince: string | null;
  onProgress?: (adsSoFar: number) => void;
}): Promise<MetaAdsData> {
  const parts: Awaited<ReturnType<typeof fetchAccount>>[] = [];
  const failed: { id: string; reason: string }[] = [];
  let adsSoFar = 0;
  const queue = [...p.accounts];

  const worker = async () => {
    for (let acc = queue.shift(); acc; acc = queue.shift()) {
      try {
        parts.push(
          await fetchAccount(p.token, acc, p.window, p.adsCreatedSince, (n) => {
            adsSoFar += n;
            p.onProgress?.(adsSoFar);
          })
        );
      } catch (err) {
        if (err instanceof MetaApiError && err.isTokenInvalid) throw err;
        // Solo el mensaje: un TypeError de fetch trae la URL (con el token) en
        // `cause`, y eso no puede aterrizar en un log.
        console.error(`[meta] cuenta ${acc.id} falló:`, err instanceof Error ? err.message : String(err));
        failed.push({
          id: acc.id,
          reason: err instanceof MetaApiError ? `code_${err.code}` : "network",
        });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(ACCOUNT_CONCURRENCY, queue.length) }, worker));

  // Orden estable por id: el orden de llegada depende de la concurrencia y
  // repintaría los charts entre syncs.
  parts.sort((a, b) => a.account.id.localeCompare(b.account.id));
  return mergeMetaAds(parts, failed, p.window);
}
