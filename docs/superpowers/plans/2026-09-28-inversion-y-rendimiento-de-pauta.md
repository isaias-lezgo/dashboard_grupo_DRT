# "Inversión y rendimiento de pauta" — plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Una tarjeta por pestaña que cruza el gasto de Meta Ads con los leads del CRM por campaña → anuncio, con nombres de Meta, sobre un sync que sí trae las seis cuentas y cabe en 300 s.

**Architecture:** El sync (`lib/sync.ts` → `lib/meta-client.ts`) trae la jerarquía y el gasto desde la creación de la subcuenta, todas las cuentas en paralelo. Lo puro vive en `lib/meta-attribution.ts`: la cadena de cuatro niveles (`classifyLead`), la cuenta como desarrollo, y `buildPautaInvestment` que produce todo lo que la tarjeta pinta. `app/page.tsx` arma el contexto de Meta una vez sobre el set sin filtrar; la tarjeta (`components/dashboard/pauta-investment-card.tsx`) solo llama a la agregación y dibuja.

**Tech Stack:** Next.js 16 (App Router), React, TypeScript, shadcn/ui, lucide-react; scripts de aserción con `node:assert/strict` vía `tsx` (no hay framework de pruebas).

**Spec:** `docs/superpowers/specs/2026-09-28-inversion-y-rendimiento-de-pauta-design.md`

## Global Constraints

- Paquete CommonJS: en `scripts/verify-*.ts` **nada de `await` de nivel superior**; envolver en `main().catch(...)`.
- Gestor de paquetes **pnpm**. No hay que instalar nada nuevo.
- `npx tsc --noEmit` es la compuerta real: `next build` ignora errores de TS.
- Etapas por **nombre**, nunca por id. "Alcanzó" = `reachedStage` de `lib/desarrollo-funnel.ts`; venta = `isWonOpp`; cita = `hadCita` de `lib/pauta-performance.ts` (etapa `≥04` ∪ ganada ∪ objeto Citas).
- Día local = `localDay()` de `lib/meta-attribution.ts` (`America/Mexico_City`), nunca UTC.
- Toda cubeta centinela ("Sin campaña", "Sin ad id", "Anuncio eliminado") tiñe **solo la etiqueta** con `MISSING_TEXT`; un estado vacío legítimo ("Sin gasto en el periodo") no.
- Ningún componente importa `lib/meta-client.ts` ni `lib/ghl-client.ts`.
- Sin scroll anidado en tarjetas: tabla en un `div.overflow-x-auto` plano.
- Sin resultados → `null` → "—". Nunca `$0` ni `∞`.
- El token de Meta jamás aparece en un log ni en un frame.
- Mensajes de commit en español, con la línea `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` al final.

## Review Focus

1. **Un anuncio con gasto que ya no está en `/ads`** (borrado): su gasto debe seguir en la tabla bajo "Anuncio eliminado" y en el KPI de gasto, nunca desaparecer. Prueba en Task 5 (`buildPautaInvestment`, caso `adId "777"`).
2. **Una oportunidad con ad id de una cuenta no conectada y además `utmCampaignId` de una campaña conocida** debe caer a campaña (nivel 2), no a `unknownAd`. Prueba en Task 4.
3. **Una URL compartida por varios anuncios de la misma campaña** debe resolver a campaña, no descartarse ni elegir un anuncio al azar. Prueba en Task 4.
4. **`dateAdded` de la subcuenta ausente** (GHL no lo devuelve): la ventana cae al mes en curso y ningún anuncio se filtra; la tarjeta lo dice. Prueba en Task 1 (`historyWindow(undefined, …)`) y Task 2 (`filterAdsCreatedSince(raw, null)`).
5. **Filtro de fechas que corta a media semana**: el gasto se suma por `date` en días CDMX y la cohorte ya viene cortada por `createdAt`; un rango `2026-08-01..2026-08-31` no debe sumar el gasto del 1 de septiembre. Prueba en Task 5 (fila del `2026-09-01` con `spend: 999` fuera del rango).

---

### Task 0: Commitear lo pendiente antes de tocar nada

El árbol trae dos cambios sin commit: el desmontaje de "Tareas pendientes por asesor" (sesión anterior) y la corrección de la paginación de Graph (esta sesión). Van en dos commits separados para que el historial diga qué fue cada cosa.

**Files:**
- Modify (ya modificados): `CLAUDE.md`, `components/dashboard/panel-dashboard.tsx`, `lib/meta-client.ts`, `lib/meta-normalize.ts`, `scripts/verify-meta.ts`

- [ ] **Step 1: Confirmar que lo pendiente está verde**

Run: `pnpm verify:meta && npx tsc --noEmit`
Expected: `✅ verify:meta OK` y `tsc` sin salida.

- [ ] **Step 2: Commit del desmontaje**

```bash
git add CLAUDE.md components/dashboard/panel-dashboard.tsx
git commit -m "chore(panel): desmontar \"Tareas pendientes por asesor\" (pedido del cliente)

El archivo task-backlog-chart.tsx se conserva; allTasks y unfilteredOpportunities
siguen cableados por si vuelve.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 3: Commit de la corrección de paginación**

```bash
git add lib/meta-client.ts lib/meta-normalize.ts scripts/verify-meta.ts
git commit -m "fix(meta): seguir paging.next aunque Graph lo devuelva bajo otra versión

Graph respondía la segunda página bajo /v26.0/ y el cliente solo quitaba la
versión propia, así que la ruta quedaba v23.0//v26.0/act_…/insights → 400
code 2500. Solo paginan las cuentas grandes: fallaban La Sierra, Cañadas,
Saggita y Átria y pasaban Palmyra y Zanda. Los códigos transitorios 1 y 2
entran a los reintentos.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

`tsconfig.tsbuildinfo` queda modificado y sin commitear; no lo toques.

---

### Task 1: Ventana de historia desde la creación de la subcuenta

**Files:**
- Modify: `lib/meta-normalize.ts` (función `historyWindow`, líneas ~144-174)
- Modify: `lib/ghl-client.ts:207-212` (`GHLLocation`)
- Modify: `lib/types.ts` (`DashboardPayload.meta`)
- Modify: `lib/sync.ts` (`locationPromise` ~508, bloque Meta ~756-775, `meta:` del payload ~845)
- Test: `scripts/verify-meta.ts`

**Interfaces:**
- Produces: `historyWindow(locationCreatedAt: string | null | undefined, today: string): { since: string; until: string }` y `DashboardPayload.meta.locationCreatedAt?: string`.

- [ ] **Step 1: Reescribir la aserción de la ventana en `scripts/verify-meta.ts`**

Reemplaza el bloque completo que va desde el comentario `// --- ventana de historia: desde el primer día del mes de la opp más vieja con adId` hasta la línea `assert.deepEqual(historyWindow([], "2026-09-13"), …);` inclusive, por:

```ts
  // --- ventana de historia: desde el primer día del mes en que se creó la subcuenta
  assert.deepEqual(historyWindow("2025-10-15T21:34:53.965Z", "2026-09-28"), {
    since: "2025-10-01",
    until: "2026-09-28",
  });
  // --- tope de 24 meses
  const old = historyWindow("2020-01-01T00:00:00.000Z", "2026-09-13");
  assert.equal(old.since, "2024-09-01", `tope de ${MAX_HISTORY_MONTHS} meses`);
  // --- sin fecha de creación (GHL no la devolvió): solo el mes actual
  assert.deepEqual(historyWindow(undefined, "2026-09-13"), { since: "2026-09-01", until: "2026-09-13" });
  assert.deepEqual(historyWindow("no-es-fecha", "2026-09-13"), { since: "2026-09-01", until: "2026-09-13" });
  // --- subcuenta "creada" después de hoy (reloj mal): no se pide una ventana invertida
  assert.deepEqual(historyWindow("2027-01-01T00:00:00.000Z", "2026-09-13"), { since: "2026-09-01", until: "2026-09-13" });
```

- [ ] **Step 2: Correr y ver que falla**

Run: `pnpm verify:meta`
Expected: FAIL (error de tipos de `tsx` o `AssertionError` en la primera aserción nueva).

- [ ] **Step 3: Reescribir `historyWindow` en `lib/meta-normalize.ts`**

Sustituye la función completa (comentario incluido) por:

```ts
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
```

- [ ] **Step 4: Correr y ver que pasa**

Run: `pnpm verify:meta`
Expected: `✅ verify:meta OK`

- [ ] **Step 5: Traer `dateAdded` de GHL y guardarlo en el payload**

`lib/ghl-client.ts`, en `GHLLocation`, agrega un campo:

```ts
export interface GHLLocation {
  id: string;
  name: string;
  companyId?: string;
  logoUrl?: string;
  /** ISO. Cuándo se creó la subcuenta; ancla la ventana de Meta Ads. */
  dateAdded?: string;
}
```

`lib/types.ts`, en `DashboardPayload.meta`, agrega:

```ts
  meta: {
    totalContacts: number
    totalOpportunities: number
    /** When the data was pulled from GHL — the clock behind "Actualizado hace X"
     *  and the value stored in `project_sync.synced_at`. */
    fetchedAt: string
    /**
     * ISO de `dateAdded` de la subcuenta. Ancla la ventana de Meta Ads y el
     * filtro de anuncios; ausente si GHL no lo devolvió o en frames viejos.
     */
    locationCreatedAt?: string
  }
```

`lib/sync.ts`, donde se declara `let locationName = "";` (~línea 507), agrega `let locationCreatedAt: string | undefined;` y dentro del `.then` de `locationPromise`, después del `if (name) {...}`:

```ts
        const created = res?.location?.dateAdded?.trim();
        if (created && !Number.isNaN(new Date(created).getTime())) locationCreatedAt = created;
```

En el bloque Meta, justo antes de `let metaAds: MetaAdsData | null = null;`, agrega:

```ts
    // La ventana de Meta se ancla en la creación de la subcuenta, así que la
    // resolución de /locations tiene que haber terminado antes de pedir gasto.
    await locationPromise;
```

Y cambia la llamada a `historyWindow(...)` dentro de `fetchMetaAds({...})` por:

```ts
          window: historyWindow(locationCreatedAt, today),
```

En el `return` final, dentro de `meta: {`, después de `fetchedAt: new Date().toISOString(),` agrega:

```ts
        ...(locationCreatedAt ? { locationCreatedAt } : {}),
```

Quita el import de `oppAdId` en `lib/sync.ts` (línea 32) si ya no se usa en ese archivo — búscalo con `grep -n oppAdId lib/sync.ts`; si la única aparición era la de la ventana, elimina el import.

- [ ] **Step 6: Tipos en verde y commit**

Run: `npx tsc --noEmit && pnpm verify:meta`
Expected: sin errores; `✅ verify:meta OK`.

```bash
git add lib/meta-normalize.ts lib/ghl-client.ts lib/types.ts lib/sync.ts scripts/verify-meta.ts
git commit -m "feat(meta): la ventana de gasto arranca en la creación de la subcuenta

historyWindow deja de mirar la oportunidad más vieja con ad id y toma el
dateAdded de /locations (2025-10-15 en DRT), que viaja en meta.locationCreatedAt.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Descartar anuncios anteriores a la subcuenta y traer las cuentas en paralelo

**Files:**
- Modify: `lib/meta-normalize.ts` (`RawAd`, `normalizeAds`, `normalizeInsightRow`, nueva `filterAdsCreatedSince`)
- Modify: `lib/types.ts` (`MetaAd.createdTime`, `MetaDailyRow.accountId`)
- Modify: `lib/meta-client.ts` (`listAds`, `adInsightsDaily`, `fetchAccount`, `fetchMetaAds`, concurrencia)
- Modify: `lib/sync.ts` (llamada a `fetchMetaAds`)
- Test: `scripts/verify-meta.ts`

**Interfaces:**
- Produces: `filterAdsCreatedSince(raw: RawAd[], since: string | null): { kept: RawAd[]; droppedIds: Set<string> }`; `normalizeInsightRow(r, accountId)`; `MetaAd.createdTime?: string`; `MetaDailyRow.accountId?: string`; `fetchMetaAds({ token, accounts, window, adsCreatedSince, onProgress })`.

- [ ] **Step 1: Aserciones nuevas en `scripts/verify-meta.ts`**

Agrega `filterAdsCreatedSince` al import de `../lib/meta-normalize`. Justo antes de `console.log("✅ verify:meta OK");` agrega:

```ts
  // --- anuncios creados antes de la subcuenta se descartan con su id; sin fecha se conservan
  const rawAds = [
    { id: "old", name: "Leads_Enero", created_time: "2021-01-05T10:00:00+0000" },
    { id: "edge", name: "El mismo día", created_time: "2025-10-15T23:59:00-0600" },
    { id: "new", name: "a1", created_time: "2026-02-01T10:00:00+0000" },
    { id: "nodate", name: "sin created_time" },
  ];
  const f = filterAdsCreatedSince(rawAds, "2025-10-15");
  assert.deepEqual(f.kept.map((a) => a.id), ["edge", "new", "nodate"]);
  assert.deepEqual([...f.droppedIds], ["old"]);
  const all = filterAdsCreatedSince(rawAds, null);
  assert.equal(all.kept.length, 4, "sin fecha de subcuenta no se filtra nada");
  assert.equal(all.droppedIds.size, 0);
  // --- el created_time viaja al dataset; la fila diaria sabe de qué cuenta es
  const hNew = normalizeAds("act_1", [{ id: "n", name: "a1", created_time: "2026-02-01T10:00:00+0000" }]);
  assert.equal(hNew.ads[0].createdTime, "2026-02-01T10:00:00+0000");
  assert.equal(normalizeInsightRow({ ad_id: "1", date_start: "2026-09-01" }, "act_9").accountId, "act_9");
