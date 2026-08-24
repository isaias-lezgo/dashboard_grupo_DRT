# Resiliencia y visibilidad del sync — plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que un fallo parcial de GHL cueste una página de 100 registros en vez de un dataset entero, y que el usuario siempre sepa si el panel está trabajando, reintentando, o mostrando datos incompletos.

**Architecture:** Tres capas. (1) `lib/paged-fetch.ts`, módulo nuevo sin red que hace el abanico de páginas con `Promise.allSettled` y una pasada de reintento sobre las que fallaron; `lib/ghl-client.ts` lo usa y sus tres funciones paginadas pasan a devolver `PagedResult<T>`. (2) `app/api/dashboard/route.ts` gana estados de paso `retrying | partial | error`, un reintento a nivel dataset, y un array `warnings` en el frame `data`. (3) La pantalla de carga muestra esos estados más tiempo transcurrido y aviso de atasco; el panel muestra un banner con botón Reintentar.

**Tech Stack:** Next.js 16 App Router, TypeScript, pnpm, tsx para los scripts de verificación, framer-motion + Tailwind + lucide-react en la UI.

## Global Constraints

- **Gestor de paquetes: pnpm.** Nunca `npm install`. Si hiciera falta tocar el lockfile: `pnpm install --lockfile-only`.
- **No hay framework de tests y no se adopta uno.** La verificación de módulos puros va en `scripts/verify-*.ts` con `node:assert/strict`, ejecutados por `tsx`.
- **El paquete es CommonJS** (no hay `"type": "module"`). En los scripts de verificación **el top-level `await` falla**: envolver todo en `main()` y llamar `main().catch(...)`.
- **`npx tsc --noEmit` es obligatorio** antes de cada commit de este plan. `next build` ignora errores de TypeScript, así que un build verde no prueba nada.
- Idioma de todo el texto visible al usuario: **español**.
- La marca se presenta como **"Lezgo Suite CRM"**; nunca escribir "GoHighLevel" ni "GHL" en texto visible al usuario. En comentarios de código y logs sí se usa GHL normalmente.
- Rama de trabajo: `fix/sync-resiliencia-visibilidad` (ya creada, con el spec commiteado).
- Spec de referencia: `docs/superpowers/specs/2026-08-02-sync-resiliencia-y-visibilidad-design.md`

---

## Estructura de archivos

| Archivo | Responsabilidad | Tarea |
|---|---|---|
| `lib/paged-fetch.ts` | **Nuevo.** Abanico de páginas tolerante a fallos + reintento por página. Sin red, sin framework: `fetchPage` se inyecta. | 1 |
| `scripts/verify-paged-fetch.ts` | **Nuevo.** Aserciones sobre `lib/paged-fetch.ts` con `fetchPage` falso. | 1 |
| `package.json` | Añadir el script `verify:paged`. | 1 |
| `lib/ghl-client.ts` | `getAllOpportunities`, `getAllCustomObjectRecords`, `getAllContacts` pasan a devolver `PagedResult`. | 2 |
| `scripts/diag-otro-pauta.ts` | Llamante a actualizar a `.records`. | 2 |
| `lib/types.ts` | Declara `SyncWarning`, consumido por la ruta y por el cliente. Una sola definición para que las dos puntas no deriven. | 3 |
| `app/api/dashboard/route.ts` | Estados de paso, reintento a nivel dataset, `warnings` en el frame `data`. | 3 |
| `hooks/fetch-stream.ts` | Ampliar el union de `StreamStep.status`. | 4 |
| `hooks/use-dashboard-data.ts` | Ampliar `StepState`, exponer `warnings`, `elapsedMs`, `stalled`. | 4 |
| `components/dashboard/loading-screen.tsx` | Estados visuales nuevos, tiempo transcurrido, aviso de atasco. | 5 |
| `components/dashboard/sync-warning-banner.tsx` | **Nuevo.** Banner de datos incompletos. Componente aparte para no engordar `app/page.tsx`. | 6 |
| `app/page.tsx` | Montar el banner. | 6 |

---

### Task 1: `lib/paged-fetch.ts` — abanico tolerante a fallos

Es el corazón del arreglo y el único trozo verificable sin red, así que va primero y solo.

**Files:**
- Create: `lib/paged-fetch.ts`
- Create: `scripts/verify-paged-fetch.ts`
- Modify: `package.json` (bloque `scripts`, junto a las otras entradas `verify:*` en las líneas 10-13)

**Interfaces:**
- Consumes: nada (módulo hoja).
- Produces: `PagedResult<T>` y `fanOutPages<T>(opts: FanOutOptions<T>): Promise<PagedResult<T>>`. La Task 2 importa ambos.

- [ ] **Step 1: Escribir las aserciones (el "test que falla")**

Crear `scripts/verify-paged-fetch.ts` con este contenido exacto:

