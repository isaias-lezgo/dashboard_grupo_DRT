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

// ============ OFFSET WALK WITH A CAP ============
//
// Para endpoints que paginan por `skip`/`limit` y NO reportan un total —
// /locations/:id/tasks/search es el caso. El tope existe como freno de
// emergencia, no como presupuesto: acota una cuenta desbocada sin que nadie
// tenga que adivinar cuántos registros hay.
//
// Lo que este helper agrega sobre un `while` a mano es saber DECIR si se quedó
// corto. Y ahí está la sutileza que motivó extraerlo: llegar al tope con una
// página llena NO implica que falten datos. Si la cuenta tiene exactamente
// `cap` registros, el recorrido termina justo en el tope y está completo. Una
// sonda de un solo registro distingue los dos casos, y solo se paga cuando el
// tope se alcanza.

export interface OffsetWalkOptions<T> {
  /** Una página. `limit` puede venir en 1 cuando es la sonda del final. */
  fetchPage: (skip: number, limit: number) => Promise<T[]>;
  pageSize: number;
  /** Freno de emergencia, en registros. */
  cap: number;
}

export interface OffsetWalkResult<T> {
  records: T[];
  /** true SOLO si se comprobó que quedaron registros sin traer. */
  truncated: boolean;
}

export async function walkOffsetPages<T>({
  fetchPage,
  pageSize,
  cap,
}: OffsetWalkOptions<T>): Promise<OffsetWalkResult<T>> {
  const records: T[] = [];
  let skip = 0;

  for (;;) {
    const batch = await fetchPage(skip, pageSize);
    records.push(...batch);

    // Página corta ⇒ se acabaron los datos. Única salida limpia y barata.
    if (batch.length < pageSize) return { records, truncated: false };

    skip += pageSize;

    if (records.length >= cap) {
      // Se alcanzó el tope con una página llena. Puede que no haya nada más:
      // preguntamos por UN registro en vez de asumir. Asumir que sí falta
      // dispara un aviso falso; asumir que no, esconde datos perdidos.
      const probe = await fetchPage(skip, 1);
      return { records, truncated: probe.length > 0 };
    }
  }
}

// ============ CURSOR WALK ============
//
// GHL caps offset pagination at 10,000 records: /opportunities/search answers
// pages 1-100 and then returns, forever and deterministically,
//   400 SEARCH_USE_START_AFTER_PAGINATION
//   "Please use startAfter and startAfterId for pagination."
// That is why a 14k-opportunity sub-account could never load past 10,000 no
// matter how many times it retried — and why contacts, which already walked by
// cursor, never had the problem.
//
// A cursor walk cannot fan out (each page's cursor comes from the previous one)
// and cannot retry a single page (the position of a missing stretch is
// unknowable from here — a retry would duplicate or skip an arbitrary run). What
// it CAN do is keep everything collected so far when a hop fails, instead of
// letting the exception discard the whole walk.

export interface CursorWalkOptions<T, C> {
  /** Fetch one page. `cursor` is undefined on the first hop. */
  fetchPage: (cursor: C | undefined) => Promise<{
    records: T[];
    /** Total the API reports. Read from the first hop that supplies one. */
    total?: number;
    /** Cursor for the next hop. Undefined ends the walk. */
    next?: C;
  }>;
  /** Stable identity — cursor pages sometimes overlap. */
  idOf: (record: T) => string;
  /** A short page means the end of the data. */
  pageSize: number;
  /** Label used in the failure log, e.g. "Opportunities". */
  label: string;
  onProgress?: (count: number) => void;
}

export async function cursorWalk<T, C>({
  fetchPage,
  idOf,
  pageSize,
  label,
  onProgress,
}: CursorWalkOptions<T, C>): Promise<PagedResult<T>> {
  const records: T[] = [];
  const seen = new Set<string>();
  let cursor: C | undefined;
  let total: number | undefined;
  let hop = 1;
  let truncated = false;

  try {
    for (;;) {
      const page = await fetchPage(cursor);
      if (total === undefined && page.total !== undefined) total = page.total;

      let fresh = 0;
      for (const r of page.records) {
        const id = idOf(r);
        if (seen.has(id)) continue;
        seen.add(id);
        records.push(r);
        fresh++;
      }
      onProgress?.(records.length);

      // Done: got everything, or the API returned a short page.
      if ((total !== undefined && records.length >= total) || page.records.length < pageSize) {
        break;
      }
      // A whole page of duplicates means the cursor is stuck — bail out rather
      // than loop forever.
      if (fresh === 0) break;
      // No next cursor to follow.
      if (page.next === undefined) break;

      cursor = page.next;
      hop++;
    }
  } catch (err) {
    console.error(`[GHL] ${label} cursor walk failed at hop ${hop} (kept ${records.length}):`, err);
    truncated = true;
  }

  return {
    records,
    total,
    missingPages: truncated ? [hop] : [],
    missingEstimate:
      truncated && total !== undefined ? Math.max(0, total - records.length) : 0,
  };
}