```

Y en la llamada existente `normalizeInsightRow({ ad_id: "120247808685340416", …})` del inicio del `main()` (la de `row`) y en la de `bare`, agrega el segundo argumento `"act_1"`. En el `assert.deepEqual(row, {...})` agrega `accountId: "act_1"` al objeto esperado.

- [ ] **Step 2: Correr y ver que falla**

Run: `pnpm verify:meta`
Expected: FAIL (`filterAdsCreatedSince` no existe).

- [ ] **Step 3: Implementar en `lib/meta-normalize.ts`**

En `RawAd` agrega `created_time?: string;`. Cambia `normalizeInsightRow` para recibir la cuenta:

```ts
export function normalizeInsightRow(r: RawInsightRow, accountId: string): MetaDailyRow {
  return {
    adId: String(r.ad_id),
    accountId,
    date: r.date_start,
    spend: num(r.spend),
    impressions: num(r.impressions),
    reach: num(r.reach),
    clicks: num(r.clicks),
    linkClicks: num(r.inline_link_clicks),
    leadsForm: action(r, LEAD_FORM_ACTION),
    leadsMsg: action(r, LEAD_MSG_ACTION),
  };
}
```

En `normalizeAds`, en el `ads.push({...})`, agrega `createdTime: a.created_time,`. Después de `normalizeAds` agrega:

```ts
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
```

`lib/types.ts`: en `MetaAd` agrega `/** ISO de Graph `created_time`; ausente en frames anteriores a 2026-09-28. */ createdTime?: string`; en `MetaDailyRow` agrega `/** "act_…" de la cuenta que reportó la fila; ausente en frames viejos. */ accountId?: string`.

- [ ] **Step 4: Correr y ver que pasa**

Run: `pnpm verify:meta`
Expected: `✅ verify:meta OK`

- [ ] **Step 5: `lib/meta-client.ts` — created_time, filtro, cuenta en la fila, concurrencia**

Reemplaza las constantes de concurrencia:

```ts
// Graph limita por AD ACCOUNT, no por token: todas las cuentas pueden ir a la
// vez. Dentro de una cuenta, tres meses en paralelo. Medido 2026-09-28: en
// serie (2 cuentas, meses uno por uno) el fetch de DRT tardaba 362 s, arriba
// del techo de 300 s del refresco en segundo plano.
const ACCOUNT_CONCURRENCY = 8;
const MONTH_CONCURRENCY = 3;
```

Agrega `filterAdsCreatedSince` al import de `./meta-normalize`. Agrega un pool genérico antes de `listAds`:

```ts
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
```

`listAds`: agrega `created_time` a `fields`:

```ts
    { fields: "id,name,effective_status,created_time,adset{id,name},campaign{id,name,objective}", limit: "500" },
```

`adInsightsDaily`: `return rows.map((r) => normalizeInsightRow(r, accountId));`

`fetchAccount` completo:

```ts
async function fetchAccount(
  token: string,
  account: MetaAccountInfo,
  window: { since: string; until: string },
  adsCreatedSince: string | null,
  onAds: (n: number) => void
) {
  const { kept, droppedIds } = filterAdsCreatedSince(await listAds(token, account.id), adsCreatedSince);
  onAds(kept.length);
  const months = await runPool(monthChunks(window.since, window.until), MONTH_CONCURRENCY, (chunk) =>
    adInsightsDaily(token, account.id, chunk.since, chunk.until)
  );
  // Las filas de los anuncios descartados se van con ellos; las de un anuncio
  // que Graph ya no lista en /ads (borrado) se quedan: su gasto fue real.
  const daily = months.flat().filter((d) => !droppedIds.has(d.adId));
  return {
    account: { id: account.id, name: account.name, currency: account.currency, timezone: account.timezone },
    hierarchy: normalizeAds(account.id, kept),
    daily,
  };
}
```

`fetchMetaAds`: agrega `adsCreatedSince: string | null;` al tipo de `p`, pasa `p.adsCreatedSince` a `fetchAccount`, y cambia el arranque de workers a `ACCOUNT_CONCURRENCY` (ya lo hace por nombre). El resto no cambia.

`lib/sync.ts`, en la llamada `fetchMetaAds({...})`, agrega:

```ts
          adsCreatedSince: locationCreatedAt ? locationCreatedAt.slice(0, 10) : null,
```

- [ ] **Step 6: Tipos y commit**

Run: `npx tsc --noEmit && pnpm verify:meta`
Expected: limpio.

```bash
git add lib/meta-normalize.ts lib/meta-client.ts lib/types.ts lib/sync.ts scripts/verify-meta.ts
git commit -m "feat(meta): solo anuncios creados desde la subcuenta, y las cuentas en paralelo

created_time viaja en MetaAd; los anuncios anteriores al dateAdded se descartan
con sus insights. Cada fila diaria sabe su cuenta. Ocho cuentas y tres meses
concurrentes para caber en los 300 s del refresco.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Índice de Meta, cuenta = desarrollo, y lo aprendido de los leads

**Files:**
- Modify: `lib/meta-attribution.ts` (`MetaIndex`, `buildMetaIndex`, nueva `accountToPipeline`, `assignAdDesarrollos`, `scopeMetaDaily`, nuevos `LearnedIndex` / `buildLearnedIndex` y los recolectores de llaves)
- Test: `scripts/verify-meta-attribution.ts`

**Interfaces:**
- Produces:
  - `MetaIndex` gana `campaignsById: Map<string, MetaCampaign>`, `accountsById: Map<string, MetaAccount>`, `adsByName: Map<string, Set<string>>`, `campaignsByName: Map<string, Set<string>>`. Conserva `byAd`, `dailyByAd`, `byName`.
  - `accountToPipeline(accounts: MetaAccount[], pipelines: Pipeline[] | undefined): Map<string, string>` (id de cuenta → nombre real del pipeline).
  - `adIdCandidates(opp, contactById?)`, `urlCandidates(opp, contactById?)`, `nameCandidates(opp, contactById?, pautaNamesByContact?)`: `string[]` ordenados y sin repetir.
  - `normalizeUrl(u: string): string`.
  - `LearnedIndex = { byUrl: Map<string, { ads: Set<string>; campaigns: Set<string> }>; campaignOfDeletedAd: Map<string, string> }` y `buildLearnedIndex(allOpportunities, index, contactById?)`.
  - `assignAdDesarrollos(meta, index, allOpportunities, pipelines)` conserva su firma; ahora la cuenta manda.

- [ ] **Step 1: Aserciones nuevas en `scripts/verify-meta-attribution.ts`**

En el fixture `meta`, agrega una tercera cuenta y una fila diaria de un anuncio borrado. `accounts` queda:

```ts
  accounts: [
    { id: "act_1", name: "Uno", currency: "MXN", timezone: "America/Mexico_City" },
    { id: "act_2", name: "Dos", currency: "USD", timezone: "America/Mexico_City" },
    { id: "act_3", name: "Palmyra Residencial ", currency: "MXN", timezone: "America/Mexico_City" },
  ],
```

En `campaigns` agrega `{ id: "c4", name: "PALMYRA | MAYO | PERFILES", accountId: "act_3" },`; en `adsets` agrega `{ id: "s4", name: "Set", campaignId: "c4" },`; en `ads` agrega `{ id: "401", name: "anuncio 1", adsetId: "s4" },`. En `daily` agrega dos filas al final:

```ts
    { adId: "401", accountId: "act_3", date: "2026-08-03", spend: 40, impressions: 400, reach: 300, clicks: 4, linkClicks: 4, leadsForm: 1, leadsMsg: 0 },
    // Anuncio BORRADO: reporta gasto pero no está en `ads`.
    { adId: "777", accountId: "act_1", date: "2026-08-04", spend: 70, impressions: 700, reach: 600, clicks: 7, linkClicks: 7, leadsForm: 0, leadsMsg: 1 },
```

Agrega `accountId` a las cinco filas diarias existentes: `"act_1"` en las de `101` y `201`, `"act_2"` en la de `301`.

Agrega al import de `../lib/meta-attribution`: `accountToPipeline, adIdCandidates, urlCandidates, nameCandidates, normalizeUrl, buildLearnedIndex`. Importa `type Contact` de `../lib/types`.

Después del bloque `// --- índice: jerarquía y nombres plegados → campañas` (y sus asserts) agrega:

```ts
  assert.equal(index.campaignsById.get("c4")?.accountId, "act_3");
  assert.equal(index.accountsById.get("act_3")?.currency, "MXN");
  assert.deepEqual([...index.adsByName.get("canadas by el mirador")!].sort(), ["101", "102"]);
  assert.deepEqual([...index.campaignsByName.get("palmyra | mayo | perfiles")!], ["c4"]);
  assert.equal(index.adsByName.has("palmyra | mayo | perfiles"), false, "nombre de campaña no es nombre de anuncio");

  // --- cuenta = desarrollo: el nombre de la cuenta contra los pipelines, agujas largas primero
  const accMap = accountToPipeline(meta.accounts, pipelines);
  assert.equal(accMap.get("act_3"), "Palmyra", "\"Palmyra Residencial \" (con espacio) → pipeline Palmyra");
  assert.equal(accMap.has("act_1"), false, "\"Uno\" no se llama como ningún desarrollo");
  const accented: Pipeline[] = [...pipelines, { id: "p-atr2", name: "Átria", stages: STAGES }];
  assert.equal(
    accountToPipeline([{ id: "act_9", name: "Átria ", currency: "MXN", timezone: "" }], accented).get("act_9"),
    "Átria",
    "acentos y mayúsculas no importan; devuelve el nombre REAL del pipeline"
  );

  // --- llaves de una oportunidad: propias primero, luego del contacto; sin repetir
  const contactById = new Map<string, Contact>([
    ["c-K", {
      id: "c-K", name: "K", email: "", phone: "", tags: [], dateAdded: "2026-08-01T00:00:00.000Z", createdAt: "2026-08-01T00:00:00.000Z",
      customFieldsResolved: { "ID Pauta": "555", "URL Pauta": "https://fb.me/CONTACTO", "Nombre Pauta": "Del contacto" },
      attributions: [{ isLast: true, utmAdId: "666", url: "https://fb.me/ULTIMA", adName: "Ultima attr" }],
    }],
  ]);
  const k = opp({
    id: "K", contactId: "c-K", adId: "111",
    customFieldsResolved: { "ID de Pauta": "222", "URL Pauta": "https://fb.me/OPP/", "Nombre Pauta": "De la opp" },
    attributions: [
      { isFirst: true, utmAdId: "111", url: "https://fb.me/OPP", utmCampaign: "Camp first" },
      { isLast: true, utmAdId: "333", url: "https://www.instagram.com/p/X/?igsh=1", adName: "Ad last" },
    ],
  });
  assert.deepEqual(adIdCandidates(k, contactById), ["111", "222", "555", "333", "666"]);
  assert.deepEqual(urlCandidates(k, contactById), [
    "https://fb.me/OPP", "https://fb.me/CONTACTO", "https://www.instagram.com/p/X", "https://fb.me/ULTIMA",
  ]);
  assert.deepEqual(nameCandidates(k, contactById, new Map([["c-K", ["Pauta obj", "Sin nombre"]]])), [
    "De la opp", "Del contacto", "Camp first", "Ad last", "Ultima attr", "Pauta obj",
  ]);
  assert.equal(normalizeUrl(" https://fb.me/Abc/?x=1#y "), "https://fb.me/Abc");
  assert.deepEqual(adIdCandidates(opp({ id: "nada" })), []);

  // --- lo aprendido de los leads: URL → anuncio/campaña, y la campaña de un anuncio borrado
  const learned = buildLearnedIndex(
    [
      opp({ id: "L1", adId: "101", attributions: [{ isFirst: true, utmAdId: "101", url: "https://fb.me/UNO" }] }),
      opp({ id: "L2", adId: "102", attributions: [{ isFirst: true, utmAdId: "102", url: "https://fb.me/UNO" }] }),
      opp({ id: "L3", adId: "201", attributions: [{ isFirst: true, utmAdId: "201", url: "https://fb.me/DOS" }] }),
      opp({ id: "L4", adId: "777", attributions: [{ isFirst: true, utmAdId: "777", utmCampaignId: "c1", url: "https://fb.me/DEL" }] }),
      opp({ id: "L5", adId: "9999", attributions: [{ isFirst: true, utmAdId: "9999", url: "https://fb.me/NADIE" }] }),
      opp({ id: "L6", adId: "101", attributionMedium: "csv_import", attributions: [{ isFirst: true, utmAdId: "101", url: "https://fb.me/CSV" }] }),
    ],
    index
  );
  assert.deepEqual([...learned.byUrl.get("https://fb.me/UNO")!.ads].sort(), ["101", "102"], "una URL, dos anuncios de la misma campaña");
  assert.deepEqual([...learned.byUrl.get("https://fb.me/UNO")!.campaigns], ["c1"]);
  assert.deepEqual([...learned.byUrl.get("https://fb.me/DOS")!.ads], ["201"]);
  assert.equal(learned.byUrl.has("https://fb.me/NADIE"), false, "un ad id que no está en Meta no enseña nada");
  assert.equal(learned.byUrl.has("https://fb.me/CSV"), false, "una importación no enseña nada");
  assert.deepEqual([...learned.byUrl.get("https://fb.me/DEL")!.ads], ["777"], "el anuncio borrado tiene gasto: sí es nuestro");
  assert.equal(learned.campaignOfDeletedAd.get("777"), "c1", "la campaña del borrado sale del utmCampaignId de su lead");
```