```ts
// Verification for lib/paged-fetch.ts. Run: pnpm verify:paged
//
// This module exists because of a real production failure: getAllOpportunities
// fanned every remaining page out with Promise.all, so ONE page rejecting threw
// away the ~139 pages that had already landed and the dashboard reported zero
// opportunities on a 14k-opportunity sub-account. The first assertion below is
// that exact regression.
//
// Wrapped in main() rather than using top-level await: this package is CJS.
import assert from "node:assert/strict";
import { fanOutPages } from "../lib/paged-fetch";

type Row = { id: string };

// Build a fake page fetcher over `total` synthetic rows.
//   failOn      — page numbers that reject
//   failOnceOn  — page numbers that reject the first time and succeed after
function makeFetcher(opts: {
  total: number;
  pageSize: number;
  failOn?: number[];
  failOnceOn?: number[];
}) {
  const failOn = new Set(opts.failOn ?? []);
  const failedOnce = new Set<number>();
  const calls: number[] = [];

  const fetchPage = async (page: number): Promise<Row[]> => {
    calls.push(page);
    if (failOn.has(page)) throw new Error(`page ${page} is broken`);
    if ((opts.failOnceOn ?? []).includes(page) && !failedOnce.has(page)) {
      failedOnce.add(page);
      throw new Error(`page ${page} failed once`);
    }
    const start = (page - 1) * opts.pageSize;
    return Array.from(
      { length: Math.max(0, Math.min(opts.pageSize, opts.total - start)) },
      (_, i) => ({ id: `r${start + i}` })
    );
  };

  return { fetchPage, calls };
}

const idOf = (r: Row) => r.id;
// No real waiting in verification — the retry pause is injected.
const noSleep = async () => {};

async function main() {
  const pageSize = 100;

  // --- happy path: every page lands
  {
    const { fetchPage } = makeFetcher({ total: 350, pageSize });
    const first = await fetchPage(1);
    const res = await fanOutPages<Row>({
      initial: first,
      pages: [2, 3, 4],
      fetchPage,
      pageSize,
      idOf,
      total: 350,
      sleep: noSleep,
    });
    assert.equal(res.records.length, 350, "all 350 rows collected");
    assert.deepEqual(res.missingPages, [], "nothing missing");
    assert.equal(res.missingEstimate, 0);
  }

  // --- THE REGRESSION: one permanently broken page must NOT discard the rest.
  // Under the old Promise.all this returned zero rows.
  {
    const { fetchPage } = makeFetcher({ total: 350, pageSize, failOn: [3] });
    const first = await fetchPage(1);
    const res = await fanOutPages<Row>({
      initial: first,
      pages: [2, 3, 4],
      fetchPage,
      pageSize,
      idOf,
      total: 350,
      sleep: noSleep,
    });
    assert.equal(res.records.length, 250, "keeps pages 1,2,4 — loses only page 3");
    assert.deepEqual(res.missingPages, [3], "page 3 reported missing");
    assert.equal(res.missingEstimate, 100, "one page of 100 estimated lost");
  }

  // --- a page that fails once recovers on the retry pass
  {
    const { fetchPage, calls } = makeFetcher({ total: 350, pageSize, failOnceOn: [3] });
    const first = await fetchPage(1);
    const retried: number[][] = [];
    const res = await fanOutPages<Row>({
      initial: first,
      pages: [2, 3, 4],
      fetchPage,
      pageSize,
      idOf,
      total: 350,
      sleep: noSleep,
      onRetry: (p) => retried.push(p),
    });
    assert.equal(res.records.length, 350, "retry recovered the full set");
    assert.deepEqual(res.missingPages, [], "nothing missing after retry");
    assert.deepEqual(retried, [[3]], "onRetry fired with only the failed page");
    // Page 3 fetched twice; pages 2 and 4 exactly once — the retry must not
    // re-fetch pages that already succeeded.
    assert.equal(calls.filter((p) => p === 3).length, 2, "page 3 fetched twice");
    assert.equal(calls.filter((p) => p === 2).length, 1, "page 2 not re-fetched");
    assert.equal(calls.filter((p) => p === 4).length, 1, "page 4 not re-fetched");
  }

  // --- overlapping pages are deduped by id
  {
    const dupes: Row[] = [{ id: "a" }, { id: "b" }];
    const res = await fanOutPages<Row>({
      initial: [{ id: "a" }],
      pages: [2],
      fetchPage: async () => dupes,
      pageSize: 2,
      idOf,
      sleep: noSleep,
    });
    assert.equal(res.records.length, 2, "duplicate id absorbed once");
    assert.deepEqual(res.records.map(idOf), ["a", "b"], "first-seen order preserved");
  }

  // --- missingEstimate never claims more than `total` allows
  {
    const { fetchPage } = makeFetcher({ total: 210, pageSize, failOn: [3] });
    const first = await fetchPage(1);
    const res = await fanOutPages<Row>({
      initial: first,
      pages: [2, 3],
      fetchPage,
      pageSize,
      idOf,
      total: 210,
      sleep: noSleep,
    });
    assert.equal(res.records.length, 200, "pages 1 and 2 landed");
    // A whole page of 100 failed, but total says only 10 rows can be missing.
    assert.equal(res.missingEstimate, 10, "estimate capped by total - loaded");
  }

  // --- empty page list is a no-op, not a crash
  {
    const res = await fanOutPages<Row>({
      initial: [{ id: "x" }],
      pages: [],
      fetchPage: async () => {
        throw new Error("must not be called");
      },
      pageSize,
      idOf,
      total: 1,
      sleep: noSleep,
    });
    assert.equal(res.records.length, 1);
    assert.deepEqual(res.missingPages, []);
  }

  // --- onProgress reports the running deduped count
  {
    const { fetchPage } = makeFetcher({ total: 300, pageSize });
    const first = await fetchPage(1);
    const seen: number[] = [];
    await fanOutPages<Row>({
      initial: first,
      pages: [2, 3],
      fetchPage,
      pageSize,
      idOf,
      total: 300,
      sleep: noSleep,
      onProgress: (n) => seen.push(n),
    });
    assert.equal(seen[0], 100, "first callback is the seeded page");
    assert.equal(seen[seen.length - 1], 300, "last callback is the full count");
  }

  console.log("verify-paged-fetch: all assertions passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Añadir el script a `package.json`**

En el bloque `scripts`, después de `"verify:attachments"` (línea 13):

```json
    "verify:paged": "tsx scripts/verify-paged-fetch.ts",
```

- [ ] **Step 3: Correr la verificación para confirmar que falla**

```bash
pnpm verify:paged
```

Esperado: FALLA porque `lib/paged-fetch.ts` todavía no existe (error de resolución de módulo).

- [ ] **Step 4: Escribir `lib/paged-fetch.ts`**

```ts
// lib/paged-fetch.ts
// Resilient page fan-out for GHL's numbered-page endpoints.
//
// Extracted from ghl-client.ts because the inline `Promise.all` over every
// remaining page was all-or-nothing: one page rejecting after its retries threw
// away every page that HAD landed. On a 14k-opportunity sub-account that turned
// a single failed request into a dashboard reporting zero opportunities — a
// silently wrong answer, not a crash, which is exactly the bug class this repo
// covers with scripts/verify-*.ts.
//
// Framework-free and network-free: `fetchPage` is injected, so
// scripts/verify-paged-fetch.ts exercises every failure path without a socket.

/** Outcome of a paginated walk, carrying whether it came back complete. */
export interface PagedResult<T> {
  records: T[];
  /** Total the API reported, when it reported one. */
  total?: number;
  /** 1-indexed page numbers still missing after the retry pass. Empty = complete. */
  missingPages: number[];
  /** Estimated records lost. Capped by `total` when known. */
  missingEstimate: number;
}

export interface FanOutOptions<T> {
  /** Page 1's records, already fetched by the caller. Seeds the dedupe set. */
  initial: T[];
  /** 1-indexed page numbers still to fetch. May be empty. */
  pages: number[];
  fetchPage: (page: number) => Promise<T[]>;
  pageSize: number;
  /** Stable identity, so overlapping pages don't inflate the count. */
  idOf: (record: T) => string;
  total?: number;
  /** Running deduped count, fired after every absorbed batch. */
  onProgress?: (count: number) => void;
  /** Fired once, with the pages about to be retried, if any failed. */
  onRetry?: (pages: number[]) => void;
  /** Injected in verification to skip the real pause. */
  sleep?: (ms: number) => Promise<void>;
  /** Pause before the retry pass. Defaults to RETRY_PAUSE_MS. */
  retryPauseMs?: number;
}

