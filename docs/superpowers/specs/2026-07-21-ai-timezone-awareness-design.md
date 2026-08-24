# AI timezone awareness — design

**Date:** 2026-07-21
**Status:** Approved for planning

## Problem

The AI assistant reasons and reports dates/times in **UTC**, while the dashboard's
clients operate in Mexico (UTC-6). The visible symptoms:

- The AI narrates day boundaries in UTC ("las pautas del 21 de julio van de 00:00 a
  23:59 UTC") and offers to "recalculate" with a UTC-6 shift.
- When the AI buckets records "por día" from raw `createdAt` timestamps, it uses the
  **UTC date portion**, so a pauta at `2026-07-21T00:41Z` (which is `2026-07-20 18:41`
  in Mexico) lands on the wrong day.

### Current state (half-built plumbing)

- ✅ `hooks/use-agent-loop.ts` already detects the browser IANA timezone
  (`Intl.DateTimeFormat().resolvedOptions().timeZone`, fallback `America/Mexico_City`)
  and sends it to `/api/chat` as `userTimezone`.
- ✅ `app/api/chat/route.ts` already localizes the injected **"Hoy es …"** line to
  that timezone.
- ❌ The AI is never *told* which timezone it operates in, so it defaults to reasoning
  and reporting in UTC.
- ❌ Date-filter boundaries (`dateBound` in `lib/ai-tools.ts`) build day edges with
  `new Date(y, mo-1, d, …)` in the **browser's ambient** timezone, not the explicit
  `userTimezone`. This happens to work for a Mexico browser but gives UTC edges for
  any other machine, with no real GMT-6 fallback.
- Note: there is **no** executor-side time bucketing — `aggregate`/`relate` group by
  categorical fields only. The AI does day/week bucketing itself from raw timestamps,
  which is the second half of the symptom.

## Goal

Make the AI reason, filter, and report in the **connected user's timezone**
(browser-detected), falling back to `America/Mexico_City` (UTC-6) when unavailable.
The detected `userTimezone` value becomes the single source of truth used in both the
prompt context and the filter boundaries.

## Design

### 1. Tell the AI its operating timezone (fixes reasoning/reporting/self-bucketing)

In `app/api/chat/route.ts`, enrich the injected context block. Today it is:

```
Hoy es ${today}.
```

Change it to include the current date **and time**, the named zone with its UTC
offset, and an explicit instruction about how to interpret stored timestamps:

- Current local datetime rendered in `tz` (weekday, date, and `HH:mm`).
- The IANA zone name and its current numeric offset (e.g. `America/Mexico_City,
  UTC-6`), derived from `tz` rather than hard-coded.
- A one-line rule: all stored timestamps (`createdAt`, `closedAt`, `startTime`,
  `dueDate`, …) are in **UTC**; interpret them, and bucket "por día/semana/mes", in
  this timezone — not UTC. When expressing date filters, pass plain `YYYY-MM-DD`
  boundaries (the system already resolves them in this same zone).

The offset string is computed from `tz` with `Intl` so it stays correct for any zone
and any DST state; it is not hard-coded to `-6`.

### 2. Make filter boundaries explicitly timezone-aware (fixes filtering)

Thread the `userTimezone` into the client-side executor so date-only filter edges are
resolved in the **named** zone instead of the browser's ambient zone.

- `hooks/use-agent-loop.ts` passes the already-computed `userTimezone` into
  `executeTool(...)` (and the other executor entry points that resolve filters).
- `lib/ai-tools.ts`: `executeTool` accepts a `timeZone` argument (default
  `America/Mexico_City`) and threads it to the filter helpers so `dateBound` can use
  it. `dateBound` converts a `YYYY-MM-DD` edge (`00:00:00.000` for a lower bound,
  `23:59:59.999` for an upper bound) to the correct **UTC instant for that named
  zone**, DST-aware via `Intl` (Mexico is now a stable UTC-6, but the helper stays
  general). Strings that already carry a time component are still parsed as-is.

The conversion uses the standard "guess UTC, then correct by the zone's offset at that
instant" technique via `Intl.DateTimeFormat` `formatToParts`, so no external date
library is added.

### Out of scope (YAGNI)

- **Not** rewriting the raw timestamps returned to the AI into local time. The prompt
  rule in step 1 governs interpretation; rewriting every row is invasive and would
  churn the cached dataset summary for no added correctness.
- **Not** adding executor-side time bucketing (`groupBy: 'day'`), since none exists
  today and the AI's own bucketing is corrected by step 1.
- **Not** changing the non-AI dashboard views (`lib/date-range.ts` filtering); this
  spec is scoped to the AI assistant path only.

## Affected files

- `app/api/chat/route.ts` — enrich the injected datetime/timezone context block;
  derive the offset string from `tz`.
- `lib/ai-tools.ts` — `dateBound`/`startBound`/`endBound` become timezone-aware;
  `executeTool` (and filter helpers) accept and thread a `timeZone` argument.
- `hooks/use-agent-loop.ts` — pass the existing `userTimezone` into `executeTool`.

## Verification

No test framework in this repo; verify by driving the real app:

1. `npx tsc --noEmit` — must pass (build ignores TS errors, so this is required).
2. In the AI tab, ask a day-boundary question that straddles UTC-6 midnight (e.g.
   "¿cuántas pautas del 21 de julio?") and confirm the count and the AI's narration
   are in Mexico local time, and that a record at `…T00:41Z` on the 21st is attributed
   to the 20th.
3. Confirm the injected context shows the correct local date/time and zone offset.