Y en el bloque `// --- desarrollo por moda de leads, por nombre, sin desarrollo, y mixtos`, después de `assert.equal(desarrolloByAd.get("302"), "Atria", …)`, agrega:

```ts
  assert.equal(desarrolloByAd.get("401"), "Palmyra", "la CUENTA manda: act_3 es Palmyra aunque no tenga leads");
  assert.equal(desarrolloByAd.get("777"), NO_DESARROLLO, "un anuncio borrado sin cuenta reconocible: sin desarrollo");
  const canByAccount = assignAdDesarrollos(
    { ...meta, accounts: [{ id: "act_1", name: "Cañadas by El Mirador ", currency: "MXN", timezone: "" }, ...meta.accounts.slice(1)] },
    index, opps, pipelines
  ).byAd;
  assert.equal(canByAccount.get("201"), "Cañadas", "con la cuenta reconocida, ni la moda de leads (Atria) ni el nombre del ad la contradicen");
  assert.equal(canByAccount.get("777"), "Cañadas", "el borrado hereda el desarrollo de la cuenta de su fila diaria");
```

Y en el bloque de `scopeMetaDaily`, cambia la aserción de Palmyra por:

```ts
  assert.deepEqual(scopeMetaDaily(meta, desarrolloByAd, "palmyra", pipelines).map((d) => d.adId), ["401"]);
```

- [ ] **Step 2: Correr y ver que falla**

Run: `pnpm verify:meta-attribution`
Expected: FAIL (`accountToPipeline` no existe).

- [ ] **Step 3: Implementar en `lib/meta-attribution.ts`**

Agrega `Contact` al import de tipos de `./types`. Reemplaza `MetaIndex` y `buildMetaIndex` por:

```ts
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
```

Después de `buildPautaContacts` agrega los recolectores de llaves:

```ts
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
```

Ojo con el orden que la aserción pide: `nameCandidates` recorre attributions **dos veces** (todos los `utmCampaign`, luego todos los `adName`); en el fixture eso da `Camp first, Ad last, Ultima attr`. Y `urlCandidates` pone la `attributionUrl` de la opp después de sus custom fields (`https://fb.me/OPP/` → normalizada coincide con la de la attribution y se deduplica).

Después de esos recolectores agrega lo aprendido:

```ts
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
```

`isImported` ya existe más abajo en el archivo (sección de clasificación); muévela arriba, junto a `normalizeAdId`, para que `buildLearnedIndex` la vea.

Reemplaza la sección `// ── Desarrollo de cada ad ──` completa (comentario, `assignAdDesarrollos` y `scopeMetaDaily`) por:

```ts
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
```

- [ ] **Step 4: Correr hasta que pase esta parte**

Run: `pnpm verify:meta-attribution`
Expected: pasa todo hasta la sección de `classifyLead`, que todavía usa la firma vieja y **sigue pasando** (no se tocó). Si algo de lo nuevo falla, corrígelo antes de seguir. `npx tsc --noEmit` limpio.

- [ ] **Step 5: Commit**

```bash
git add lib/meta-attribution.ts scripts/verify-meta-attribution.ts
git commit -m "feat(meta): la cuenta publicitaria es el desarrollo, y los leads enseñan URL y campaña

accountToPipeline casa el nombre de cada cuenta con un pipeline y manda sobre la
inferencia por leads. buildLearnedIndex saca de las oportunidades el mapa
URL → anuncio/campaña y la campaña de los anuncios ya borrados. Recolectores de
llaves (ad id, URL, nombre) sobre opp + contacto, custom fields + attributions.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: La cadena de cuatro niveles (`classifyLead`)

**Files:**
- Modify: `lib/meta-attribution.ts` (sección `// ── Clasificación de un lead ──`; **eliminar** `buildCostPerStage`, `buildCampaignPerformance`, `CostPerStage`, `CampaignPerformanceRow`, `CostInput`)
- Test: `scripts/verify-meta-attribution.ts`

**Interfaces:**
- Produces:

```ts
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
  contactById?: ReadonlyMap<string, Contact>;
  learned?: LearnedIndex;
}
export function classifyLead(opp: Opportunity, ctx: AttributionContext): LeadAttribution;
```

- [ ] **Step 1: Reescribir la sección de clasificación en `scripts/verify-meta-attribution.ts`**

Cambia el import de `../lib/pauta`: quita `buildPautaNameByContact`; importa `buildPautaNamesByContact` de `../lib/pauta-performance`. Quita `buildCostPerStage`, `buildCampaignPerformance` del import de `../lib/meta-attribution` (los tipos también, si los importabas). **Borra** los bloques `// --- costo por etapa, agosto, GENERAL`, `// --- una sola moneda…`, `// --- sin rango…` y `// --- rendimiento por campaña, agosto` completos (desde `const range = …` hasta el `assert.deepEqual(c3.adIds, ["301"]);`). La Task 5 pone en su lugar `buildPautaInvestment`.

Reemplaza el bloque `// --- clasificación de un lead` (desde `const ctx: AttributionContext = {` hasta la aserción de `csv2`) por:

```ts
  // --- clasificación: cuatro niveles, cada uno solo si el anterior no dio nada
  const ctxContacts = new Map<string, Contact>([
    ["c-U", { id: "c-U", name: "U", email: "", phone: "", tags: [], dateAdded: "2026-08-01T00:00:00.000Z", createdAt: "2026-08-01T00:00:00.000Z",
      customFieldsResolved: { "URL Pauta": "https://fb.me/DOS" } }],
  ]);
  const ctx: AttributionContext = {
    index,
    pautaContacts: buildPautaContacts(pautas),
    pautaNamesByContact: buildPautaNamesByContact(pautas),
    contactById: ctxContacts,
    learned,
  };
  // nivel 1: ad id
  assert.deepEqual(classifyLead(opp({ id: "1", adId: "101" }), ctx), { kind: "ad", adId: "101", campaignId: "c1", via: "adId" });
  assert.deepEqual(
    classifyLead(opp({ id: "1b", customFieldsResolved: { "ID Pauta": "102" } }), ctx),
    { kind: "ad", adId: "102", campaignId: "c1", via: "adId" }, "custom field de la opp"
  );
  assert.deepEqual(
    classifyLead(opp({ id: "1c", attributions: [{ isLast: true, utmAdId: "201" }] }), ctx),
    { kind: "ad", adId: "201", campaignId: "c2", via: "adId" }, "la última attribution también cuenta"
  );
  assert.deepEqual(
    classifyLead(opp({ id: "1d", adId: "777" }), ctx),
    { kind: "ad", adId: "777", campaignId: "c1", via: "adId" }, "anuncio borrado con gasto: es nuestro; su campaña se aprendió"
  );
  assert.deepEqual(
    classifyLead(opp({ id: "1e", adId: "9999", customFieldsResolved: { "ID Pauta": "101" } }), ctx),
    { kind: "ad", adId: "101", campaignId: "c1", via: "adId" }, "el primer id que pega manda, aunque no sea el primero de la lista"
  );
  // nivel 2: utmCampaignId
  assert.deepEqual(
    classifyLead(opp({ id: "2", adId: "9999", attributions: [{ isFirst: true, utmAdId: "9999", utmCampaignId: "c2" }] }), ctx),
    { kind: "campaign", campaignId: "c2", via: "campaignId" }, "ad id de otra cuenta pero campaña conocida → campaña, no unknownAd"
  );
  assert.deepEqual(
    classifyLead(opp({ id: "2b", attributions: [{ isFirst: true, utmCampaignId: "c-nadie" }], source: "Pauta Formulario" }), ctx),
    { kind: "noAdId" }, "campaña desconocida no resuelve"
  );
  // nivel 3: URL aprendida
  assert.deepEqual(
    classifyLead(opp({ id: "3", customFieldsResolved: { "URL Pauta": "https://fb.me/DOS/" } }), ctx),
    { kind: "ad", adId: "201", campaignId: "c2", via: "url" }, "URL de un solo anuncio → anuncio"
  );
  assert.deepEqual(
    classifyLead(opp({ id: "3b", attributionUrl: "https://fb.me/UNO?fbclid=x" }), ctx),
    { kind: "campaign", campaignId: "c1", via: "url" }, "URL de dos anuncios de la misma campaña → campaña"
  );
  assert.deepEqual(
    classifyLead(opp({ id: "3c", contactId: "c-U", source: undefined }), ctx),
    { kind: "ad", adId: "201", campaignId: "c2", via: "url" }, "la URL puede venir del contacto"
  );
  // nivel 4: nombres
  assert.deepEqual(
    classifyLead(opp({ id: "4", customFieldsResolved: { "Nombre Pauta": "PALMYRA | MAYO | PERFILES" } }), ctx),
    { kind: "campaign", campaignId: "c4", via: "name" }, "nombre de UNA campaña de Meta → campaña"
  );
  assert.deepEqual(
    classifyLead(opp({ id: "4b", attributions: [{ isFirst: true, utmCampaign: "IW - Atria - Agosto" }] }), ctx),
    { kind: "campaign", campaignId: "c2", via: "name" }, "utmCampaign de la attribution"
  );
  assert.deepEqual(
    classifyLead(opp({ id: "4c", customFieldsResolved: { Pauta: "Terrenos desde $1.2 M" } }), ctx),
    { kind: "ad", adId: "301", campaignId: "c3", via: "name" }, "nombre de UN anuncio → anuncio"
  );
  assert.deepEqual(classifyLead(opp({ id: "4d", contactId: "c-11", source: undefined }), ctx), { kind: "noAdId" },
    "\"Cañadas by El Mirador\" es el nombre de DOS anuncios (101, 102): ambiguo, no se atribuye");
  assert.deepEqual(classifyLead(opp({ id: "4e", contactId: "c-12" }), ctx), { kind: "noAdId" },
    "\"Atria lofts\" vive en dos campañas: ambiguo");
  assert.deepEqual(classifyLead(opp({ id: "4f", contactId: "c-13" }), ctx), { kind: "noAdId" }, "\"Sin nombre\" no es un nombre");
  // centinelas
  assert.deepEqual(classifyLead(opp({ id: "9", adId: "9999" }), ctx), { kind: "unknownAd", adId: "9999" });
  assert.deepEqual(classifyLead(opp({ id: "8", source: "Pauta Formulario" }), ctx), { kind: "noAdId" });
  assert.deepEqual(classifyLead(opp({ id: "r", source: "Referido" }), ctx), { kind: "notPauta" });
  assert.deepEqual(classifyLead(opp({ id: "csv", source: undefined, attributionMedium: "csv_import", pipelineId: "p-pal" }), ctx), { kind: "notPauta" });
  assert.deepEqual(classifyLead(opp({ id: "csv2", adId: "101", attributionMedium: "csv_import" }), ctx), { kind: "notPauta" }, "csv_import gana incluso con ad id");
  // sin `learned` ni `contactById` la cadena sigue funcionando con lo que la opp trae
  assert.deepEqual(
    classifyLead(opp({ id: "min", adId: "101" }), { index, pautaContacts: ctx.pautaContacts, pautaNamesByContact: ctx.pautaNamesByContact }),
    { kind: "ad", adId: "101", campaignId: "c1", via: "adId" }
  );
```

El bloque `// --- clasificación` debe ir **después** del bloque `// --- lo aprendido de los leads` (usa `learned`). Mueve el bloque de `learned` arriba si hace falta.

- [ ] **Step 2: Correr y ver que falla**

Run: `pnpm verify:meta-attribution`
Expected: FAIL en la primera aserción de `classifyLead` (forma vieja `exact`).

- [ ] **Step 3: Reescribir la clasificación en `lib/meta-attribution.ts`**

Reemplaza la sección `// ── Clasificación de un lead ──` completa (tipos, `isImported` si aún estaba ahí, y `classifyLead`) por:

```ts
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
```

Borra `buildCostPerStage`, `buildCampaignPerformance` y sus tipos (`CostInput`, `CostPerStage`, `CampaignPerformanceRow`) — la sección `// ── Cohorte y etapas ──` conserva `localDay`, el re-export de `reachedStage`/`stageIndexOf`, `inRange` y `ratio` (la Task 5 los usa); borra `currencyOfAd`. Quita del import de `./pauta` lo que ya no se use (`resolveCampaignName`); `SIN_NOMBRE_CAMPAIGN`, `isDePauta` y `HasKey` se quedan.

- [ ] **Step 4: Correr y ver que pasa; tipos**