// One GHL rate-limit window. Retrying instantly would just burn the attempt
// against a window that is still closed, so we wait it out first.
const RETRY_PAUSE_MS = 10_000;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function fanOutPages<T>({
  initial,
  pages,
  fetchPage,
  pageSize,
  idOf,
  total,
  onProgress,
  onRetry,
  sleep = defaultSleep,
  retryPauseMs = RETRY_PAUSE_MS,
}: FanOutOptions<T>): Promise<PagedResult<T>> {
  const seen = new Set<string>();
  const records: T[] = [];

  const absorb = (batch: T[]) => {
    for (const r of batch) {
      const id = idOf(r);
      if (seen.has(id)) continue;
      seen.add(id);
      records.push(r);
    }
    onProgress?.(records.length);
  };

  absorb(initial);

  // Fetch a set of pages, keeping whatever lands. Returns the ones that didn't.
  const attempt = async (nums: number[]): Promise<number[]> => {
    if (nums.length === 0) return [];
    const settled = await Promise.allSettled(nums.map((p) => fetchPage(p)));
    const failed: number[] = [];
    settled.forEach((res, i) => {
      if (res.status === "fulfilled") {
        absorb(res.value);
      } else {
        failed.push(nums[i]);
        const reason = res.reason instanceof Error ? res.reason.message : String(res.reason);
        console.warn(`[GHL] page ${nums[i]} failed: ${reason}`);
      }
    });
    return failed;
  };

  let missingPages = await attempt(pages);

  // One retry pass over ONLY the pages that failed — 1 request of 140, not 140.
  if (missingPages.length > 0) {
    onRetry?.(missingPages);
    await sleep(retryPauseMs);
    missingPages = await attempt(missingPages);
  }

  const rawEstimate = missingPages.length * pageSize;
  const missingEstimate =
    total !== undefined
      ? Math.min(rawEstimate, Math.max(0, total - records.length))
      : rawEstimate;

  return { records, total, missingPages, missingEstimate };
}
```

- [ ] **Step 5: Correr la verificación para confirmar que pasa**

```bash
pnpm verify:paged
```

Esperado: `verify-paged-fetch: all assertions passed`

- [ ] **Step 6: Comprobar tipos**

```bash
npx tsc --noEmit
```

Esperado: sin errores.

- [ ] **Step 7: Commit**

```bash
git add lib/paged-fetch.ts scripts/verify-paged-fetch.ts package.json
git commit -m "feat(sync): abanico de páginas tolerante a fallos con reintento por página

Un Promise.all sobre ~140 páginas convertía un fallo en cero registros.
fanOutPages usa allSettled, conserva lo que llegó y reintenta solo las
páginas caídas. Verificado en scripts/verify-paged-fetch.ts.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: `lib/ghl-client.ts` — las tres funciones paginadas devuelven `PagedResult`

**Files:**
- Modify: `lib/ghl-client.ts:848-890` (`getAllCustomObjectRecords`), `:902-933` (`getAllOpportunities`), `:936-984` (`getAllContacts`)
- Modify: `scripts/diag-otro-pauta.ts:18`
- Modify: `app/api/dashboard/route.ts:233, 460-492` (solo lo mínimo para que compile; los estados nuevos son la Task 3)

**Interfaces:**
- Consumes: `PagedResult<T>`, `fanOutPages<T>` de `lib/paged-fetch.ts` (Task 1).
- Produces:
  - `getAllOpportunities(onProgress?): Promise<PagedResult<GHLOpportunity>>`
  - `getAllCustomObjectRecords(objectKey, onProgress?): Promise<PagedResult<GHLCustomObjectRecord>>`
  - `getAllContacts(onProgress?): Promise<PagedResult<GHLContact>>`

- [ ] **Step 1: Importar `fanOutPages` en `lib/ghl-client.ts`**

Junto a los imports existentes de la cabecera del archivo (donde ya se importa de `./ghl-limiter`):

```ts
import { fanOutPages, type PagedResult } from "./paged-fetch";
```

- [ ] **Step 2: Reescribir `getAllOpportunities`**

Reemplazar el cuerpo completo de la función (`lib/ghl-client.ts:902-933`) por:

```ts
export async function getAllOpportunities(
  onProgress?: (count: number) => void
): Promise<PagedResult<GHLOpportunity>> {
  const pageSize = 100;
  const first = await getOpportunities({ page: 1, limit: pageSize });
  const total = first.meta.total ?? first.opportunities.length;

  // Page 1 already covers everything → nothing to fan out.
  const done = first.opportunities.length >= total || !first.meta.nextPage;
  const totalPages = done ? 1 : Math.ceil(total / pageSize);

  return fanOutPages<GHLOpportunity>({
    initial: first.opportunities,
    pages: Array.from({ length: totalPages - 1 }, (_, i) => i + 2),
    fetchPage: (page) =>
      getOpportunities({ page, limit: pageSize }).then((r) => r.opportunities),
    pageSize,
    idOf: (o) => o.id,
    total,
    onProgress,
    onRetry: (pages) =>
      console.warn(`[GHL] retrying ${pages.length} opportunity page(s): ${pages.join(", ")}`),
  });
}
```

Actualizar también el comentario de bloque que precede a la función (líneas 894-901): la frase "Results are deduped by id" sigue siendo cierta, pero hay que sustituir la descripción del `Promise.all` por la del abanico tolerante. Comentario nuevo:

```ts
// Helper to fetch all pages of opportunities.
// /opportunities/search is page-numbered AND returns meta.total on page 1, so
// once page 1 lands we know exactly how many pages remain and can fan them out.
// The fan-out goes through fanOutPages(), which keeps whatever lands and retries
// only the pages that failed — an earlier Promise.all here made one failed page
// discard the entire dataset. The limiter in ghlFetch bounds in-flight count and
// rate, so no manual paging or sleep is needed. Results are deduped by id so a
// shifting dataset can't inflate the count.
```

- [ ] **Step 3: Reescribir `getAllCustomObjectRecords`**

Reemplazar de la línea 864 (`const first = await fetchPage(1);`) hasta el `return all;` final de la función. El bloque anterior (`pageLimit`, comentario de `noQueryLocationId`, la constante `fetchPage`) se conserva tal cual, pero se renombra `fetchPage` a `fetchRecordsPage` para no chocar con la opción homónima de `fanOutPages`:

```ts
  const fetchRecordsPage = (page: number) =>
    ghlFetch<GHLCustomObjectRecordsResponse>(`/objects/${objectKey}/records/search`, {
      method: "POST",
      version: "2023-02-21",
      noQueryLocationId: true,
      body: { page, pageLimit },
    });

  const first = await fetchRecordsPage(1);
  const total = first.total ?? first.records.length;

  const done = first.records.length >= total || first.records.length < pageLimit;
  const totalPages = done ? 1 : Math.ceil(total / pageLimit);

  return fanOutPages<GHLCustomObjectRecord>({
    initial: first.records,
    pages: Array.from({ length: totalPages - 1 }, (_, i) => i + 2),
    fetchPage: (page) => fetchRecordsPage(page).then((r) => r.records),
    pageSize: pageLimit,
    idOf: (r) => r.id,
    total,
    onProgress,
    onRetry: (pages) =>
      console.warn(`[GHL] retrying ${pages.length} ${objectKey} page(s): ${pages.join(", ")}`),
  });
```

Y la firma pasa a:

```ts
export async function getAllCustomObjectRecords(
  objectKey: string,
  onProgress?: (count: number) => void
): Promise<PagedResult<GHLCustomObjectRecord>> {
```

- [ ] **Step 4: Hacer `getAllContacts` tolerante a un fallo a mitad del recorrido**

Reemplazar la función completa (`lib/ghl-client.ts:936-984`) por:

```ts
// Helper to fetch all contacts with cursor pagination.
// The walk must stay sequential (each page's cursor comes from the previous
// one), so it can't use fanOutPages. What it CAN do is refuse to throw away
// what it already has: a mid-walk failure used to propagate and discard every
// page collected so far. Now it keeps them and reports the walk incomplete.
export async function getAllContacts(
  onProgress?: (count: number) => void
): Promise<PagedResult<GHLContact>> {
  const allContacts: GHLContact[] = [];
  const seenIds = new Set<string>();
  let startAfterId: string | undefined;
  let startAfter: number | undefined;
  let total: number | undefined;
  let page = 1;
  let truncated = false;

  try {
    while (true) {
      const response = await getContacts({ limit: 100, startAfterId, startAfter });
      if (total === undefined && response.meta?.total !== undefined) total = response.meta.total;

      // Dedupe by id — GHL's cursor pagination occasionally returns overlapping
      // pages and we'd otherwise inflate the count.
      let pageNew = 0;
      for (const c of response.contacts) {
        if (seenIds.has(c.id)) continue;
        seenIds.add(c.id);
        allContacts.push(c);
        pageNew++;
      }
      onProgress?.(allContacts.length);

      // Stop once we have all records or got a partial page.
      if (
        (total !== undefined && allContacts.length >= total) ||
        response.contacts.length < 100
      ) break;

      // If a whole page is duplicates, the cursor is stuck — bail out.
      if (pageNew === 0) break;

      // Advance cursor — use both fields together (startAfter is a dateAdded
      // epoch ms; without it the cursor isn't unique).
      const last = response.contacts[response.contacts.length - 1];
      startAfterId = response.meta?.startAfterId ?? last.id;
      // Guard against a missing/malformed dateAdded producing a NaN cursor (which
      // would serialize to the literal "NaN" on the query string). The dedupe +
      // pageNew===0 bailout above still protect us if the cursor isn't unique.
      const lastDateMs = new Date(last.dateAdded).getTime();
      startAfter = response.meta?.startAfter ?? (Number.isNaN(lastDateMs) ? undefined : lastDateMs);
      page++;
      // No inter-page sleep: cursor pagination must stay sequential, but ghlFetch's
      // token bucket already paces the request rate. An extra sleep here is pure
      // added latency.
    }
  } catch (err) {
    // Deliberately NOT retried: the cursor position of the missing tail is
    // unknowable from here, so a retry would either duplicate or skip an
    // arbitrary stretch. Reporting the walk as incomplete is the honest answer.
    console.error(
      `[GHL] Contacts cursor walk failed at page ${page} (kept ${allContacts.length}):`,
      err
    );
    truncated = true;
  }

  return {
    records: allContacts,
    total,
    missingPages: truncated ? [page] : [],
    missingEstimate:
      truncated && total !== undefined ? Math.max(0, total - allContacts.length) : 0,
  };
}
```

- [ ] **Step 5: Actualizar el script de diagnóstico**

`scripts/diag-otro-pauta.ts:18` — cambiar:

```ts
    const records = await getAllCustomObjectRecords(stub.key)
```

por:

```ts
    const { records } = await getAllCustomObjectRecords(stub.key)
```

- [ ] **Step 6: Ajuste mínimo de `app/api/dashboard/route.ts` para que compile**

Solo desempaquetar `.records`; los estados nuevos llegan en la Task 3.

En `fetchAllPautas` (línea 233):

```ts
    const { records } = await getAllCustomObjectRecords(stub.key, onProgress);
```

En el `Promise.all` (líneas 460-479), cambiar los tres `.then` afectados:

```ts
              getAllContacts((count) => {
                send({ type: "progress", message: `Cargando contactos… ${count.toLocaleString("es-MX")}` });
                sendStep("contacts", "loading", count);
              })
                .then((r) => { sendStep("contacts", "done", r.records.length); return r.records; })
                .catch((err: unknown) => {
                  console.error("[GHL] Contacts fetch failed:", err);
                  sendStep("contacts", "done", 0);
                  return [] as import("@/lib/ghl-client").GHLContact[];
                }),
              getAllOpportunities((count) => {
                send({ type: "progress", message: `Cargando oportunidades… ${count.toLocaleString("es-MX")}` });
                sendStep("opportunities", "loading", count);
              })
                .then((r) => { sendStep("opportunities", "done", r.records.length); return r.records; })
                .catch((err: unknown) => {
                  console.error("[GHL] Opportunities fetch failed:", err);
                  sendStep("opportunities", "done", 0);
                  return [] as import("@/lib/ghl-client").GHLOpportunity[];
                }),
```

- [ ] **Step 7: Verificar**

```bash
npx tsc --noEmit && pnpm verify:paged
```

Esperado: sin errores de tipos, aserciones pasan.

- [ ] **Step 8: Levantar la app y confirmar que el sync sigue funcionando**

```bash
pnpm dev
```

Abrir `localhost:3000`, entrar con la contraseña de VAEO, y confirmar en la consola del servidor que no hay errores nuevos y que los tres datasets llegan con conteos plausibles. Si las oportunidades vuelven a fallar, **anotar el mensaje `[GHL]` completo** — es el dato que identifica cuál de los cuatro candidatos del spec es la causa.

- [ ] **Step 9: Commit**

```bash
git add lib/ghl-client.ts scripts/diag-otro-pauta.ts app/api/dashboard/route.ts
git commit -m "refactor(ghl): los tres recorridos paginados devuelven PagedResult

Oportunidades y objetos personalizados pasan por fanOutPages. El recorrido
por cursor de contactos deja de tirar lo acumulado cuando truena a mitad.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: `app/api/dashboard/route.ts` — el stream deja de mentir

**Files:**
- Modify: `lib/types.ts` (añadir `SyncWarning`)
- Modify: `app/api/dashboard/route.ts` (`fetchAllPautas` en :219, `sendStep` en :366, el `Promise.all` en :458-492, el frame `data` en :612)

**Interfaces:**
- Consumes: `PagedResult<T>` de `lib/paged-fetch.ts` (Task 1); las firmas de Task 2.
- Produces: `SyncWarning` en `lib/types.ts`, más estos contratos de frame para la Task 4:
  - frame step: `{ type: "step", key: string, status: "loading" | "retrying" | "done" | "partial" | "error", count?: number }`
  - campo del frame data: `warnings: SyncWarning[]`

- [ ] **Step 1: Declarar `SyncWarning` en `lib/types.ts`**

Va en `lib/types.ts` —el archivo canónico de tipos internos— y no en la ruta ni en el hook, porque lo consumen los dos lados y dos copias derivarían. `key` se deja como `string` a propósito: atarlo a `StepKey` metería una dependencia del hook dentro de `lib/`.

```ts
/**
 * A dataset that did not come back clean in the last sync.
 * `partial` = some pages never landed; `error` = nothing came back at all.
 * Neither is the same as a legitimate zero, which produces no warning.
 */
export interface SyncWarning {
  key: string;
  kind: "partial" | "error";
  loaded: number;
  /** Total the API reported, when it reported one. */
  expected?: number;
}
```

- [ ] **Step 2: Añadir los tipos y el envoltorio de dataset en la ruta**

Cerca de la cabecera del archivo, junto a los otros helpers de módulo (después de `enc()`, línea 209):

```ts
type StepStatus = "loading" | "retrying" | "done" | "partial" | "error";

interface DatasetOutcome<T> {
  key: string;
  records: T[];
  status: "done" | "partial" | "error";
  loaded: number;
  expected?: number;
}

// One GHL rate-limit window — the same pause fanOutPages uses between attempts.
const DATASET_RETRY_PAUSE_MS = 10_000;

