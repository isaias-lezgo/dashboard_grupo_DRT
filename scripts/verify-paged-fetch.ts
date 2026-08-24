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
import { fanOutPages, cursorWalk, walkOffsetPages } from "../lib/paged-fetch";

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

  // ---------------------------------------------------------------- cursorWalk
  //
  // Cursor pagination is what GHL demands past 10,000 records
  // (400 SEARCH_USE_START_AFTER_PAGINATION). It cannot fan out and cannot retry
  // a hop, so the property that matters is: a failed hop keeps what it already
  // collected instead of throwing the walk away.

  // Build a cursor-paginated source over `total` rows, optionally breaking at a
  // given hop number.
  function makeCursorSource(opts: { total: number; pageSize: number; failAtHop?: number }) {
    let hop = 0;
    const fetchPage = async (cursor: number | undefined) => {
      hop++;
      if (opts.failAtHop === hop) throw new Error(`hop ${hop} exploded`);
      const start = cursor ?? 0;
      const records = Array.from(
        { length: Math.max(0, Math.min(opts.pageSize, opts.total - start)) },
        (_, i) => ({ id: `r${start + i}` })
      );
      const nextStart = start + records.length;
      return {
        records,
        total: opts.total,
        next: nextStart < opts.total ? nextStart : undefined,
      };
    };
    return { fetchPage };
  }

  // --- walks the whole set, past any offset ceiling
  {
    const { fetchPage } = makeCursorSource({ total: 11793, pageSize: 100 });
    const res = await cursorWalk<Row, number>({
      fetchPage,
      idOf,
      pageSize: 100,
      label: "Test",
    });
    assert.equal(res.records.length, 11793, "cursor walk collected every row");
    assert.deepEqual(res.missingPages, [], "complete walk reports nothing missing");
    assert.equal(res.missingEstimate, 0);
  }

  // --- THE PROPERTY: a hop that throws keeps everything collected so far.
  // Before this, the exception propagated and the caller got nothing.
  {
    const { fetchPage } = makeCursorSource({ total: 11793, pageSize: 100, failAtHop: 40 });
    const res = await cursorWalk<Row, number>({
      fetchPage,
      idOf,
      pageSize: 100,
      label: "Test",
    });
    assert.equal(res.records.length, 3900, "kept the 39 hops that landed");
    assert.deepEqual(res.missingPages, [40], "reports the hop it broke on");
    assert.equal(res.missingEstimate, 11793 - 3900, "estimate is the untraversed tail");
  }

  // --- failing on the very first hop yields an empty-but-flagged result, which
  // is what lets the route tell "broken" apart from "legitimately zero".
  {
    const { fetchPage } = makeCursorSource({ total: 500, pageSize: 100, failAtHop: 1 });
    const res = await cursorWalk<Row, number>({
      fetchPage,
      idOf,
      pageSize: 100,
      label: "Test",
    });
    assert.equal(res.records.length, 0);
    assert.deepEqual(res.missingPages, [1], "flagged, not silently empty");
  }

  // --- a legitimately empty source is NOT flagged
  {
    const { fetchPage } = makeCursorSource({ total: 0, pageSize: 100 });
    const res = await cursorWalk<Row, number>({
      fetchPage,
      idOf,
      pageSize: 100,
      label: "Test",
    });
    assert.equal(res.records.length, 0);
    assert.deepEqual(res.missingPages, [], "empty is not the same as broken");
  }

  // --- a stuck cursor (same page forever) terminates instead of looping
  {
    const stuck = Array.from({ length: 100 }, (_, i) => ({ id: `s${i}` }));
    let calls = 0;
    const res = await cursorWalk<Row, number>({
      fetchPage: async () => {
        calls++;
        return { records: stuck, total: 5000, next: 1 };
      },
      idOf,
      pageSize: 100,
      label: "Test",
    });
    assert.equal(res.records.length, 100, "absorbed the one distinct page");
    assert.equal(calls, 2, "bailed out on the first all-duplicate page");
  }

  // ============ walkOffsetPages — el recorrido por offset con tope ============
  //
  // Este bloque nace de un falso positivo observado en producción: el panel
  // avisó "Tareas · parcial · 638" y la pregunta era si el aviso decía la
  // verdad. Resultó que sí (1,154 completadas contra un tope de 500), pero al
  // trazarlo apareció que el tope NO sabía distinguir "me quedé corto" de
  // "terminé justo en el tope". Un aviso que se equivoca en cualquiera de los
  // dos sentidos es igual de inútil: o esconde datos faltantes, o acusa de
  // faltantes unos datos completos.

  // Fetcher por offset sobre `total` filas sintéticas. Cuenta las llamadas para
  // poder afirmar que la sonda solo se dispara cuando hace falta.
  function offsetFetcher(total: number) {
    const calls: Array<{ skip: number; limit: number }> = [];
    const fetchPage = async (skip: number, limit: number) => {
      calls.push({ skip, limit });
      return Array.from(
        { length: Math.max(0, Math.min(limit, total - skip)) },
        (_, i) => ({ id: `r${skip + i}` })
      );
    };
    return { fetchPage, calls };
  }

  // --- recorrido completo, sin acercarse al tope
  {
    const { fetchPage, calls } = offsetFetcher(138);
    const res = await walkOffsetPages<Row>({ fetchPage, pageSize: 100, cap: 5000 });
    assert.equal(res.records.length, 138);
    assert.equal(res.truncated, false, "138 de 138: nada quedó fuera");
    assert.equal(calls.length, 2, "página corta termina el recorrido");
  }

  // --- el tope corta de verdad: quedan datos sin traer
  {
    const { fetchPage, calls } = offsetFetcher(1154);
    const res = await walkOffsetPages<Row>({ fetchPage, pageSize: 100, cap: 500 });
    assert.equal(res.records.length, 500, "se detuvo en el tope");
    assert.equal(res.truncated, true, "y quedaban 654 sin traer");
    assert.equal(calls.at(-1)!.limit, 1, "la última llamada es la sonda barata");
  }

  // --- EL CASO QUE FALLABA: el dato termina EXACTAMENTE en el tope
  {
    const { fetchPage } = offsetFetcher(500);
    const res = await walkOffsetPages<Row>({ fetchPage, pageSize: 100, cap: 500 });
    assert.equal(res.records.length, 500);
    assert.equal(
      res.truncated,
      false,
      "500 de 500 está COMPLETO — llegar al tope no es lo mismo que quedarse corto"
    );
  }

  // --- un solo registro después del tope sí cuenta como truncado
  {
    const { fetchPage } = offsetFetcher(501);
    const res = await walkOffsetPages<Row>({ fetchPage, pageSize: 100, cap: 500 });
    assert.equal(res.truncated, true, "501 contra un tope de 500 sí está cortado");
  }

  // --- la sonda NO se dispara cuando el recorrido terminó solo
  {
    const { fetchPage, calls } = offsetFetcher(138);
    await walkOffsetPages<Row>({ fetchPage, pageSize: 100, cap: 5000 });
    assert.ok(
      calls.every((c) => c.limit === 100),
      "sin llegar al tope no se paga la petición extra"
    );
  }

  // --- conjunto vacío
  {
    const { fetchPage, calls } = offsetFetcher(0);
    const res = await walkOffsetPages<Row>({ fetchPage, pageSize: 100, cap: 500 });
    assert.equal(res.records.length, 0);
    assert.equal(res.truncated, false, "vacío no es lo mismo que cortado");
    assert.equal(calls.length, 1);
  }

  // --- el total es un múltiplo exacto del tamaño de página, sin tope de por medio
  {
    const { fetchPage } = offsetFetcher(300);
    const res = await walkOffsetPages<Row>({ fetchPage, pageSize: 100, cap: 5000 });
    assert.equal(res.records.length, 300);
    assert.equal(res.truncated, false, "una página vacía al final cierra el recorrido");
  }

  console.log("verify-paged-fetch: all assertions passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