Run: `pnpm verify:meta-attribution && npx tsc --noEmit`
Expected: `✅ verify:meta-attribution OK`; `tsc` acusará `lib/panel-filters.ts`/`app/page.tsx` **solo si** importaban algo borrado — `buildMetaCampaignByAd` sigue existiendo, así que debe salir limpio. Si `tsc` marca otro consumidor de `buildCostPerStage`, es un archivo huérfano: bórralo del import.

- [ ] **Step 5: Commit**

```bash
git add lib/meta-attribution.ts scripts/verify-meta-attribution.ts
git commit -m "feat(meta): cadena de cuatro niveles para atar un lead a su anuncio o campaña

ad id → utmCampaignId → URL aprendida → nombres; cada nivel solo si el anterior
no dio nada, y resuelve a anuncio o a campaña con la vía registrada.
buildCostPerStage y buildCampaignPerformance se van: buildPautaInvestment los
sustituye en la tarea siguiente.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: `buildPautaInvestment` — la agregación de la tarjeta

**Files:**
- Modify: `lib/meta-attribution.ts` (nueva sección al final)
- Test: `scripts/verify-meta-attribution.ts`

**Interfaces:**
- Consumes: `classifyLead`, `hadCita` (`lib/pauta-performance.ts`), `reachedStage`, `isWonOpp`, `localDay`.
- Produces:

```ts
export interface PautaMetrics {
  spend: number; impressions: number; clicks: number;
  cpm: number | null; ctr: number | null;
  leadsMeta: number; leadsCrm: number; citas: number; visitas: number; ventas: number;
  cpl: number | null; costPerVenta: number | null;
  oppIds: { leads: string[]; citas: string[]; visitas: string[]; ventas: string[] };
}
export interface PautaAdRow { adId: string; name: string; urls: string[]; deleted: boolean; metrics: PautaMetrics }
export interface PautaCampaignRow {
  campaignId: string; name: string; accountId: string; accountName: string; missing: boolean;
  metrics: PautaMetrics; campaignOnlyLeads: number; ads: PautaAdRow[];
}
export interface PautaCell { count: number; oppIds: string[] }
export interface PautaInvestment {
  currency: string; mixedCurrency: boolean;
  kpi: PautaMetrics;
  campaigns: PautaCampaignRow[];
  noAdId: PautaCell; unknownAd: PautaCell; otherAccount: PautaCell; notPauta: number;
  via: Record<AttributionVia, number>;
  unlinkedSpend: number;
}
export interface PautaInvestmentInput {
  opportunities: Opportunity[];                   // la cohorte: ya acotada a pestaña, filtros y fecha
  daily: MetaDailyRow[];                          // ya acotada a la pestaña (scopeMetaDaily), sin fecha
  range: { start: string; end: string } | null;   // YYYY-MM-DD CDMX, para el gasto
  ctx: AttributionContext;
  contactsWithCita: ReadonlySet<string>;
  /** Cuentas de ESTA pestaña; null en GENERAL = todas. */
  accountIds: ReadonlySet<string> | null;
}
export const SIN_CAMPANA = "Sin campaña";
export const ANUNCIO_ELIMINADO = "Anuncio eliminado";
export function buildPautaInvestment(p: PautaInvestmentInput): PautaInvestment;
```

- [ ] **Step 0: Sacar `hadCita` y `buildPautaNamesByContact` de `lib/pauta-performance.ts`**

`lib/pauta-performance.ts` importa `oppAdId` de `./meta-attribution`; si `meta-attribution` importara `hadCita` de vuelta habría un ciclo (en CJS eso llega como `undefined` al cargar). Los dos helpers se mudan a módulos que no importan `meta-attribution`, y `pauta-performance` los re-exporta para que nada más cambie:

1. Mueve `hadCita` (con su `const CITA` y su comentario) a `lib/desarrollo-funnel.ts`, al final de la sección `// ── Etapas ──`. Ese módulo ya importa `isWonOpp` y define `reachedStage`. Exporta la función.
2. Mueve `buildPautaNamesByContact` (con su comentario) a `lib/pauta.ts`, después de `buildPautaNameByContact`. Necesita `import { normalizeDesarrolloName } from "./panel-scope"` (comprueba con `grep -n "^import" lib/panel-scope.ts` que `panel-scope` no importe `pauta`; hoy solo importa tipos).
3. En `lib/pauta-performance.ts` reemplaza las dos definiciones por:

```ts
// Se mudaron para que lib/meta-attribution.ts pueda usarlas sin un ciclo de
// imports (este módulo importa oppAdId de ahí). Re-exportadas por compatibilidad.
export { hadCita } from "./desarrollo-funnel"
export { buildPautaNamesByContact } from "./pauta"
```

y quita los imports que queden sin uso (`isWonOpp`, `normalizeDesarrolloName`, `SIN_NOMBRE_CAMPAIGN` si ya no se usan).

Run: `pnpm verify:pauta-performance && pnpm verify:desarrollo-funnel && pnpm verify:filters && npx tsc --noEmit`
Expected: tres `✅` y tsc limpio.

```bash
git add lib/pauta-performance.ts lib/desarrollo-funnel.ts lib/pauta.ts
git commit -m "refactor: hadCita y buildPautaNamesByContact a módulos sin ciclo con meta-attribution

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 1: Aserciones en `scripts/verify-meta-attribution.ts`**

Agrega `buildPautaInvestment, SIN_CAMPANA, ANUNCIO_ELIMINADO` al import. Donde estaban los bloques de costo borrados en la Task 4 (antes del `console.log` final), agrega:

```ts
  // --- la agregación de la tarjeta, agosto, GENERAL (todas las cuentas)
  const contactsWithCita = new Set<string>(["c-8"]);
  const cohort = [
    opp({ id: "1", adId: "101", attributionUrl: "https://fb.me/UNO" }),                // ad 101, recibido; entró por la URL UNO
    opp({ id: "2", adId: "101", stage: "05. Visita al Desarrollo" }),                  // visita
    opp({ id: "3", adId: "101", stage: "08. Venta", status: "won" }),                  // venta
    opp({ id: "4", adId: "102", stage: "04. Cita Programada", status: "lost" }),       // cita (perdida)
    opp({ id: "5", attributionUrl: "https://fb.me/UNO" }),                             // campaña c1 por URL, sin anuncio
    opp({ id: "6", adId: "201" }),                                                     // ad 201 (c2)
    opp({ id: "7", adId: "777" }),                                                     // anuncio borrado, campaña c1
    opp({ id: "8", source: "Pauta Formulario", contactId: "c-8" }),                    // de pauta sin llave, con cita en el objeto Citas
    opp({ id: "9", adId: "9999" }),                                                    // ad no conectado
    opp({ id: "r", source: "Referido" }),                                              // no es pauta
    opp({ id: "csv", attributionMedium: "csv_import", adId: "101" }),                  // importado
  ];
  const range = { start: "2026-08-01", end: "2026-08-31" };
  const inv = buildPautaInvestment({ opportunities: cohort, daily: meta.daily, range, ctx, contactsWithCita, accountIds: null });
  assert.equal(inv.mixedCurrency, true, "act_2 es USD");
  assert.equal(inv.currency, "");
  // gasto de agosto: 101 (100+100) + 201 (50) + 301 (30) + 401 (40) + 777 (70) = 390; el 999 de septiembre queda fuera
  assert.equal(inv.kpi.spend, 390);
  assert.equal(inv.kpi.impressions, 3900);
  assert.equal(inv.kpi.leadsMeta, 4 + 2 + 1 + 0 + 1 + 1, "form + msg de las filas de agosto");
  assert.equal(inv.kpi.leadsCrm, 7, "1,2,3,4 (101/102) + 5 (c1 por URL) + 6 (201) + 7 (777)");
  assert.equal(inv.kpi.citas, 3, "2 (05), 3 (venta), 4 (04) — la 8 no está atada a nada");
  assert.equal(inv.kpi.visitas, 2, "2 y 3");
  assert.equal(inv.kpi.ventas, 1);
  assert.equal(inv.kpi.cpl, null, "moneda mixta: sin costos consolidados");
  assert.deepEqual(inv.kpi.oppIds.ventas, ["3"]);
  assert.equal(inv.noAdId.count, 1); assert.deepEqual(inv.noAdId.oppIds, ["8"]);
  assert.equal(inv.unknownAd.count, 1); assert.deepEqual(inv.unknownAd.oppIds, ["9"]);
  assert.equal(inv.otherAccount.count, 0, "en GENERAL no hay 'otra cuenta'");
  assert.equal(inv.notPauta, 2);
  assert.deepEqual(inv.via, { adId: 6, campaignId: 0, url: 1, name: 0 });
  assert.equal(inv.unlinkedSpend, 0, "el borrado 777 sí tiene campaña aprendida");

  // filas por gasto desc: c1 (270 = 200 + 70 del borrado), c2 (50), c4 (40), c3 (30)
  assert.deepEqual(inv.campaigns.map((c) => c.campaignId), ["c1", "c2", "c4", "c3"]);
  const rc1 = inv.campaigns[0];
  assert.equal(rc1.name, "IW - Cañadas - Agosto");
  assert.equal(rc1.accountName, "Uno");
  assert.equal(rc1.metrics.spend, 270);
  assert.equal(rc1.metrics.leadsCrm, 6, "1,2,3,4,7 por anuncio + 5 por campaña");
  assert.equal(rc1.campaignOnlyLeads, 1, "la 5");
  assert.equal(rc1.metrics.cpl, 270 / 6, "una campaña vive en UNA cuenta: su costo sí existe aunque el KPI global esté mixto");
  assert.equal(rc1.metrics.costPerVenta, 270);
  assert.equal(rc1.metrics.cpm, (270 / 2700) * 1000);
  assert.deepEqual(rc1.ads.map((a) => a.adId), ["101", "777", "102"], "anuncios por gasto desc; 102 sin gasto al final");
  assert.equal(rc1.ads[0].metrics.leadsCrm, 3);
  assert.deepEqual(rc1.ads[0].urls, ["https://fb.me/UNO"], "URLs con las que entraron los leads de ese anuncio");
  assert.equal(rc1.ads[1].deleted, true);
  assert.equal(rc1.ads[1].name, ANUNCIO_ELIMINADO);
  assert.equal(rc1.ads[1].metrics.leadsCrm, 1);
  assert.equal(rc1.ads[2].metrics.spend, 0);
  assert.equal(rc1.ads[2].metrics.leadsCrm, 1, "la 4");
  assert.equal(rc1.ads[2].metrics.cpl, null, "sin gasto no hay CPL, ni cero");
  const rc3 = inv.campaigns[3];
  assert.equal(rc3.metrics.leadsCrm, 0);
  assert.equal(rc3.metrics.cpl, null, "gasto sin leads: null, la UI lo pinta en rojizo");
  assert.equal(inv.campaigns.some((c) => c.missing), false);

  // --- una sola moneda y una sola cuenta (pestaña Cañadas = act_1): costos sí, y "otra cuenta" al pie
  const invCan = buildPautaInvestment({
    opportunities: cohort,
    daily: meta.daily.filter((d) => d.accountId === "act_1"),
    range, ctx, contactsWithCita,
    accountIds: new Set(["act_1"]),
  });
  assert.equal(invCan.mixedCurrency, false);
  assert.equal(invCan.currency, "MXN");
  assert.equal(invCan.kpi.spend, 320, "101 + 201 + 777");
  assert.equal(invCan.kpi.leadsCrm, 7, "todas son de act_1 (c1, c2)");
  assert.equal(invCan.kpi.cpl, 320 / 7);
  assert.equal(invCan.kpi.costPerVenta, 320);
  assert.equal(invCan.otherAccount.count, 0);
  const invPal = buildPautaInvestment({
    opportunities: cohort,
    daily: meta.daily.filter((d) => d.accountId === "act_3"),
    range, ctx, contactsWithCita,
    accountIds: new Set(["act_3"]),
  });
  assert.equal(invPal.kpi.spend, 40);
  assert.equal(invPal.kpi.leadsCrm, 0, "ningún lead de la cohorte es de un anuncio de act_3");
  assert.equal(invPal.otherAccount.count, 7, "los 7 atados a c1/c2 son de otra cuenta");
  assert.deepEqual(invPal.campaigns.map((c) => c.campaignId), ["c4"]);
  assert.equal(invPal.kpi.cpl, null);

  // --- un anuncio borrado SIN campaña aprendida cae en "Sin campaña", al final y marcado
  const orphanDaily = [...meta.daily, { adId: "888", accountId: "act_1", date: "2026-08-05", spend: 5, impressions: 50, reach: 50, clicks: 1, linkClicks: 1, leadsForm: 0, leadsMsg: 0 }];
  const invOrphan = buildPautaInvestment({ opportunities: [], daily: orphanDaily, range, ctx, contactsWithCita, accountIds: null });
  const last = invOrphan.campaigns[invOrphan.campaigns.length - 1];
  assert.equal(last.campaignId, "");
  assert.equal(last.name, SIN_CAMPANA);
  assert.equal(last.missing, true);
  assert.equal(last.metrics.spend, 5);
  assert.equal(invOrphan.unlinkedSpend, 5);
  assert.deepEqual(last.ads.map((a) => a.adId), ["888"]);

  // --- sin rango = toda la ventana
  const invAll = buildPautaInvestment({ opportunities: cohort, daily: meta.daily, range: null, ctx, contactsWithCita, accountIds: null });
  assert.equal(invAll.kpi.spend, 390 + 999);