// Run one dataset of the sync, emitting its step frames and applying the
// dataset-level safety net.
//
// Two distinct retry levels are in play. fanOutPages already retried individual
// failed pages, which handles the common case cheaply. This one only fires when
// the dataset came back with NOTHING salvageable — page 1 itself failed, so
// there was nothing for the page-level retry to work with.
//
// A dataset that legitimately holds zero records (missingPages empty) is NOT a
// failure and must not trigger the retry: that's a location with no pautas, not
// a broken fetch.
async function runDataset<T>(
  key: string,
  send: (obj: unknown) => void,
  fetcher: (onProgress: (count: number) => void) => Promise<PagedResult<T>>
): Promise<DatasetOutcome<T>> {
  const step = (status: StepStatus, count?: number) =>
    send({ type: "step", key, status, ...(count !== undefined ? { count } : {}) });

  const attempt = async (): Promise<PagedResult<T> | null> => {
    try {
      return await fetcher((count) => step("loading", count));
    } catch (err) {
      console.error(`[GHL] ${key} fetch failed:`, err);
      return null;
    }
  };

  let result = await attempt();

  const salvagedNothing = (r: PagedResult<T> | null) =>
    !r || (r.records.length === 0 && r.missingPages.length > 0);

  if (salvagedNothing(result)) {
    console.warn(`[GHL] ${key} came back empty — retrying the whole dataset once`);
    step("retrying");
    await new Promise((r) => setTimeout(r, DATASET_RETRY_PAUSE_MS));
    result = await attempt();
  }

  if (salvagedNothing(result)) {
    step("error", 0);
    return { key, records: [], status: "error", loaded: 0, expected: result?.total };
  }

  const r = result as PagedResult<T>;
  const status = r.missingPages.length > 0 ? "partial" : "done";
  step(status, r.records.length);
  return { key, records: r.records, status, loaded: r.records.length, expected: r.total };
}

// Datasets that don't paginate through fanOutPages still go through runDataset,
// so every step frame is produced in one place. They are complete by definition.
function asPaged<T>(records: T[]): PagedResult<T> {
  return { records, missingPages: [], missingEstimate: 0 };
}
```

Añadir los imports al principio del archivo. `SyncWarning` va en el bloque de tipos que ya se importa de `@/lib/types` (líneas 21-29):

```ts
import type { PagedResult } from "@/lib/paged-fetch";
```

```ts
import type {
  Contact,
  Opportunity,
  Call,
  Task,
  Pipeline,
  Pauta,
  Appointment,
  SyncWarning,
} from "@/lib/types";
```

- [ ] **Step 3: Hacer que `fetchAllPautas` propague la parcialidad**

Cambiar la firma y los dos `return` tempranos (líneas 219-275). La firma pasa a devolver `PagedResult<Pauta>`:

```ts
async function fetchAllPautas(
  onProgress?: (count: number) => void
): Promise<PagedResult<Pauta>> {
```

El `return []` de "schema no encontrado" (línea 231) pasa a:

```ts
      console.warn("[GHL] Pautas custom object schema not found");
      return { records: [], missingPages: [], missingEstimate: 0 };
```

El `records.map(...)` final (línea 253) se asigna en vez de devolverse directo:

```ts
    const pautas = records.map((r) => {
      // …cuerpo del map sin cambios…
    });

    return {
      records: pautas,
      total: paged.total,
      missingPages: paged.missingPages,
      missingEstimate: paged.missingEstimate,
    };
```

…lo que obliga a capturar el resultado completo en la línea 233:

```ts
    const paged = await getAllCustomObjectRecords(stub.key, onProgress);
    const records = paged.records;
```

Y el `catch` final (línea 271) deja de mentir con un array vacío limpio. Marca la página 1 como faltante para que `runDataset` lo trate como fallo y reintente:

```ts
  } catch (err) {
    console.error("[GHL] Pautas fetch failed:", err);
    return { records: [], missingPages: [1], missingEstimate: 0 };
  }
```

- [ ] **Step 4: Reemplazar el `Promise.all` por llamadas a `runDataset`**

Sustituir las líneas 454-492 (el bucle `for` que emite `loading`, y el `Promise.all` completo) por:

```ts
          send({ type: "progress", message: "Cargando datos de Lezgo Suite CRM…" });
          for (const k of ["contacts", "opportunities", "pautas", "appointments", "tasks"]) {
            sendStep(k, "loading", 0);
          }

          const [contactsOut, opportunitiesOut, pautasOut, appointmentsOut, tasksOut] =
            await Promise.all([
              runDataset("contacts", send, (onProgress) =>
                getAllContacts((count) => {
                  send({
                    type: "progress",
                    message: `Cargando contactos… ${count.toLocaleString("es-MX")}`,
                  });
                  onProgress(count);
                })
              ),
              runDataset("opportunities", send, (onProgress) =>
                getAllOpportunities((count) => {
                  send({
                    type: "progress",
                    message: `Cargando oportunidades… ${count.toLocaleString("es-MX")}`,
                  });
                  onProgress(count);
                })
              ),
              runDataset("pautas", send, (onProgress) => fetchAllPautas(onProgress)),
              runDataset("appointments", send, async () =>
                asPaged(await fetchAppointments(userMap))
              ),
              runDataset("tasks", send, async () =>
                asPaged((await searchLocationTasks()).map(transformTask))
              ),
            ]);

          const contactsRaw = contactsOut.records;
          const opportunitiesRaw = opportunitiesOut.records;
          const pautas = pautasOut.records;
          const appointments = appointmentsOut.records;
          const tasks = tasksOut.records;

          const warnings: SyncWarning[] = [
            contactsOut,
            opportunitiesOut,
            pautasOut,
            appointmentsOut,
            tasksOut,
          ]
            .filter((o) => o.status !== "done")
            .map((o) => ({
              key: o.key,
              kind: o.status as "partial" | "error",
              loaded: o.loaded,
              expected: o.expected,
            }));
```

Nota: `fetchAppointments` ya se traga sus propios errores y devuelve `[]`, así que un fallo suyo se ve como "cero citas legítimas" y no dispara reintento. Es el comportamiento que ya existía; cambiarlo queda fuera de este plan.

- [ ] **Step 5: Añadir `warnings` al frame `data`**

En el objeto de `send({ type: "data", ... })` (línea 612), después de `locationId: client.locationId,`:

```ts
            warnings,
```

- [ ] **Step 6: Verificar tipos**

```bash
npx tsc --noEmit
```

Esperado: sin errores. Ojo con el tipo de `contactsRaw` — se usa más abajo en el bucle de sintetizado de contactos (línea 528) y en el `console.warn` de la línea 565.

- [ ] **Step 7: Probar contra datos reales**

```bash
pnpm dev
```

Con las DevTools abiertas en la pestaña Network, abrir `/api/dashboard` y leer el stream NDJSON. Confirmar:
- salen frames `step` con `status: "done"` para los datasets sanos;
- el frame `data` incluye `warnings` (array vacío si todo fue bien);
- si algo falla, el paso correspondiente sale como `partial` o `error`, nunca como `done, 0`.

- [ ] **Step 8: Commit**

```bash
git add app/api/dashboard/route.ts
git commit -m "feat(sync): estados partial/error/retrying y warnings en el stream

done ya no significa las dos cosas: un dataset que falló se distingue de
uno legítimamente vacío. runDataset añade el reintento a nivel dataset
para el caso en que ni la página 1 llegó.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Hooks del cliente — tipos, `warnings`, `elapsedMs`, `stalled`

**Files:**
- Modify: `hooks/fetch-stream.ts:3-7` (`StreamStep`)
- Modify: `hooks/use-dashboard-data.ts` (`StepState`, `DashboardData`, el cuerpo del hook)