```

- [ ] **Step 2: Correr y ver que falla**

Run: `pnpm verify:meta-attribution`
Expected: FAIL (`buildPautaInvestment` no existe).

- [ ] **Step 3: Implementar al final de `lib/meta-attribution.ts`**

Cambia el import de `./desarrollo-funnel` a `import { hadCita, reachedStage, stageIndexOf } from "./desarrollo-funnel";` (Step 0 la puso ahí). Agrega al final:

```ts
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

const CITA = { key: "cita", minIndex: 4 };
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
      r.metrics.spend += ad.metrics.spend;
      r.metrics.impressions += ad.metrics.impressions;
      r.metrics.clicks += ad.metrics.clicks;
      r.metrics.leadsMeta += ad.metrics.leadsMeta;
      r.metrics.leadsCrm += ad.metrics.leadsCrm;
      r.metrics.citas += ad.metrics.citas;
      r.metrics.visitas += ad.metrics.visitas;
      r.metrics.ventas += ad.metrics.ventas;
      for (const k of ["leads", "citas", "visitas", "ventas"] as const) r.metrics.oppIds[k].push(...ad.metrics.oppIds[k]);
    }
    r.ads.sort((x, y) => y.metrics.spend - x.metrics.spend || y.metrics.leadsCrm - x.metrics.leadsCrm || x.adId.localeCompare(y.adId));
    finishMetrics(r.metrics, true);
    kpi.spend += r.metrics.spend;
    kpi.impressions += r.metrics.impressions;
    kpi.clicks += r.metrics.clicks;
    kpi.leadsMeta += r.metrics.leadsMeta;
    kpi.leadsCrm += r.metrics.leadsCrm;
    kpi.citas += r.metrics.citas;
    kpi.visitas += r.metrics.visitas;
    kpi.ventas += r.metrics.ventas;
    for (const k of ["leads", "citas", "visitas", "ventas"] as const) kpi.oppIds[k].push(...r.metrics.oppIds[k]);
  }
  finishMetrics(kpi, !mixedCurrency);

  const campaigns = [...rows.values()].sort((x, y) => {
    if (x.missing !== y.missing) return x.missing ? 1 : -1;
    return y.metrics.spend - x.metrics.spend || y.metrics.leadsCrm - x.metrics.leadsCrm || x.name.localeCompare(y.name, "es");
  });
  const unlinkedSpend = rows.get("")?.metrics.spend ?? 0;

  return { currency, mixedCurrency, kpi, campaigns, noAdId, unknownAd, otherAccount, notPauta, via, unlinkedSpend };
}
```

Nota sobre el fixture: la 4 (`adId: "102"`) tiene `status: "lost"` en etapa 04 → `hadCita` true por etapa, `reachedStage(VISITA)` false. La 3 está en "08. Venta" con `status: "won"` → visita y venta. La 1 trae `attributionUrl` para que el anuncio 101 muestre esa URL en su fila.

- [ ] **Step 4: Correr y ver que pasa**

Run: `pnpm verify:meta-attribution && npx tsc --noEmit`
Expected: `✅ verify:meta-attribution OK`, tsc limpio. Si una cifra difiere, **revisa primero el fixture** (las filas diarias con `accountId`, la 401 y la 777 agregadas en Task 3) antes de tocar la agregación.

- [ ] **Step 5: Commit**

```bash
git add lib/meta-attribution.ts scripts/verify-meta-attribution.ts
git commit -m "feat(meta): buildPautaInvestment, la agregación de la tarjeta

KPI, campañas → anuncios por gasto, residuos del pie y la vía de cada lead, en
una sola pasada. Anuncios borrados con gasto se quedan como \"Anuncio eliminado\";
sin campaña aprendida caen en \"Sin campaña\". Costos null con moneda mixta.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: El filtro global "Campaña" usa la cadena completa

**Files:**
- Modify: `lib/panel-filters.ts:133-176` (`CampanaContext`, `resolveCampanas`)
- Modify: `app/page.tsx:214-223` (`campanaCtx`)
- Test: `scripts/verify-panel-filters.ts`

**Interfaces:**
- Produces: `CampanaContext.metaCampaignByOpp?: ReadonlyMap<string, string> | null` (oppId → nombre de campaña de Meta). `metaCampaignByAd` se conserva como respaldo.
- Produces (en `lib/meta-attribution.ts`): `buildMetaCampaignByOpp(opps: Opportunity[], ctx: AttributionContext): Map<string, string>`.

- [ ] **Step 1: Aserción en `scripts/verify-panel-filters.ts`**

Localiza `const metaCampaignByAd = new Map([["111", "Meta Campaña 1"]]);` (~línea 352) y el `ctx` de la línea siguiente. Justo después de la aserción `resolveCampanas(importado, ctx)` (la que dice "un importado por CSV no toma la campaña de Meta") agrega, usando las variables `soloCampo` e `importado` que ese bloque ya define:

```ts
    // Con la cadena completa (metaCampaignByOpp, armado en page.tsx con classifyLead),
    // una oportunidad SIN ad id también lista bajo el nombre de Meta; un importado no.
    const ctxByOpp = { ...ctx, metaCampaignByOpp: new Map([[soloCampo.id, "Meta Campaña 2"], [importado.id, "Meta Campaña 1"]]) };
    assert.deepEqual(resolveCampanas(soloCampo, ctxByOpp), { names: ["Meta Campaña 2"], source: "meta" }, "por URL o nombre también se llega a Meta");
    assert.deepEqual(resolveCampanas(soloCampo, ctx), { names: ["Campo X"], source: "campo" }, "sin el mapa por opp, cae como antes");
    assert.deepEqual(resolveCampanas(importado, ctxByOpp), { names: [NO_PAUTA], source: "none" }, "un importado tampoco toma el mapa por opp");
```

- [ ] **Step 2: Correr y ver que falla**

Run: `pnpm verify:filters`
Expected: FAIL (`metaCampaignByOpp` ignorado → `source: "campo"`).

- [ ] **Step 3: Implementar**

`lib/panel-filters.ts`, en `CampanaContext` agrega:

```ts
  /**
   * oppId → campaña de Meta por la cadena completa (`buildMetaCampaignByOpp`):
   * ad id, utmCampaignId, URL aprendida o nombre. Manda sobre `metaCampaignByAd`,
   * que queda como respaldo por ad id.
   */
  metaCampaignByOpp?: ReadonlyMap<string, string> | null
```

En `resolveCampanas`, antes del `if (ctx.metaCampaignByAd && …)` existente:

```ts
  if (!isImported(opp)) {
    const byOpp = ctx.metaCampaignByOpp?.get(opp.id)
    if (byOpp) return { names: [byOpp], source: "meta" }
  }
```

`lib/meta-attribution.ts`, junto a `buildMetaCampaignByAd`:

```ts
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
```

`app/page.tsx` se cablea en la Task 7 (el contexto de Meta se arma ahí); por ahora `campanaCtx` no cambia.

- [ ] **Step 4: Correr y commit**

Run: `pnpm verify:filters && npx tsc --noEmit`
Expected: `✅` y limpio.

```bash
git add lib/panel-filters.ts lib/meta-attribution.ts scripts/verify-panel-filters.ts
git commit -m "feat(filtros): el nivel Meta del filtro Campaña usa la cadena completa

metaCampaignByOpp (classifyLead sobre el set sin filtrar) manda; el mapa por ad
id queda como respaldo.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: El contexto de Meta se arma una vez en `page.tsx` y baja al panel

**Files:**
- Modify: `lib/meta-attribution.ts` (nuevo `MetaPanelContext` + `buildMetaPanelContext`)
- Modify: `app/page.tsx` (~214-223 `campanaCtx`; ~693-722 `<PanelDashboard …>`)
- Modify: `components/dashboard/panel-dashboard.tsx` (props)
- Test: `scripts/verify-meta-attribution.ts` (una aserción de `buildMetaPanelContext`)

**Interfaces:**
- Produces:

```ts
export interface MetaPanelContext {
  meta: MetaAdsData;
  index: MetaIndex;
  ctx: AttributionContext;
  desarrolloByAd: Map<string, string>;
  mixedAds: string[];
  accountToPipeline: Map<string, string>;
}
export function buildMetaPanelContext(p: {
  meta: MetaAdsData; allOpportunities: Opportunity[]; contacts: Contact[]; pautas: Pauta[]; pipelines: Pipeline[] | undefined;
}): MetaPanelContext;
```
- `PanelDashboardProps` gana `metaPanel?: MetaPanelContext | null`, `metaWarning?: SyncWarning | null`, `locationCreatedAt?: string`.

- [ ] **Step 1: Aserción**

En `scripts/verify-meta-attribution.ts`, agrega `buildMetaPanelContext` al import y, antes del `console.log` final:

```ts
  // --- el contexto que page.tsx arma una vez y baja a las siete pestañas
  const panelCtx = buildMetaPanelContext({ meta, allOpportunities: opps, contacts: [], pautas, pipelines });
  assert.equal(panelCtx.index.byAd.size, index.byAd.size);
  assert.equal(panelCtx.desarrolloByAd.get("401"), "Palmyra");
  assert.equal(panelCtx.accountToPipeline.get("act_3"), "Palmyra");
  assert.equal(panelCtx.ctx.learned?.byUrl.size, 0, "opps sin URL no enseñan nada");
  assert.deepEqual(classifyLead(opp({ id: "z", adId: "101" }), panelCtx.ctx), { kind: "ad", adId: "101", campaignId: "c1", via: "adId" });
```

- [ ] **Step 2: Correr y ver que falla; implementar**

Run: `pnpm verify:meta-attribution` → FAIL. Luego, al final de `lib/meta-attribution.ts`:

```ts
// ── El contexto por payload ─────────────────────────────────────────────────
// Se arma UNA vez en app/page.tsx sobre el set sin filtrar y baja como prop:
// siete pestañas no deben reconstruir el índice cada una.
export interface MetaPanelContext {
  meta: MetaAdsData;
  index: MetaIndex;
  ctx: AttributionContext;
  desarrolloByAd: Map<string, string>;
  mixedAds: string[];
  accountToPipeline: Map<string, string>;
}

export function buildMetaPanelContext(p: {
  meta: MetaAdsData;
  allOpportunities: Opportunity[];
  contacts: Contact[];
  pautas: Pauta[];
  pipelines: Pipeline[] | undefined;
}): MetaPanelContext {
  const index = buildMetaIndex(p.meta);
  const contactById = new Map(p.contacts.map((c) => [c.id, c]));
  const learned = buildLearnedIndex(p.allOpportunities, index, contactById);
  const ctx: AttributionContext = {
    index,
    pautaContacts: buildPautaContacts(p.pautas),
    pautaNamesByContact: buildPautaNamesByContact(p.pautas),
    contactById,
    learned,
  };
  const { byAd, mixed } = assignAdDesarrollos(p.meta, index, p.allOpportunities, p.pipelines);
  return { meta: p.meta, index, ctx, desarrolloByAd: byAd, mixedAds: mixed, accountToPipeline: accountToPipeline(p.meta.accounts, p.pipelines) };
}
```

Agrega `buildPautaNamesByContact` al import de `./pauta` (la Task 5 Step 0 la puso ahí).

Run: `pnpm verify:meta-attribution` → `✅`.

- [ ] **Step 3: `app/page.tsx`**

Agrega a los imports de `@/lib/meta-attribution`: `buildMetaPanelContext, buildMetaCampaignByOpp`. Reemplaza el `useMemo` de `campanaCtx` por:

```ts
  // El contexto de Meta (índice, lo aprendido de los leads, cuenta = desarrollo)
  // se arma UNA vez sobre el set sin filtrar y baja a las siete pestañas.
  const metaPanel = useMemo(
    () =>
      data?.metaAds
        ? buildMetaPanelContext({
            meta: data.metaAds,
            allOpportunities: data.opportunities,
            contacts: data.contacts,
            pautas: data.pautas,
            pipelines: data.pipelines,
          })
        : null,
    [data?.metaAds, data?.opportunities, data?.contacts, data?.pautas, data?.pipelines]
  )
  // La campaña sale de Meta (por la cadena completa, si está conectado), luego
  // del objeto Pauta del contacto y luego del campo "Nombre Pauta" — ver
  // resolveCampanas. Sin acotar a desarrollo ni a fecha: el filtro es global.
  const campanaCtx = useMemo(
    () => ({
      pautaNamesByContact: buildPautaNamesByContact(data?.pautas ?? []),
      metaCampaignByAd: buildMetaCampaignByAd(data?.metaAds),
      metaCampaignByOpp: metaPanel ? buildMetaCampaignByOpp(data?.opportunities ?? [], metaPanel.ctx) : null,
    }),
    [data?.pautas, data?.metaAds, data?.opportunities, metaPanel]
  )
  const metaWarning = useMemo(
    () => data?.warnings?.find((w) => w.key === "meta") ?? null,
    [data?.warnings]
  )
```

En `<PanelDashboard …>` agrega tres props:

```tsx
            metaPanel={metaPanel}
            metaWarning={metaWarning}
            locationCreatedAt={data?.meta?.locationCreatedAt}