**Interfaces:**
- Consumes: los contratos de frame de la Task 3.
- Produces: para las Tasks 5 y 6, `useDashboardData()` devuelve además de lo actual:
  - `elapsedMs: number`
  - `stalled: boolean`
  - `data.warnings: SyncWarning[]` (`{ key: string; kind: "partial" | "error"; loaded: number; expected?: number }`)
  - `StepState["status"]` pasa a ser `"pending" | "loading" | "retrying" | "done" | "partial" | "error"`

- [ ] **Step 1: Ampliar `StreamStep` en `hooks/fetch-stream.ts`**

```ts
export interface StreamStep {
  key: string;
  status: "loading" | "retrying" | "done" | "partial" | "error";
  count?: number;
}
```

El resto del archivo no cambia: el `onStep` ya pasa `msg.status` tal cual.

- [ ] **Step 2: Ampliar los tipos en `hooks/use-dashboard-data.ts`**

```ts
export type StepStatus =
  | "pending"
  | "loading"
  | "retrying"
  | "done"
  | "partial"
  | "error";

export interface StepState {
  status: StepStatus;
  count?: number;
}
```

`SyncWarning` **no se redeclara aquí** — se reexporta desde `lib/types.ts` (Task 3, Step 1) para que los componentes lo importen del mismo sitio que el resto de tipos del hook:

```ts
import type { SyncWarning } from "@/lib/types";
export type { SyncWarning };
```

Y en `DashboardData`, después de `locationName: string;`:

```ts
  warnings?: SyncWarning[];
```

Es opcional para que un frame `data` sin el campo (por ejemplo de una pestaña que quedó abierta durante un deploy) no rompa el tipo.

- [ ] **Step 3: Añadir `elapsedMs` y `stalled` al hook**

Dentro de `useDashboardData`, junto a los otros `useState` (después de `const [steps, setSteps] = useState<StepMap>(INITIAL_STEPS)`, línea 69):

```ts
  const [elapsedMs, setElapsedMs] = useState(0);
  // Wall-clock of the last `step` frame. A sync that stops producing steps is
  // stuck waiting on GHL's rate limiter, which used to look identical to a dead
  // page — the counters just froze with no explanation.
  const lastStepAtRef = useRef<number>(Date.now());
  const startedAtRef = useRef<number>(Date.now());
```

Al principio de `load()`, junto a los otros resets (después de `setSteps(INITIAL_STEPS)`, línea 89):

```ts
    startedAtRef.current = Date.now();
    lastStepAtRef.current = Date.now();
    setElapsedMs(0);
```

En el callback `onStep` pasado a `fetchStream` (línea 97), registrar la llegada:

```ts
        (step) => {
          lastStepAtRef.current = Date.now();
          setSteps((prev) => ({
            ...prev,
            [step.key]: { status: step.status, count: step.count },
          }));
        }
```

Y un efecto que corre solo mientras carga, después del `useEffect` de montaje (línea 130):

```ts
  // Drives the elapsed-time readout and stall detection. Runs only while
  // loading, so an idle dashboard has no timer.
  useEffect(() => {
    if (!isLoading) return;
    const id = setInterval(() => setElapsedMs(Date.now() - startedAtRef.current), 1000);
    return () => clearInterval(id);
  }, [isLoading]);

  const stalled = isLoading && elapsedMs > 0 && Date.now() - lastStepAtRef.current > 15_000;
```

- [ ] **Step 4: Exponerlos en el return del hook**

```ts
  return {
    data,
    isLoading,
    isError,
    progress,
    locationName,
    steps,
    elapsedMs,
    stalled,
    refresh,
  };
```

- [ ] **Step 5: Verificar tipos**

```bash
npx tsc --noEmit
```

Esperado: sin errores. `useRef` ya está importado en la línea 3.

- [ ] **Step 6: Commit**

```bash
git add hooks/fetch-stream.ts hooks/use-dashboard-data.ts
git commit -m "feat(sync): el hook expone warnings, elapsedMs y stalled

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Pantalla de carga — estados nuevos, tiempo transcurrido, aviso de atasco

**Files:**
- Modify: `components/dashboard/loading-screen.tsx` (`LoadingScreenProps`, `FALLBACK_STEPS`, `StepRow`, `LoadingScreen`)
- Modify: `app/page.tsx:111` (pasar los props nuevos)

**Interfaces:**
- Consumes: `StepMap`, `StepStatus` de `hooks/use-dashboard-data` (Task 4).
- Produces: nada que consuman tareas posteriores.

- [ ] **Step 1: Ampliar los props**

```ts
interface LoadingScreenProps {
  progress: string
  /** Name of the GHL sub-account being opened. Empty until resolved. */
  locationName?: string
  /** Live per-dataset progress. All datasets load concurrently. */
  steps?: StepMap
  /** Milliseconds since the sync started. */
  elapsedMs?: number
  /** No step frame has arrived in >15s — GHL is throttling us. */
  stalled?: boolean
}
```

Importar `StepStatus` junto a los tipos ya importados en la línea 4:

```ts
import type { StepKey, StepMap, StepStatus } from "@/hooks/use-dashboard-data"
```

- [ ] **Step 2: Sustituir los booleanos de `StepRow` por una tabla de estados**

Reemplazar la firma y los dos booleanos de `StepRow` (líneas 90-102). El prop `status` pasa a `StepStatus`:

```ts
// Visual treatment per step state. `retrying` and `partial` are amber (the sync
// is coping), `error` is destructive (the dataset is gone). All three terminal
// states count toward the progress bar — the sync really did move on.
const STEP_STYLE: Record<
  StepStatus,
  { dot: string; label: string; note?: string; noteClass?: string }
> = {
  pending: {
    dot: "border border-border bg-muted/50 text-muted-foreground",
    label: "text-muted-foreground/60",
  },
  loading: {
    dot: "border-2 border-primary bg-primary/10 text-primary",
    label: "font-medium text-foreground",
  },
  retrying: {
    dot: "border-2 border-amber-500 bg-amber-500/10 text-amber-500",
    label: "font-medium text-foreground",
    note: "reintentando…",
    noteClass: "text-amber-500",
  },
  done: {
    dot: "bg-primary text-primary-foreground",
    label: "text-muted-foreground",
  },
  partial: {
    dot: "bg-amber-500 text-white",
    label: "text-muted-foreground",
    note: "parcial",
    noteClass: "text-amber-500",
  },
  error: {
    dot: "bg-destructive text-destructive-foreground",
    label: "text-muted-foreground",
    note: "error",
    noteClass: "text-destructive",
  },
}

function StepRow({
  label,
  status,
  count,
  delay,
}: {
  label: string
  status: StepStatus
  count?: number
  delay: number
}) {
  const style = STEP_STYLE[status]
  const isSettled = status === "done" || status === "partial" || status === "error"
  const isSpinning = status === "loading" || status === "retrying"
```

- [ ] **Step 3: Adaptar el ícono y la columna derecha de `StepRow`**

Reemplazar el cuerpo del `return` de `StepRow` (líneas 104-162) por:

```tsx
  return (
    <motion.div
      className="flex items-center gap-3"
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay, duration: 0.3 }}
    >
      <span
        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold transition-colors duration-300 ${style.dot}`}
      >
        {status === "done" || status === "partial" ? (
          <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M2 6l3 3 5-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : status === "error" ? (
          <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 3l6 6M9 3l-6 6" strokeLinecap="round" />
          </svg>
        ) : isSpinning ? (
          <motion.span
            className={`h-1.5 w-1.5 rounded-full ${status === "retrying" ? "bg-amber-500" : "bg-primary"}`}
            animate={{ scale: [1, 1.35, 1], opacity: [1, 0.6, 1] }}
            transition={{ duration: 1, repeat: Infinity }}
          />
        ) : (
          <span className="h-1 w-1 rounded-full bg-muted-foreground/40" />
        )}
      </span>

      <span className={`flex-1 text-sm transition-colors duration-300 ${style.label}`}>
        {label}
      </span>

      {/* Live count: running total while loading, final total when settled.
          Tabular numerals keep the column from jittering as digits change. */}
      <span className="flex min-w-[3.5rem] items-center justify-end gap-2 text-right text-xs tabular-nums">
        {style.note && (
          <span className={`text-[11px] font-medium ${style.noteClass}`}>{style.note}</span>
        )}
        {count !== undefined && (isSpinning || isSettled) ? (
          <motion.span
            key={`${status}-${count}`}
            className={isSettled ? "font-medium text-foreground" : "text-muted-foreground"}
            initial={{ opacity: 0.4 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.15 }}
          >
            {count.toLocaleString("es-MX")}
          </motion.span>
        ) : isSpinning ? (
          <span className="text-muted-foreground/60">…</span>
        ) : null}
      </span>
    </motion.div>
  )
}
```

- [ ] **Step 4: Contar los estados terminales en la barra de progreso**

En `LoadingScreen`, reemplazar el cálculo de `completed` (línea 169):

```ts
  const SETTLED: StepStatus[] = ["done", "partial", "error"]
  const completed = STEP_ROWS.filter((s) => SETTLED.includes(resolved[s.key].status)).length
```

- [ ] **Step 5: Añadir tiempo transcurrido y aviso de atasco**

Justo antes del `return` de `LoadingScreen`, añadir el formateador:

```ts
  const mmss = (ms: number) => {
    const total = Math.floor(ms / 1000)
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`
  }
```

Y reemplazar el bloque de la línea de progreso (líneas 258-272) por:

```tsx
            <div className="flex min-h-[1.25rem] items-center justify-between text-xs">
              <AnimatePresence mode="wait">
                <motion.span
                  key={stalled ? "stalled" : progress}
                  className={`max-w-[70%] truncate ${stalled ? "text-amber-500" : "text-muted-foreground"}`}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.2 }}
                >
                  {stalled
                    ? "Lezgo Suite CRM está limitando las solicitudes — esto puede tardar unos minutos"
                    : progress || "Sincronizando…"}
                </motion.span>
              </AnimatePresence>
              <span className="flex items-center gap-2 tabular-nums text-muted-foreground">
                {elapsedMs > 0 && <span>{mmss(elapsedMs)}</span>}
                <span>{pct}%</span>
              </span>
            </div>