```

- [ ] **Step 4: `panel-dashboard.tsx`**

Importa `type { MetaPanelContext } from "@/lib/meta-attribution"` y `SyncWarning` de `@/lib/types`. En `PanelDashboardProps` agrega:

```ts
  /** Índice y contexto de Meta Ads, armados una vez en page.tsx. null = sin conexión. */
  metaPanel?: MetaPanelContext | null
  /** El warning `meta` del último sync, si lo hubo (parcial, revocado, caído). */
  metaWarning?: SyncWarning | null
  /** ISO de creación de la subcuenta; ancla la ventana de gasto. */
  locationCreatedAt?: string
```

Desestructura `metaPanel = null, metaWarning = null, locationCreatedAt` en la función. La Task 8 monta la tarjeta; por ahora las props solo existen.

- [ ] **Step 5: Tipos y commit**

Run: `npx tsc --noEmit && pnpm verify:meta-attribution && pnpm verify:filters`

```bash
git add lib/meta-attribution.ts app/page.tsx components/dashboard/panel-dashboard.tsx scripts/verify-meta-attribution.ts
git commit -m "feat(meta): el contexto de Meta se arma una vez en page.tsx y baja al panel

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: La tarjeta "Inversión y rendimiento de pauta"

**Files:**
- Create: `components/dashboard/pauta-investment-card.tsx` (contenedor: estados, memo, drill, pie)
- Create: `components/dashboard/pauta-investment-kpis.tsx` (fila KPI + línea de impresiones)
- Create: `components/dashboard/pauta-investment-table.tsx` (tabla campaña → anuncio)
- Modify: `components/dashboard/panel-dashboard.tsx` (montar en lugar de `PautaPerformanceTable`)

**Interfaces:**
- Consumes: `buildPautaInvestment`, `scopeMetaDaily`, `MetaPanelContext`, `localDay`, `PANEL_SCOPES`, `resolvePipelineId`, `scopeOpportunities`, `ChartDrillDrawer`, `DashboardCard`/`ChartCardHeader`/`ChartCardContent`/`ChartEmpty`/`ScopePill`/`MISSING_TEXT`.
- Produces: `PautaInvestmentCard` (props abajo), `PautaInvestmentKpis({ inv, onDrill })`, `PautaInvestmentTable({ inv, onDrill })`.

No hay script de aserción para componentes; se verifica con `tsc` y en el navegador (Task 10).

- [ ] **Step 1: `pauta-investment-kpis.tsx`**

```tsx
"use client"

import type { ReactNode } from "react"
import { cn } from "@/lib/utils"
import type { PautaInvestment, PautaMetrics } from "@/lib/meta-attribution"

export type PautaDrillKey = keyof PautaMetrics["oppIds"]

/** Formateadores compartidos por la fila KPI y la tabla. */
export function makeFormatters(currency: string) {
  const money = currency
    ? new Intl.NumberFormat("es-MX", { style: "currency", currency, maximumFractionDigits: 2 })
    : null
  return {
    n: (v: number) => v.toLocaleString("es-MX"),
    money: (v: number | null) => (v === null ? "—" : money ? money.format(v) : v.toLocaleString("es-MX", { maximumFractionDigits: 2 })),
    pct: (v: number | null, digits = 1) => (v === null ? "—" : `${(v * 100).toLocaleString("es-MX", { maximumFractionDigits: digits })}%`),
  }
}

function Tile({
  label,
  value,
  sub,
  highlight,
  onClick,
}: {
  label: string
  value: ReactNode
  sub?: ReactNode
  highlight?: boolean
  onClick?: () => void
}) {
  const Tag = onClick ? "button" : "div"
  return (
    <Tag
      type={onClick ? "button" : undefined}
      onClick={onClick}
      className={cn(
        "flex min-w-0 flex-col gap-1 rounded-lg border px-3 py-2.5 text-left",
        highlight ? "border-primary/40 bg-primary/5" : "border-border bg-muted/20",
        onClick && "cursor-pointer transition-colors hover:bg-muted/50"
      )}
    >
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className={cn("truncate text-lg font-semibold tabular-nums leading-tight", highlight && "text-primary")}>{value}</span>
      {sub !== undefined && <span className="text-[11px] leading-snug text-muted-foreground">{sub}</span>}
    </Tag>
  )
}

export function PautaInvestmentKpis({
  inv,
  onDrill,
}: {
  inv: PautaInvestment
  onDrill: (key: PautaDrillKey, title: string) => void
}) {
  const f = makeFormatters(inv.currency)
  const k = inv.kpi
  const share = (v: number) => (k.leadsCrm > 0 ? f.pct(v / k.leadsCrm, 1) : null)
  const diff = k.leadsMeta - k.leadsCrm
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-7">
        <Tile label="Gasto" value={f.money(k.spend)} sub={inv.mixedCurrency ? "monedas mixtas" : undefined} />
        <Tile
          label="Leads CRM"
          value={f.n(k.leadsCrm)}
          sub={k.leadsMeta > 0 ? `Meta reportó ${f.n(k.leadsMeta)}${diff > 0 ? ` · ${f.n(diff)} no llegaron` : ""}` : undefined}
          onClick={k.leadsCrm > 0 ? () => onDrill("leads", "Leads CRM atribuidos a pauta") : undefined}
        />
        <Tile label="CPL" value={f.money(k.cpl)} sub="por lead del CRM" highlight />
        <Tile label="Citas" value={f.n(k.citas)} sub={share(k.citas) ? `${share(k.citas)} de los leads` : undefined}
          onClick={k.citas > 0 ? () => onDrill("citas", "Citas de leads de pauta") : undefined} />
        <Tile label="Visitas" value={f.n(k.visitas)} sub={share(k.visitas) ? `${share(k.visitas)} de los leads` : undefined}
          onClick={k.visitas > 0 ? () => onDrill("visitas", "Visitas de leads de pauta") : undefined} />
        <Tile label="Ventas" value={f.n(k.ventas)} sub={share(k.ventas) ? `${share(k.ventas)} de los leads` : undefined}
          onClick={k.ventas > 0 ? () => onDrill("ventas", "Ventas de leads de pauta") : undefined} />
        <Tile label="Costo por venta" value={f.money(k.costPerVenta)} sub="gasto ÷ ventas" />
      </div>
      <p className="text-[11px] text-muted-foreground">
        Impresiones {f.n(k.impressions)} · Clics {f.n(k.clicks)} · CPM {f.money(k.cpm)} · CTR {f.pct(k.ctr, 2)}
      </p>
    </div>
  )
}
```

- [ ] **Step 2: `pauta-investment-table.tsx`**

```tsx
"use client"

import { useMemo, useState } from "react"
import { ChevronDown, ChevronRight, Copy, ExternalLink, Search } from "lucide-react"
import { cn } from "@/lib/utils"
import type { PautaAdRow, PautaCampaignRow, PautaInvestment, PautaMetrics } from "@/lib/meta-attribution"
import { MISSING_TEXT } from "./dashboard-ui"
import { makeFormatters, type PautaDrillKey } from "./pauta-investment-kpis"

/** Campañas visibles con la tabla colapsada, por gasto. */
const TOP_ROWS = 15

const COLUMNS: { key: keyof PautaMetrics; label: string; kind: "money" | "int" | "pct"; drill?: PautaDrillKey; muted?: boolean }[] = [
  { key: "spend", label: "Gasto", kind: "money" },
  { key: "impressions", label: "Impr.", kind: "int", muted: true },
  { key: "clicks", label: "Clics", kind: "int", muted: true },
  { key: "cpm", label: "CPM", kind: "money", muted: true },
  { key: "ctr", label: "CTR", kind: "pct", muted: true },
  { key: "leadsMeta", label: "Leads Meta", kind: "int", muted: true },
  { key: "leadsCrm", label: "Leads CRM", kind: "int", drill: "leads" },
  { key: "citas", label: "Citas", kind: "int", drill: "citas" },
  { key: "visitas", label: "Visitas", kind: "int", drill: "visitas" },
  { key: "ventas", label: "Ventas", kind: "int", drill: "ventas" },
  { key: "cpl", label: "CPL", kind: "money" },
]

function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
}

function hostOf(u: string): string {
  try {
    const url = new URL(u)
    return `${url.host.replace(/^www\./, "")}${url.pathname}`.replace(/\/$/, "")
  } catch {
    return u
  }
}

function CopyId({ id }: { id: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      title="Copiar id"
      onClick={(e) => {
        e.stopPropagation()
        void navigator.clipboard?.writeText(id).then(() => {
          setDone(true)
          setTimeout(() => setDone(false), 1200)
        })
      }}
      className="ml-1 inline-flex text-muted-foreground hover:text-foreground"
    >
      <Copy className={cn("h-3 w-3", done && "text-primary")} aria-hidden />
    </button>
  )
}

function UrlCell({ urls }: { urls: string[] }) {
  if (urls.length === 0) return null
  const [first, ...rest] = urls
  return (
    <span className="inline-flex max-w-[16rem] items-center gap-1 font-mono text-[10px] text-muted-foreground" title={urls.join("\n")}>
      <span className="truncate">{hostOf(first)}</span>
      {rest.length > 0 && <span className="shrink-0">+{rest.length}</span>}
      <a href={first} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="shrink-0 hover:text-foreground" title="Abrir">
        <ExternalLink className="h-3 w-3" aria-hidden />
      </a>
    </span>
  )
}

export function PautaInvestmentTable({
  inv,
  onDrill,
}: {
  inv: PautaInvestment
  onDrill: (key: PautaDrillKey, title: string, m: PautaMetrics) => void
}) {
  const f = makeFormatters(inv.currency)
  const [query, setQuery] = useState("")
  const [expanded, setExpanded] = useState(false)
  const [open, setOpen] = useState<Set<string>>(() => new Set())
  const [allOpen, setAllOpen] = useState(false)

  const filtered = useMemo(() => {
    const q = fold(query.trim())
    return q ? inv.campaigns.filter((c) => fold(c.name).includes(q) || fold(c.accountName).includes(q)) : inv.campaigns
  }, [inv.campaigns, query])
  const visible = expanded || query ? filtered : filtered.slice(0, TOP_ROWS)
  const hidden = filtered.length - visible.length
  const maxSpend = Math.max(0, ...inv.campaigns.map((c) => c.metrics.spend))

  const isOpen = (id: string) => allOpen || open.has(id)
  const toggle = (id: string) =>
    setOpen((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  const cell = (m: PautaMetrics, col: (typeof COLUMNS)[number], title: string, style?: CSSProperties) => {
    const v = m[col.key] as number | null
    const text = col.kind === "money" ? f.money(v) : col.kind === "pct" ? f.pct(v, 2) : f.n(v ?? 0)
    const count = col.drill ? m.oppIds[col.drill].length : 0
    const clickable = !!col.drill && count > 0
    const missingCost = col.key === "cpl" && m.spend > 0 && m.leadsCrm === 0
    return (
      <td
        key={col.key}
        style={style}
        onClick={clickable ? () => onDrill(col.drill!, title, m) : undefined}
        className={cn(
          "border-b border-border px-3 py-1.5",
          col.muted && "text-muted-foreground",
          clickable && "cursor-pointer hover:bg-muted/50",
          missingCost && cn("italic", MISSING_TEXT)
        )}
        title={missingCost ? "Gasto sin un solo lead en el CRM" : undefined}
      >
        {col.kind === "int" && v === 0 ? <span className="text-muted-foreground">–</span> : text}
      </td>
    )
  }

  const spendShade = (spend: number) =>
    maxSpend > 0 ? { backgroundColor: `color-mix(in oklab, var(--primary) ${Math.round((spend / maxSpend) * 22)}%, transparent)` } : undefined

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar campaña…"
            className="h-8 w-56 rounded-md border border-border bg-background pl-7 pr-2 text-xs outline-none focus:border-primary/50"
          />
        </label>
        <button
          type="button"
          onClick={() => setAllOpen((v) => !v)}
          aria-pressed={allOpen}
          className="rounded-md border border-border px-2 py-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
        >
          {allOpen ? "Contraer anuncios" : "Expandir anuncios"}
        </button>
        <span className="ml-auto text-[11px] text-muted-foreground">
          {filtered.length === inv.campaigns.length ? `${f.n(inv.campaigns.length)} campañas` : `${f.n(filtered.length)} de ${f.n(inv.campaigns.length)} campañas`}
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-max min-w-full border-separate border-spacing-0 text-right text-xs tabular-nums">
          <thead>
            <tr>
              <th className="sticky left-0 z-20 min-w-[18rem] border-b border-r border-border bg-card px-3 py-2 text-left font-semibold">
                Campaña / anuncio
              </th>
              {COLUMNS.map((c) => (
                <th key={c.key} className={cn("min-w-[5.5rem] border-b border-border px-3 py-2", c.muted ? "font-medium text-muted-foreground" : "font-semibold")}>
                  {c.label}{c.key === "spend" ? " ↓" : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((c: PautaCampaignRow) => (
              <CampaignRows key={c.campaignId || "__sin"} c={c} open={isOpen(c.campaignId)} onToggle={() => toggle(c.campaignId)} cell={cell} shade={spendShade} />
            ))}
          </tbody>
        </table>
      </div>

      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="w-full rounded-md px-2 py-1.5 text-center text-[11px] font-medium text-primary transition-colors hover:bg-muted/50"
        >
          Ver {f.n(hidden)} campañas más →
        </button>
      )}
      {expanded && !query && inv.campaigns.length > TOP_ROWS && (
        <button type="button" onClick={() => setExpanded(false)} className="w-full rounded-md px-2 py-1.5 text-center text-[11px] font-medium text-primary hover:bg-muted/50">
          Ver menos
        </button>
      )}
    </div>
  )
}

function CampaignRows({
  c,
  open,
  onToggle,
  cell,
  shade,
}: {
  c: PautaCampaignRow
  open: boolean
  onToggle: () => void
  cell: (m: PautaMetrics, col: (typeof COLUMNS)[number], title: string, style?: CSSProperties) => ReactNode
  shade: (spend: number) => CSSProperties | undefined
}) {
  const Chevron = open ? ChevronDown : ChevronRight
  const hasChildren = c.ads.length > 0 || c.campaignOnlyLeads > 0
  return (
    <>
      <tr className="font-medium">
        <th
          scope="row"
          onClick={hasChildren ? onToggle : undefined}
          className={cn(
            "sticky left-0 z-10 max-w-[26rem] border-b border-r border-border bg-card px-3 py-2 text-left",
            hasChildren && "cursor-pointer select-none hover:bg-muted/50"
          )}
          title={c.accountName ? `${c.name} · ${c.accountName}` : c.name}
        >
          <span className="inline-flex max-w-full items-center gap-1.5">
            {hasChildren ? <Chevron className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden /> : <span className="w-3.5" />}
            <span className={cn("truncate", c.missing && cn("italic", MISSING_TEXT))}>{c.name}</span>
          </span>
        </th>
        {/* La columna Gasto lleva sombreado normalizado por columna, como en advisor-stage-table. */}
        {COLUMNS.map((col) => cell(c.metrics, col, c.name, col.key === "spend" ? shade(c.metrics.spend) : undefined))}
      </tr>
      {open &&
        c.ads.map((a: PautaAdRow) => (
          <tr key={a.adId} className="text-muted-foreground">
            <td className="sticky left-0 z-10 border-b border-r border-border bg-card py-1.5 pl-8 pr-3 text-left">
              <span className="inline-flex max-w-full items-center gap-2">
                <span className={cn("font-mono text-[11px]", a.deleted && cn("italic", MISSING_TEXT))}>
                  {a.deleted ? a.name : a.adId}
                </span>
                {!a.deleted && <CopyId id={a.adId} />}
                {a.deleted && <span className="font-mono text-[10px]">{a.adId}</span>}
                {!a.deleted && a.name && <span className="truncate text-[11px]" title={a.name}>{a.name}</span>}
                <UrlCell urls={a.urls} />
              </span>
            </td>
            {COLUMNS.map((col) => cell(a.metrics, col, `${c.name} · ${a.deleted ? a.name : a.adId}`))}
          </tr>
        ))}
      {open && c.campaignOnlyLeads > 0 && (
        <tr className="text-muted-foreground">
          <td className="sticky left-0 z-10 border-b border-r border-border bg-card py-1.5 pl-8 pr-3 text-left italic">
            Sin anuncio identificado · {c.campaignOnlyLeads.toLocaleString("es-MX")} {c.campaignOnlyLeads === 1 ? "lead" : "leads"}
          </td>
          {COLUMNS.map((col) => (
            <td key={col.key} className="border-b border-border px-3 py-1.5">
              <span className="text-muted-foreground">–</span>
            </td>
          ))}
        </tr>
      )}
    </>
  )
}
```