```

…con la firma del componente ampliada:

```ts
export function LoadingScreen({
  progress,
  locationName,
  steps,
  elapsedMs = 0,
  stalled = false,
}: LoadingScreenProps) {
```

- [ ] **Step 6: Pasar los props desde `app/page.tsx`**

Línea 55, añadir al destructuring:

```ts
  const { data, isLoading, isError, progress, locationName, steps, elapsedMs, stalled, refresh } = useDashboardData({})
```

Línea 111:

```tsx
      {isInitialLoad && (
        <LoadingScreen
          key="loader"
          progress={progress}
          locationName={locationName}
          steps={steps}
          elapsedMs={elapsedMs}
          stalled={stalled}
        />
      )}
```

- [ ] **Step 7: Verificar tipos y ver la pantalla**

```bash
npx tsc --noEmit
```

Luego `pnpm dev` y recargar. Confirmar que la pantalla de carga muestra el contador `m:ss` avanzando y que los pasos terminan en palomita.

Para ver los estados nuevos sin esperar un fallo real, forzarlos temporalmente en `app/api/dashboard/route.ts` dentro de `runDataset`, justo antes del primer `attempt()`:

```ts
  if (key === "opportunities") {
    step("retrying");
    await new Promise((r) => setTimeout(r, 3000));
  }
```

Comprobar la fila ámbar con "reintentando…", **y quitar el bloque antes de commitear.**

- [ ] **Step 8: Commit**

```bash
git add components/dashboard/loading-screen.tsx app/page.tsx
git commit -m "feat(ui): la pantalla de carga muestra reintentos, parciales, errores y tiempo

Añade el aviso de atasco cuando no llega ningún frame en 15s — el hueco
exacto en el que los contadores se congelaban sin explicación.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Banner de datos incompletos

**Files:**
- Create: `components/dashboard/sync-warning-banner.tsx`
- Modify: `app/page.tsx` (import + montaje bajo el header)

**Interfaces:**
- Consumes: `SyncWarning` de `hooks/use-dashboard-data` (Task 4); `refresh()` de `useDashboardData`.
- Produces: nada.

- [ ] **Step 1: Crear el componente**

```tsx
"use client"

import { useState } from "react"
import { AlertTriangle, RefreshCw, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { SyncWarning } from "@/hooks/use-dashboard-data"

// Human labels + what the user actually loses when a dataset is missing. The
// consequence matters more than the dataset name: "oportunidades" means nothing
// to someone looking at an empty sales chart.
const DATASET_COPY: Record<string, { name: string; impact: string }> = {
  contacts: { name: "los contactos", impact: "Las gráficas de leads y origen quedan incompletas." },
  opportunities: { name: "las oportunidades", impact: "Las gráficas de ventas y conversión quedan incompletas." },
  pautas: { name: "las pautas", impact: "Las gráficas de campañas y pauta quedan incompletas." },
  appointments: { name: "las citas", impact: "Las gráficas de agenda quedan incompletas." },
  tasks: { name: "las tareas", impact: "Las gráficas de seguimiento quedan incompletas." },
}

function describe(w: SyncWarning): string {
  const copy = DATASET_COPY[w.key] ?? { name: `los datos de ${w.key}`, impact: "" }
  if (w.kind === "error") {
    return `No se pudieron cargar ${copy.name}. ${copy.impact}`.trim()
  }
  const of = w.expected ? ` de ~${w.expected.toLocaleString("es-MX")}` : ""
  return `Se cargaron ${w.loaded.toLocaleString("es-MX")}${of} ${copy.name.replace(/^(los|las) /, "")}. ${copy.impact}`.trim()
}

export function SyncWarningBanner({
  warnings,
  onRetry,
  isLoading,
}: {
  warnings: SyncWarning[]
  onRetry: () => void
  isLoading: boolean
}) {
  // Dismissal is per-render-session only: a fresh sync that still produces
  // warnings mounts a new banner, because silently hiding incomplete data is
  // the failure mode this whole component exists to prevent.
  const [dismissed, setDismissed] = useState(false)
  if (dismissed || warnings.length === 0) return null

  return (
    <div className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-2.5 sm:px-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-500" />
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="text-xs font-semibold text-amber-900 dark:text-amber-200">
            Datos incompletos en esta sincronización
          </p>
          {warnings.map((w) => (
            <p key={w.key} className="text-xs text-amber-800/90 dark:text-amber-200/80">
              {describe(w)}
            </p>
          ))}
        </div>
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 border-amber-500/40 bg-transparent text-xs text-amber-900 hover:bg-amber-500/15 dark:text-amber-200"
          onClick={onRetry}
          disabled={isLoading}
        >
          <RefreshCw className={`h-3 w-3 ${isLoading ? "animate-spin" : ""}`} />
          Reintentar
        </Button>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label="Descartar aviso"
          className="rounded p-1 text-amber-700/70 hover:bg-amber-500/15 dark:text-amber-300/70"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Montarlo en `app/page.tsx`**

Import junto a los otros de `components/dashboard` (después de la línea 14):

```ts
import { SyncWarningBanner } from "@/components/dashboard/sync-warning-banner"
```

Y justo **después** del cierre `</header>`, antes del contenido principal:

```tsx
      {data?.warnings && data.warnings.length > 0 && (
        <SyncWarningBanner
          warnings={data.warnings}
          onRetry={() => refresh()}
          isLoading={isLoading}
        />
      )}
```

- [ ] **Step 3: Verificar tipos**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Probar el banner**

Con `pnpm dev`, forzar un warning temporalmente en `app/api/dashboard/route.ts`, justo después de construir `warnings`:

```ts
          warnings.push({ key: "opportunities", kind: "partial", loaded: 13900, expected: 14078 })
```

Recargar y comprobar: el banner sale bajo el header, el texto dice "Se cargaron 13,900 de ~14,078 oportunidades…", el botón Reintentar dispara un sync nuevo y la X lo descarta. Probar también `kind: "error"`. Comprobar en tema claro y oscuro (el toggle está en el header). **Quitar la línea antes de commitear.**

- [ ] **Step 5: Commit**

```bash
git add components/dashboard/sync-warning-banner.tsx app/page.tsx
git commit -m "feat(ui): banner de datos incompletos con reintento

Un dataset caído ya no puede confundirse con un cero legítimo.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Verificación final y documentación

**Files:**
- Modify: `CLAUDE.md` (sección "Verification", sección "Loading & progress")

**Interfaces:** ninguna.

- [ ] **Step 1: Correr toda la verificación**

```bash
npx tsc --noEmit && pnpm verify:paged && pnpm verify:clients && pnpm verify:auth && pnpm verify:limiter && pnpm verify:attachments && pnpm lint
```

Esperado: todo pasa. Si algo falla, arreglarlo antes de seguir.

- [ ] **Step 2: Confirmar que no quedó código de prueba**

```bash
git diff main --stat
grep -rn "13900\|13,900" app components lib || echo "sin restos de prueba"
```

Revisar el diff completo de `app/api/dashboard/route.ts` en busca de los bloques temporales de las Tasks 5 y 6.

- [ ] **Step 3: Prueba real de punta a punta**

```bash
pnpm dev
```

Entrar a `localhost:3000` con la contraseña de VAEO y confirmar, apuntando los resultados:
- las oportunidades cargan con un conteo plausible (no 0);
- si algún dataset queda parcial, sale el banner con números correctos;
- el contador `m:ss` avanza durante la carga;
- **capturar del log del servidor cualquier línea `[GHL] page N failed:`** — con el arreglo puesto, ahora dice qué página y por qué. Ése es el dato que hasta hoy no existía y el que determina si además hay que subir `GHL_REQUEST_TIMEOUT_MS` o bajar el ritmo del limiter.

- [ ] **Step 4: Actualizar `CLAUDE.md`**

En la sección **"Verification (see below — there is no test framework)"**, añadir tras la línea de `verify:attachments`:

```
pnpm verify:paged        # lib/paged-fetch.ts — resiliencia del abanico de páginas
```

Y en el párrafo que enumera los módulos con script de verificación ("the pure modules where a silent bug would be…"), añadir `paged-fetch` a la lista de "silently wrong answer".

En la sección **"Loading & progress"**, actualizar la descripción del frame `step`:

```
- `{ type: "step", key, status, count }` — structured per-dataset progress. `key` ∈
  `config | contacts | opportunities | pautas | appointments | tasks`; `status` ∈
  `loading | retrying | done | partial | error`. `partial` means the dataset came back
  known-incomplete (some pages never landed) and `error` means it came back with nothing
  — neither is the same as a legitimate zero, which is `done` with `count: 0`. The `data`
  frame carries a matching `warnings[]` that drives the dashboard's amber banner.
```

- [ ] **Step 5: Commit y merge**

```bash
git add CLAUDE.md
git commit -m "docs: documentar verify:paged y los estados nuevos del stream

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Luego consultar al usuario antes de mergear a `main`.

---

### Task 8: ELIMINADA — refutada por medición

Esta tarea proponía subir el timeout por petición para las páginas profundas de
`/opportunities/search`, condicionada a que el log confirmara timeouts.

**El log lo refutó.** La medición contra la sub-cuenta real (`scripts/diag-paged-sync.ts`)
mostró que los fallos no son timeouts ni 429, sino un **400 determinista**:
`SEARCH_USE_START_AFTER_PAGINATION`. GHL corta la paginación por offset en 10,000
registros. Ningún timeout, por largo que sea, cambia eso.

La corrección real —migrar `getAllOpportunities` a cursor— se implementó dentro de la
Task 2. Verificada en Grupo VAEO: 11,793 de 11,793 oportunidades, 14,085 de 14,085
contactos, cero páginas faltantes.

---

## Notas de riesgo

**El reintento a nivel dataset añade latencia en el peor caso.** Si un dataset falla del todo, el sync tarda 10s de pausa más el tiempo del segundo intento. Es aceptable porque solo ocurre en el camino de fallo, que hoy simplemente devuelve datos falsos; pero si aparece un patrón de fallos frecuentes, `DATASET_RETRY_PAUSE_MS` es el dial.

**`fetchAppointments` sigue tragándose sus errores.** Devuelve `[]` ante cualquier fallo, así que un fallo real se ve como "cero citas" y no dispara ni reintento ni warning. Es el comportamiento previo y queda fuera de alcance, pero es el siguiente hueco del mismo tipo si algún día las citas salen vacías sin explicación.

**Las Tasks 1-7 no atacan la causa raíz, y es deliberado.** Reducen el daño de cualquiera de los cuatro candidatos del spec a una página, y por primera vez dejan en el log qué página falló y por qué. La Task 8 sí ataca la causa, pero está condicionada a que el log la confirme — implementarla a ciegas sería adivinar.

**Si la Task 8 se ejecuta, el sync de cuentas grandes puede tardar más en el peor caso.** Un timeout de 90s en la página más profunda significa que una página genuinamente rota tarda 90s en rendirse, ×5 intentos. El abanico corre en paralelo, así que no se suman, pero el dataset no termina hasta que la última página se resuelva. Vigilar la duración total en la Task 8, Step 4.

**Migrar `/opportunities/search` a cursor sigue siendo la solución de fondo.** El timeout escalado de la Task 8 es una curita sobre un endpoint que se degrada con la profundidad; a 30k oportunidades volverá a quedarse corto. Antes de planear la migración hay que verificar contra `GHL-API-Schemas.md` si ese endpoint soporta paginación por cursor.