El archivo importa `type { CSSProperties, ReactNode }` de `react` (agrégalo al `import { useMemo, useState } from "react"` como `import { useMemo, useState, type CSSProperties, type ReactNode } from "react"`). `cell()` devuelve el `<td>` completo, con el `style` de sombreado cuando la columna es Gasto; nunca lo envuelvas en otro `<td>`.

- [ ] **Step 3: `pauta-investment-card.tsx`**

```tsx
"use client"

import { useMemo, useState } from "react"
import { Coins } from "lucide-react"
import type {
  Appointment,
  Call,
  Contact,
  Message,
  Opportunity,
  Pauta,
  Pipeline,
  SyncWarning,
  Task,
} from "@/lib/types"
import type { ResolvedDateRange } from "@/lib/date-range"
import {
  buildPautaInvestment,
  localDay,
  scopeMetaDaily,
  type MetaPanelContext,
  type PautaMetrics,
} from "@/lib/meta-attribution"
import { PANEL_SCOPES, resolvePipelineId, scopeOpportunities, type PanelId } from "@/lib/panel-scope"
import { cn } from "@/lib/utils"
import { ChartCardContent, ChartCardHeader, ChartEmpty, DashboardCard, MISSING_TEXT, ScopePill } from "./dashboard-ui"
import { ChartDrillDrawer, DRILL_CLOSED, type DrillState } from "./chart-drill-drawer"
import { PautaInvestmentKpis, type PautaDrillKey } from "./pauta-investment-kpis"
import { PautaInvestmentTable } from "./pauta-investment-table"

const n = (v: number) => v.toLocaleString("es-MX")

export interface PautaInvestmentCardProps {
  panel: PanelId
  /** Ya filtradas por fecha y por los menús del panel: la cohorte. */
  opportunities: Opportunity[]
  allOpportunities: Opportunity[]
  contacts: Contact[]
  allContacts: Contact[]
  pipelines?: Pipeline[]
  tasks?: Task[]
  calls?: Call[]
  allPautas?: Pauta[]
  appointments?: Appointment[]
  /** SIN filtrar: la cita cuenta en cualquier fecha, como en el embudo de GENERAL. */
  allAppointments?: Appointment[]
  messages?: Message[]
  locationId?: string
  dateRange?: ResolvedDateRange | null
  metaPanel?: MetaPanelContext | null
  metaWarning?: SyncWarning | null
  locationCreatedAt?: string
}

/**
 * "Inversión y rendimiento de pauta": el gasto de Meta cruzado con los leads
 * del CRM por campaña → anuncio, con los nombres de Meta. Reemplaza a
 * "Rendimiento por pauta" (2026-09-28). Todo el cálculo vive en
 * buildPautaInvestment; aquí solo se acota y se dibuja.
 */
export function PautaInvestmentCard({
  panel,
  opportunities,
  allOpportunities,
  contacts,
  allContacts,
  pipelines = [],
  tasks = [],
  calls = [],
  allPautas = [],
  appointments = [],
  allAppointments = [],
  messages = [],
  locationId = "",
  dateRange = null,
  metaPanel = null,
  metaWarning = null,
  locationCreatedAt,
}: PautaInvestmentCardProps) {
  const [drill, setDrill] = useState<DrillState>(DRILL_CLOSED)
  const scope = PANEL_SCOPES[panel]

  // El nombre real del pipeline de la pestaña (null en GENERAL) y las cuentas
  // publicitarias que le corresponden.
  const desarrollo = useMemo(() => {
    const id = resolvePipelineId(pipelines, panel)
    if (id === null) return null
    return pipelines.find((p) => p.id === id)?.name?.trim() || scope.label
  }, [pipelines, panel, scope.label])

  const accountIds = useMemo(() => {
    if (!metaPanel || desarrollo === null) return null
    return new Set([...metaPanel.accountToPipeline.entries()].filter(([, d]) => d === desarrollo).map(([id]) => id))
  }, [metaPanel, desarrollo])

  const contactsWithCita = useMemo(() => {
    const s = new Set<string>()
    for (const a of allAppointments.length > 0 ? allAppointments : appointments) if (a.contactId) s.add(a.contactId)
    return s
  }, [allAppointments, appointments])

  const range = useMemo(
    () => (dateRange ? { start: localDay(dateRange.from.toISOString()), end: localDay(dateRange.to.toISOString()) } : null),
    [dateRange]
  )

  const inv = useMemo(() => {
    if (!metaPanel) return null
    return buildPautaInvestment({
      opportunities: scopeOpportunities(opportunities, panel, pipelines),
      daily: scopeMetaDaily(metaPanel.meta, metaPanel.desarrolloByAd, panel, pipelines),
      range,
      ctx: metaPanel.ctx,
      contactsWithCita,
      accountIds,
    })
  }, [metaPanel, opportunities, panel, pipelines, range, contactsWithCita, accountIds])

  const oppById = useMemo(() => new Map(allOpportunities.map((o) => [o.id, o])), [allOpportunities])
  const openIds = (ids: string[], title: string, subtitle: string) => {
    const items = ids.map((id) => oppById.get(id)).filter((o): o is Opportunity => Boolean(o))
    if (items.length === 0) return
    setDrill({ open: true, title, subtitle, opportunities: items })
  }
  const drillMetrics = (key: PautaDrillKey, title: string, m: PautaMetrics) =>
    openIds(m.oppIds[key], title, `Embudo ${scope.label} · cohorte por fecha de creación`)

  const revoked = metaWarning?.reason === "token_revoked" || metaWarning?.reason === "token_unreadable"
  const partial = metaWarning?.kind === "partial" ? metaWarning.reason ?? "" : null
  const accountNames = (ids: string) =>
    ids
      .split(",")
      .map((id) => metaPanel?.index.accountsById.get(id.trim())?.name?.trim() || id.trim())
      .filter(Boolean)
      .join(", ")

  const viaTotal = inv ? inv.via.adId + inv.via.campaignId + inv.via.url + inv.via.name : 0

  return (
    <DashboardCard>
      <ChartCardHeader
        title="Inversión y rendimiento de pauta"
        icon={Coins}
        total={inv?.kpi.leadsCrm}
        actions={
          <ScopePill
            label="cohorte por fecha"
            tooltip={
              <>
                <strong>Gasto</strong>: lo que Meta reportó en los días del periodo
                {desarrollo ? <> para las cuentas publicitarias de <strong>{desarrollo}</strong></> : null}.{" "}
                <strong>Leads CRM</strong>: oportunidades del embudo <strong>{scope.label}</strong> creadas en el periodo
                y atadas a un anuncio o campaña de Meta por, en este orden, su <em>ad id</em>, el id de campaña de
                la atribución, la URL con la que entraron, o el nombre de la pauta. Cada oportunidad entra por un
                solo nivel. <strong>Citas</strong> es etapa 04 o posterior, ganada, o una cita en el objeto Citas;{" "}
                <strong>Visitas</strong> es 05 o ganada; <strong>Ventas</strong> es ganada. Los costos son gasto ÷
                resultados de esta cohorte: con un ciclo de meses, el costo por venta de un periodo reciente siempre
                sale alto. Asesor, origen, canal, campaña y agencia acotan solo los leads; el gasto no sabe de
                asesores.
              </>
            }
          />
        }
      />
      <ChartCardContent className="flex flex-col gap-4">
        {!metaPanel ? (
          <ChartEmpty
            message={
              revoked
                ? "Meta desconectado: reconecta desde la píldora \"Meta\" del encabezado."
                : "Sin conexión con Meta Ads. Conéctala desde la píldora \"Meta\" del encabezado para ver el gasto."
            }
          />
        ) : !inv || (inv.kpi.spend === 0 && inv.kpi.leadsCrm === 0) ? (
          <ChartEmpty message="Sin gasto ni leads de pauta en el periodo seleccionado" />
        ) : (
          <>
            {(revoked || partial) && (
              <p className="rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/30 dark:text-amber-200">
                {revoked
                  ? "Meta desconectado: se muestra el último gasto sincronizado. Reconecta desde la píldora \"Meta\"."
                  : `En el último sync no respondieron las cuentas ${accountNames(partial!)}; su gasto falta aquí.`}
              </p>
            )}
            {inv.mixedCurrency && (
              <p className={cn("text-[11px]", MISSING_TEXT)}>
                Las cuentas mezclan monedas: los totales van sin símbolo y los costos por resultado se apagan.
              </p>
            )}
            <PautaInvestmentKpis
              inv={inv}
              onDrill={(key, title) => drillMetrics(key, title, inv.kpi)}
            />
            <PautaInvestmentTable inv={inv} onDrill={drillMetrics} />
            <p className="border-t border-border pt-2 text-[11px] leading-relaxed text-muted-foreground">
              {n(viaTotal)} {viaTotal === 1 ? "lead entró" : "leads entraron"} por ad id ({n(inv.via.adId)}), id de campaña (
              {n(inv.via.campaignId)}), URL ({n(inv.via.url)}) o nombre ({n(inv.via.name)})
              {inv.noAdId.count > 0 && (
                <>
                  ;{" "}
                  <button type="button" onClick={() => openIds(inv.noAdId.oppIds, "Leads de pauta sin vincular a Meta", `Embudo ${scope.label}`)} className={cn("font-medium underline-offset-2 hover:underline", MISSING_TEXT)}>
                    {n(inv.noAdId.count)} de pauta
                  </button>{" "}
                  no se pudieron vincular
                </>
              )}
              {inv.unknownAd.count > 0 && (
                <>
                  ;{" "}
                  <button type="button" onClick={() => openIds(inv.unknownAd.oppIds, "Leads con ad id de una cuenta no conectada", `Embudo ${scope.label}`)} className={cn("font-medium underline-offset-2 hover:underline", MISSING_TEXT)}>
                    {n(inv.unknownAd.count)}
                  </button>{" "}
                  traen un ad id de una cuenta no conectada (revisa "Cambiar cuentas" en la píldora Meta)
                </>
              )}
              {inv.otherAccount.count > 0 && (
                <>
                  ;{" "}
                  <button type="button" onClick={() => openIds(inv.otherAccount.oppIds, "Leads de anuncios de otra cuenta", `Embudo ${scope.label}`)} className="font-medium text-foreground underline-offset-2 hover:underline">
                    {n(inv.otherAccount.count)}
                  </button>{" "}
                  vienen de anuncios de otra cuenta publicitaria y no entran al costo de esta pestaña
                </>
              )}
              {inv.unlinkedSpend > 0 && (
                <>; hay gasto de anuncios eliminados sin campaña conocida (fila <em>Sin campaña</em>)</>
              )}
              . Gasto desde {locationCreatedAt ? `la creación de la subcuenta (${localDay(locationCreatedAt)})` : "el mes en curso, porque GHL no devolvió la fecha de creación de la subcuenta"}
              {metaPanel.mixedAds.length > 0 && desarrollo === null && (
                <>; {n(metaPanel.mixedAds.length)} anuncios tienen leads en más de un desarrollo y su gasto no se reparte</>
              )}
              .
            </p>
          </>
        )}
      </ChartCardContent>

      <ChartDrillDrawer
        drill={drill}
        onDrillChange={setDrill}
        contacts={allContacts.length > 0 ? allContacts : contacts}
        tasks={tasks}
        calls={calls}
        allOpportunities={allOpportunities}
        allPautas={allPautas}
        appointments={appointments}
        messages={messages}
        locationId={locationId}
      />
    </DashboardCard>
  )
}
```

Si `Appointment` no tiene `contactId`, mira cómo lo resuelve `lib/pauta-performance.ts` (`contactsWithCita`) y copia esa lectura.

- [ ] **Step 4: Montar en `panel-dashboard.tsx`**

Reemplaza el import de `PautaPerformanceTable` por `import { PautaInvestmentCard } from "./pauta-investment-card"` y el montaje por:

```tsx
      {/* Inversión y rendimiento de pauta: el gasto de Meta cruzado con los
          leads del CRM por campaña → anuncio, con los nombres de Meta. En las
          siete pestañas: por desarrollo el gasto es el de SU cuenta publicitaria.
          Reemplaza a "Rendimiento por pauta" (pauta-performance-table.tsx, que
          se conserva desmontado) desde 2026-09-28, pedido del cliente. */}
      <PautaInvestmentCard
        {...shared}
        allAppointments={allAppointments}
        dateRange={dateRange}
        metaPanel={metaPanel}
        metaWarning={metaWarning}
        locationCreatedAt={locationCreatedAt}
      />
```

Desestructura `dateRange = null` en `PanelDashboard` (ya está en las props, no en la firma).

- [ ] **Step 5: Tipos y commit**

Run: `npx tsc --noEmit`
Expected: limpio. Errores típicos: `Appointment.contactId` opcional (usa `a.contactId ?? ""` y filtra vacíos), `React.ReactNode` sin importar (usa `ReactNode` de `react`).

```bash
git add components/dashboard/pauta-investment-card.tsx components/dashboard/pauta-investment-kpis.tsx components/dashboard/pauta-investment-table.tsx components/dashboard/panel-dashboard.tsx
git commit -m "feat(panel): tarjeta \"Inversión y rendimiento de pauta\" en lugar de \"Rendimiento por pauta\"

KPI de gasto, leads CRM vs Meta, CPL, citas, visitas, ventas y costo por venta;
tabla campaña → anuncio con nombres de Meta, ids, URLs de entrada y drill en
cada celda del CRM. Estados: sin conexión, revocado, parcial, moneda mixta.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: CLAUDE.md al día

**Files:**
- Modify: `CLAUDE.md` (secciones "Current state" → orden de charts y descripción de `pauta-performance-table.tsx`; "Meta Ads"; tabla de "Shared domain rules")

- [ ] **Step 1: "Current state"**

En la línea del orden (`The order, top to bottom: … → \`pauta-performance-table.tsx\` → …`) sustituye `pauta-performance-table.tsx` por `pauta-investment-card.tsx`. En la lista de charts, reemplaza el párrafo entero que empieza con `` `pauta-performance-table.tsx` ("Rendimiento por pauta", every tab, added 2026-09-17: `` y termina en ``sentinel is "Sin id"),`` por:

```markdown
  `pauta-investment-card.tsx` ("Inversión y rendimiento de pauta", every tab, added
  2026-09-28, **replacing** `pauta-performance-table.tsx` — file and
  `lib/pauta-performance.ts` kept, unmounted, at the client's request; `hadCita` and
  `buildPautaNamesByContact` from that module are still imported by the attribution).
  Spec: `docs/superpowers/specs/2026-09-28-inversion-y-rendimiento-de-pauta-design.md`.
  KPI row (Gasto · Leads CRM with "Meta reportó N" · CPL · Citas · Visitas · Ventas ·
  Costo por venta) plus impressions/clicks/CPM/CTR, and a campaign → ad table with
  **Meta's campaign names**, ad ids, the URLs leads came in through, Top 15 by spend,
  search, and a drill on every CRM cell. **Everything is computed by
  `buildPautaInvestment`** (`lib/meta-attribution.ts`); the component only scopes and
  draws. Leads are the creation cohort of the tab (already date-filtered upstream);
  spend is the same date range over the tab's **ad accounts** (each account is a
  desarrollo, `accountToPipeline`). The other global filters narrow leads only, never
  spend. Sentinels: "Sin campaña" (deleted ads whose campaign nobody taught),
  "Anuncio eliminado" (spend for an ad no longer in `/ads`), both in `MISSING_TEXT`.
  Footnote: leads per attribution level, unlinkable pauta leads, ad ids from
  unconnected accounts, leads from another account's ads),
```

- [ ] **Step 2: "Meta Ads"**

Reemplaza los bullets **"La llave es el ad id"**, **"Tres niveles de atribución"**, **"Cada sync re-trae la ventana completa"**, **"El desarrollo de un ad se infiere"** y **"Costo por etapa = cohorte de creación"** por:

```markdown
- **La cadena de vínculos tiene cuatro niveles, cada uno solo si el anterior no dio
  nada, nunca sumados** (`classifyLead`, 2026-09-28): **1** ad id (`opp.adId` →
  custom field `ID Pauta`/`ID de Pauta` de la opp → del contacto → cualquier
  `attributions[].utmAdId`, first antes que last) → **2** `utmCampaignId` de la
  attribution → **3** la URL de entrada (`URL Pauta`, `attributionUrl`,
  `attributions[].url`) contra el mapa **URL → anuncio aprendido** de las
  oportunidades que traen URL y ad id (`buildLearnedIndex`, sobre el set sin filtrar;
  una URL de varios anuncios de una misma campaña resuelve a campaña) → **4** nombres
  (`Nombre Pauta`, `Pauta`, `adName`, `utmCampaign`, objeto Pauta) contra el nombre
  de UNA campaña o de UN anuncio. Resuelve a `ad` o a `campaign` con `via`; centinelas
  `unknownAd` (ad id de cuenta no conectada), `noAdId` (de pauta sin llave) y
  `notPauta` (orgánico, referido, `csv_import` — gana incluso con ad id). Medido
  2026-09-28 con cinco cuentas: 70.9 % de las no importadas resuelven; 3 740 de 3 782
  `utmCampaignId` coinciden con la campaña del anuncio.
- **Cada cuenta publicitaria ES un desarrollo** ("Cañadas by El Mirador ", "Átria "…):
  `accountToPipeline` casa el nombre de la cuenta con el pipeline y manda sobre la
  inferencia por leads de `assignAdDesarrollos`, que queda de respaldo. Por pestaña
  el gasto es el de sus cuentas; un lead atado a un anuncio de otra cuenta va al pie
  (`otherAccount`) y no entra al costo de esa pestaña. El gasto no se reparte ni se
  convierte de moneda.
- **La ventana de gasto arranca en la creación de la subcuenta** (`dateAdded` de
  `/locations`, 2025-10-15 en DRT, en `payload.meta.locationCreatedAt`) y **los
  anuncios con `created_time` anterior se descartan con sus insights**
  (`filterAdsCreatedSince`). Pedido del cliente. Un anuncio **borrado** (con gasto
  pero fuera de `/ads`) se conserva como "Anuncio eliminado"; su campaña se aprende
  del `utmCampaignId` de sus leads. Cada sync re-trae la ventana completa; sin merge
  incremental.
- **El fetch corre todas las cuentas en paralelo y tres meses concurrentes por
  cuenta** (`ACCOUNT_CONCURRENCY` / `MONTH_CONCURRENCY` en `meta-client.ts`). En serie
  tardaba 362 s y moría en el techo de 300 s del refresco. **`paging.next` de Graph
  vuelve bajo otra versión** (`/v26.0/` cuando se pidió v23.0): `nextPageRequest`
  quita cualquier `/vNN.N/`; sin eso las cuatro cuentas grandes fallaban con `2500`.
  Los códigos 1 y 2 son transitorios y se reintentan.
- **Costo por resultado = cohorte de creación**: gasto del rango ÷ leads creados en el
  rango que alcanzaron la etapa; venta es `isWonOpp`, cita es `hadCita`
  (`≥04` ∪ ganada ∪ objeto Citas), visita `≥05` ∪ ganada. Sin resultados → `null`,
  nunca `$0`. `buildCostPerStage` y `buildCampaignPerformance` ya no existen:
  `buildPautaInvestment` es la única agregación.
```

- [ ] **Step 3: Tabla de módulos y commit**

En la tabla "Shared domain rules", cambia la fila de `lib/pauta-performance.ts` a: `| \`lib/pauta-performance.ts\` | **sin montar** desde 2026-09-28 (ver "Inversión y rendimiento de pauta"); conserva \`hadCita\` (cita = etapa ∪ ganada ∪ objeto Citas) y \`buildPautaNamesByContact\`, que la atribución de Meta importa |` y la de `lib/meta-attribution.ts` a: `| \`lib/meta-attribution.ts\` | la cadena de cuatro niveles (\`classifyLead\`), lo aprendido de los leads (URL → anuncio, campaña de anuncios borrados), cuenta = desarrollo, y \`buildPautaInvestment\`, la única agregación de la tarjeta |`.

Y en la línea de `pnpm verify:meta`, agrega `, paginación de Graph, filtro de anuncios por fecha`.

```bash
git add CLAUDE.md
git commit -m "docs: la tarjeta de inversión, la cadena de cuatro niveles y la cuenta como desarrollo

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Contra realidad

**Files:** ninguno nuevo. Requiere producción (el OAuth de Meta no corre en localhost; el dev local lee la misma fila de Neon).

- [ ] **Step 1: Todo verde antes de empujar**

Run: `pnpm verify:meta && pnpm verify:meta-attribution && pnpm verify:filters && pnpm verify:pauta-performance && npx tsc --noEmit`
Expected: cuatro `✅` y tsc limpio.

- [ ] **Step 2: Empujar y esperar el deploy**

```bash
git push origin main
```

Vercel despliega `main`. Confirma con `vercel ls` o desde el dashboard que el deploy terminó en `Ready`.

- [ ] **Step 3: Sync en fresco y tiempo**

Abre `https://drt.lezgosuite.com`, entra, y aprieta **Actualizar** (manda `?fresh=1`). En la pantalla de carga la fila **Meta Ads** debe terminar `done` con un conteo del orden de **1 800-2 300 anuncios** (seis cuentas) y **sin banner ámbar**. Cronometra el sync completo: debe quedar **bajo 300 s**; si se acerca, sube `MONTH_CONCURRENCY` a 4 antes de bajar cuentas.

- [ ] **Step 4: Cuadrar contra el Administrador de anuncios**

En la pestaña **Cañadas**, filtro de fechas **agosto 2026**, busca la campaña `CAÑADA | Domus |  FORM 2 Jul` y compara su **Gasto** con el que muestra el Administrador de anuncios de la cuenta `act_520082890601955` para el 1-31 de agosto. Deben coincidir al peso (Meta puede corregir centavos hacia atrás). Anota la cifra en el commit de cierre.

- [ ] **Step 5: Que cada pestaña tenga su cuenta**

Recorre Atria, Cañadas, La Sierra, Palmyra, Saggita y Zanda con "Todo el historial": el KPI de Gasto de cada una debe ser distinto y sumar, entre las seis más "Sin desarrollo" en GENERAL, el gasto de GENERAL. Abre una campaña y comprueba que el chevron despliega anuncios con id, URL y métricas, y que un clic en "Leads CRM" abre el drawer con esa cantidad de oportunidades.

- [ ] **Step 6: Que la caché siga sirviendo**

Recarga la página sin `?fresh=1`: debe cargar en pocos segundos (camino caliente). Espera 15 min, recarga y confirma que "Actualizado hace X" avanza — eso prueba que el refresco en segundo plano ya no muere en los 300 s.

- [ ] **Step 7: Commit de cierre con las cifras**

```bash
git commit --allow-empty -m "chore(meta): verificado en producción 2026-09-XX

Sync en fresco: N anuncios, seis cuentas done, T s. Gasto agosto de
\"CAÑADA | Domus |  FORM 2 Jul\" en el panel: \$X; en el Administrador: \$X.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push origin main
```
