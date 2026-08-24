# Resumen de ventas por sucursal y servicio — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first VAEO chart — a pivot table of won opportunities, rows = month of
"Fecha de Cierre", columns = Sucursal › Servicio, values = summed monetary value.

**Architecture:** Three layers, each independently verifiable. (1) A one-line fix in the
API transform so DATE custom fields reach the browser at all. (2) Two pure `lib/` modules —
`panel-scope.ts` (which pipeline/sucursal field a panel means) and `sales-pivot.ts` (the
aggregation), both covered by an assertion script. (3) A dumb presentational component that
renders the pivot and wires a drill-down, plus the `dateRange` prop it needs from
`app/page.tsx`.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Tailwind CSS v3, shadcn/ui,
`tsx` + `node:assert/strict` for verification, pnpm.

**Spec:** `docs/superpowers/specs/2026-08-04-resumen-ventas-sucursal-servicio-design.md`

## Global Constraints

- **Package manager is pnpm.** Never run `npm install`. Use `pnpm install` / `pnpm add`.
- **No test framework.** Verification is `scripts/verify-*.ts` run through `tsx`, using
  `node:assert/strict`. There is no way to run a single assertion — the script is the unit.
- **This package is CommonJS.** `tsx` compiles to CJS, so **top-level `await` fails**. Wrap
  async work in `main()` and call `main().catch(...)`. (The scripts in this plan are
  synchronous, but keep the `main()` shape to match the existing ones.)
- **`npx tsc --noEmit` is REQUIRED before any commit that touches TypeScript.** `next build`
  ignores TypeScript errors (`next.config.mjs`), so a green build proves nothing.
- **Never re-inline shared domain logic.** "Won" detection is `isWonOpp()` from
  `lib/opportunity-status.ts` — do not write a second copy.
- **Drill-downs resolve joins against the unfiltered `all*` sets**, never the date-filtered
  slice.
- **Never nest a Radix `ScrollArea` inside a card** — it breaks `truncate`. Use a plain
  `overflow-x-auto` div.
- **Keep `VaeoDashboardProps` and `MeshDashboardProps` identical.** Any prop added to one is
  added to the other in the same commit.
- GHL DATE custom fields are **UTC midnight epoch-ms**. Bucket them with UTC getters
  (`getUTCFullYear` / `getUTCMonth`), never local ones.
- All user-facing copy is in **Spanish**.

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `app/api/dashboard/route.ts` | Modify (`resolveCustomFields`, ~line 57) | Read `fieldValueDate` and normalize epoch-ms → ISO |
| `lib/panel-scope.ts` | Create | Which pipeline + sucursal field each panel means |
| `lib/sales-pivot.ts` | Create | Pure aggregation: won opps → pivot rows/columns |
| `scripts/verify-sales-pivot.ts` | Create | Assertions for both `lib/` modules |
| `package.json` | Modify (`scripts`) | Add `verify:pivot` |
| `components/dashboard/sales-pivot-table.tsx` | Create | Renders the pivot + drill-down |
| `components/dashboard/vaeo-dashboard.tsx` | Modify | Add `dateRange` prop, render the table |
| `components/dashboard/mesh-dashboard.tsx` | Modify | Add `dateRange` prop (props stay mirrored) |
| `app/page.tsx` | Modify (~line 298 and ~line 319) | Pass `dateRange` to both dashboards |
| `CLAUDE.md` | Modify | Document the new modules and the `fieldValueDate` fix |

---

### Task 1: Let DATE custom fields reach the browser

Without this, `Fecha de Cierre` is silently dropped by the transform and every later task
aggregates over nothing. Nothing else in the app reads a DATE custom field today, so this
is a pure addition.

**Files:**
- Modify: `app/api/dashboard/route.ts:57-80` (`resolveCustomFields`)
- Test: `scripts/verify-sales-pivot.ts` — not yet; this task is verified by driving the API
  route, because `resolveCustomFields` is module-private to the route.

**Interfaces:**
- Consumes: nothing.
- Produces: `Opportunity.customFieldsResolved["Fecha de Cierre"]` as an **ISO 8601 string**
  (e.g. `"2026-08-01T00:00:00.000Z"`) on opportunities that have the field set.

- [ ] **Step 1: Read the current function**

Read `app/api/dashboard/route.ts:57-80`. The relevant line is:

```ts
const raw = f.fieldValue ?? f.fieldValueString ?? f.value;
```

Opportunity DATE fields arrive as neither of those three:

```json
{ "id": "HKCsyPAL0NeTAoIrVDl4", "fieldValueDate": 1785801600000, "type": "date" }
```

- [ ] **Step 2: Widen the parameter type**

Add `fieldValueDate` to the inline parameter type on line 58:

```ts
function resolveCustomFields(
  fields:
    | Array<{
        id: string;
        value?: unknown;
        fieldValue?: unknown;
        fieldValueString?: unknown;
        fieldValueDate?: unknown;
      }>
    | undefined,
  map: Map<string, string>
): Record<string, string | string[]> {
```

- [ ] **Step 3: Read and normalize the date**

Replace the `const raw = ...` line and add normalization immediately after the
`if (raw === undefined || raw === null) continue;` guard:

```ts
    // GHL DATE fields use fieldValueDate (epoch ms, UTC midnight) — none of the
    // three keys above. Normalized to ISO here so consumers never have to know
    // the field was a date; customFieldsResolved stays string-valued.
    const raw = f.fieldValue ?? f.fieldValueString ?? f.value ?? f.fieldValueDate;
    if (raw === undefined || raw === null) continue;
    if (f.fieldValueDate != null && raw === f.fieldValueDate) {
      const ms = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(ms)) continue;
      result[name] = new Date(ms).toISOString();
      continue;
    }
```

Leave the existing array / string branches below untouched.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output (exit 0).

- [ ] **Step 5: Verify against the live sync**

Run `pnpm dev`, log in, and open the browser devtools console on the dashboard. In the
Network tab find the `/api/dashboard` NDJSON response, and confirm the final `data` frame
has opportunities carrying `customFieldsResolved["Fecha de Cierre"]` with an ISO string.

Expected: at least a few hundred VAEO opportunities have the field (645 of 648 won ones did
when the spec was written). If **zero** do, stop — the field id or the transform path
changed and the rest of the plan rests on this.

- [ ] **Step 6: Commit**

```bash
git add app/api/dashboard/route.ts
git commit -m "fix(sync): resolver campos DATE de GHL (fieldValueDate)"
```

---

### Task 2: `lib/panel-scope.ts` — which pipeline a panel means

**Files:**
- Create: `lib/panel-scope.ts`
- Test: `scripts/verify-sales-pivot.ts` (created in Task 4)

**Interfaces:**
- Consumes: `Opportunity`, `Pipeline` from `lib/types.ts`.
- Produces:
  - `type PanelId = "vaeo" | "mesh"`
  - `PANEL_SCOPES: Record<PanelId, { label: string; pipelineId: string; sucursalField: string }>`
  - `resolvePipelineId(pipelines: Pipeline[] | undefined, panel: PanelId): string`
  - `scopeOpportunities(opps: Opportunity[], panel: PanelId, pipelines?: Pipeline[]): Opportunity[]`

- [ ] **Step 1: Write the module**

```ts
// Single source of truth for what each business-line panel *is*.
//
// In this deployment the pipeline IS the business line: every chart in the VAEO
// tab counts only opportunities in the VAEO pipeline, and likewise for MESH.
// Both pipelines live in the same GHL sub-account, so the split is client-side.
//
// The sucursal lives in a DIFFERENT custom field per panel ("Sucursal VAEO" vs
// "Sucursal MESH"), which is why the field name is part of the scope and not
// hardcoded in a chart.
import type { Opportunity, Pipeline } from "./types"

export type PanelId = "vaeo" | "mesh"

export interface PanelScope {
  /** Pipeline name as it reads in GHL; also the matching key. */
  label: string
  /** Fallback only — used when no pipeline matches by name. */
  pipelineId: string
  /** Name of the opportunity custom field holding the branch. */
  sucursalField: string
}

export const PANEL_SCOPES: Record<PanelId, PanelScope> = {
  vaeo: {
    label: "VAEO",
    pipelineId: "MiATYfkJWklaXqYc7hOr",
    sucursalField: "Sucursal VAEO",
  },
  mesh: {
    label: "MESH",
    pipelineId: "DkZiRWdizgMRt7osjuRb",
    sucursalField: "Sucursal MESH",
  },
}

/**
 * Resolve the panel's pipeline id, preferring a NAME match over the hardcoded
 * id. Same reasoning as isWonOpp()'s stage matching: a pipeline that gets
 * recreated keeps its name but not its id.
 */
export function resolvePipelineId(
  pipelines: Pipeline[] | undefined,
  panel: PanelId
): string {
  const scope = PANEL_SCOPES[panel]
  const match = pipelines?.find(
    (p) => p.name.trim().toLowerCase() === scope.label.toLowerCase()
  )
  return match?.id ?? scope.pipelineId
}

/** Every opportunity that belongs to this panel's business line. */
export function scopeOpportunities(
  opps: Opportunity[],
  panel: PanelId,
  pipelines?: Pipeline[]
): Opportunity[] {
  const pipelineId = resolvePipelineId(pipelines, panel)
  return opps.filter((o) => o.pipelineId === pipelineId)
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add lib/panel-scope.ts
git commit -m "feat(lib): panel-scope — el pipeline define la línea de negocio"
```

---

### Task 3: `lib/sales-pivot.ts` — the aggregation

**Files:**
- Create: `lib/sales-pivot.ts`
- Test: `scripts/verify-sales-pivot.ts` (created in Task 4)

**Interfaces:**
- Consumes: `Opportunity` from `lib/types.ts`; `isWonOpp` from `lib/opportunity-status.ts`;
  `PanelScope["sucursalField"]` from Task 2.
- Produces:
  - `CLOSE_DATE_FIELD = "Fecha de Cierre"`, `SERVICIO_FIELD = "Servicio"`
  - `NO_SUCURSAL = "Sin sucursal"`, `NO_SERVICIO = "Sin servicio"`, `NO_DATE_KEY = "sin-fecha"`
  - `closeDateOf(opp: Opportunity): string | undefined` — the ISO close date, or undefined
  - `interface PivotCell { value: number; oppIds: string[] }`
  - `interface PivotColumn { key: string; sucursal: string; servicio: string; kind: "cell" | "subtotal" | "total" }`
  - `interface PivotRow { key: string; label: string; kind: "month" | "no-date" | "total"; cells: PivotCell[] }`
  - `interface SalesPivot { columns: PivotColumn[]; rows: PivotRow[]; grandTotal: number }`
  - `buildSalesPivot(opps: Opportunity[], opts: { sucursalField: string }): SalesPivot`

- [ ] **Step 1: Write the module**

```ts
// Aggregation behind the "Resumen general de ventas" pivot table: won
// opportunities laid out as month-of-close (rows) × sucursal › servicio
// (columns), summing monetary value.
//
// Pure and React-free so it can be asserted by scripts/verify-sales-pivot.ts —
// a silently wrong number here is invisible in the UI, which is exactly the
// class of bug the verify scripts exist for.
import type { Opportunity } from "./types"
import { isWonOpp } from "./opportunity-status"

export const CLOSE_DATE_FIELD = "Fecha de Cierre"
export const SERVICIO_FIELD = "Servicio"

export const NO_SUCURSAL = "Sin sucursal"
export const NO_SERVICIO = "Sin servicio"
export const NO_DATE_KEY = "sin-fecha"
export const NO_DATE_LABEL = "Sin fecha de cierre"
export const TOTAL_KEY = "total"

export interface PivotCell {
  value: number
  oppIds: string[]
}

export interface PivotColumn {
  /** Stable key: `${sucursal}||${servicio}` for cells, `sub||${sucursal}` for
   *  subtotals, `total` for the grand-total column. */
  key: string
  sucursal: string
  servicio: string
  kind: "cell" | "subtotal" | "total"
}

export interface PivotRow {
  key: string
  label: string
  kind: "month" | "no-date" | "total"
  /** One entry per column, same order and length as `columns`. */
  cells: PivotCell[]
}

export interface SalesPivot {
  columns: PivotColumn[]
  rows: PivotRow[]
  grandTotal: number
}

const MONTHS_ES = [
  "ene", "feb", "mar", "abr", "may", "jun",
  "jul", "ago", "sep", "oct", "nov", "dic",
]

function cfString(v: string | string[] | undefined): string {
  const s = Array.isArray(v) ? v[0] : v
  return (s ?? "").trim()
}

/** The opportunity's close date as an ISO string, or undefined if unset. */
export function closeDateOf(opp: Opportunity): string | undefined {
  const raw = cfString(opp.customFieldsResolved?.[CLOSE_DATE_FIELD])
  if (!raw) return undefined
  const t = new Date(raw).getTime()
  return Number.isNaN(t) ? undefined : raw
}

// GHL stores DATE fields at UTC midnight, so the month MUST be read in UTC.
// With a local (America/Mexico_City) reading, a close on the 1st at 00:00Z
// lands on the previous month.
function monthKeyOf(iso: string): string {
  const d = new Date(iso)
  const m = String(d.getUTCMonth() + 1).padStart(2, "0")
  return `${d.getUTCFullYear()}-${m}`
}

function monthLabelOf(key: string): string {
  const [year, month] = key.split("-")
  return `${MONTHS_ES[Number(month) - 1]} ${year}`
}

const cellKey = (sucursal: string, servicio: string) => `${sucursal}||${servicio}`
const subtotalKey = (sucursal: string) => `sub||${sucursal}`

export function buildSalesPivot(
  opps: Opportunity[],
  opts: { sucursalField: string }
): SalesPivot {
  const won = opps.filter(isWonOpp)

  // Pass 1 — bucket every won opp and accumulate the totals that drive ordering.
  type Entry = { rowKey: string; sucursal: string; servicio: string; opp: Opportunity }
  const entries: Entry[] = []
  const sucursalTotals = new Map<string, number>()
  const servicioTotals = new Map<string, number>()
  const pairSeen = new Set<string>()
  const rowKeys = new Set<string>()

  for (const opp of won) {
    const iso = closeDateOf(opp)
    const rowKey = iso ? monthKeyOf(iso) : NO_DATE_KEY
    const sucursal = cfString(opp.customFieldsResolved?.[opts.sucursalField]) || NO_SUCURSAL
    const servicio = cfString(opp.customFieldsResolved?.[SERVICIO_FIELD]) || NO_SERVICIO
    const value = opp.value ?? 0

    entries.push({ rowKey, sucursal, servicio, opp })
    rowKeys.add(rowKey)
    pairSeen.add(cellKey(sucursal, servicio))
    sucursalTotals.set(sucursal, (sucursalTotals.get(sucursal) ?? 0) + value)
    servicioTotals.set(servicio, (servicioTotals.get(servicio) ?? 0) + value)
  }

  // Column order. Sucursales by total desc, "Sin sucursal" last. Inside each
  // one, servicios follow a GLOBAL order (panel-wide total desc) so a column's
  // position means the same thing in every group — that is what makes the
  // groups comparable at a glance — and only the servicios present in that
  // sucursal are rendered. "Sin servicio" always closes a group.
  const byTotalDesc = (totals: Map<string, number>, last: string) =>
    (a: string, b: string) => {
      if (a === last) return 1
      if (b === last) return -1
      const diff = (totals.get(b) ?? 0) - (totals.get(a) ?? 0)
      return diff !== 0 ? diff : a.localeCompare(b, "es")
    }

  const sucursales = [...sucursalTotals.keys()].sort(byTotalDesc(sucursalTotals, NO_SUCURSAL))
  const serviciosGlobal = [...servicioTotals.keys()].sort(byTotalDesc(servicioTotals, NO_SERVICIO))

  const columns: PivotColumn[] = []
  for (const sucursal of sucursales) {
    for (const servicio of serviciosGlobal) {
      if (!pairSeen.has(cellKey(sucursal, servicio))) continue
      columns.push({ key: cellKey(sucursal, servicio), sucursal, servicio, kind: "cell" })
    }
    columns.push({
      key: subtotalKey(sucursal),
      sucursal,
      servicio: "Subtotal",
      kind: "subtotal",
    })
  }
  columns.push({ key: TOTAL_KEY, sucursal: "", servicio: "Total", kind: "total" })

  const columnIndex = new Map(columns.map((c, i) => [c.key, i]))

  // Row order: "Sin fecha de cierre" pinned first, then months ascending.
  const monthKeys = [...rowKeys].filter((k) => k !== NO_DATE_KEY).sort()
  const orderedRowKeys = rowKeys.has(NO_DATE_KEY) ? [NO_DATE_KEY, ...monthKeys] : monthKeys

  const emptyCells = () => columns.map(() => ({ value: 0, oppIds: [] as string[] }))
  const rowCells = new Map<string, PivotCell[]>(
    orderedRowKeys.map((k) => [k, emptyCells()])
  )
  const totalCells = emptyCells()

  // Pass 2 — fill the cell, its sucursal subtotal, and both total lanes.
  const add = (cells: PivotCell[], index: number, value: number, id: string) => {
    cells[index].value += value
    cells[index].oppIds.push(id)
  }

  for (const e of entries) {
    const cells = rowCells.get(e.rowKey)
    if (!cells) continue
    const value = e.opp.value ?? 0
    const targets = [
      columnIndex.get(cellKey(e.sucursal, e.servicio)),
      columnIndex.get(subtotalKey(e.sucursal)),
      columnIndex.get(TOTAL_KEY),
    ]
    for (const i of targets) {
      if (i === undefined) continue
      add(cells, i, value, e.opp.id)
      add(totalCells, i, value, e.opp.id)
    }
  }

  const rows: PivotRow[] = orderedRowKeys.map((key) => ({
    key,
    label: key === NO_DATE_KEY ? NO_DATE_LABEL : monthLabelOf(key),
    kind: key === NO_DATE_KEY ? "no-date" : "month",
    cells: rowCells.get(key)!,
  }))

  if (rows.length > 0) {
    rows.push({ key: TOTAL_KEY, label: "Total", kind: "total", cells: totalCells })
  }

  const totalIndex = columnIndex.get(TOTAL_KEY)!
  return { columns, rows, grandTotal: totalCells[totalIndex]?.value ?? 0 }
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add lib/sales-pivot.ts
git commit -m "feat(lib): sales-pivot — agregado de ventas por mes, sucursal y servicio"
```

---

### Task 4: `scripts/verify-sales-pivot.ts` — the assertions

This is where the aggregation earns trust. A wrong subtotal renders as a plausible number,
so the arithmetic has to be pinned down outside the UI.

**Files:**
- Create: `scripts/verify-sales-pivot.ts`
- Modify: `package.json` (`scripts`)

**Interfaces:**
- Consumes: everything exported by `lib/panel-scope.ts` (Task 2) and `lib/sales-pivot.ts`
  (Task 3).
- Produces: `pnpm verify:pivot`.

- [ ] **Step 1: Register the script**

In `package.json`, add the entry after `verify:paged` (keep the existing ones untouched):

```json
    "verify:paged": "tsx scripts/verify-paged-fetch.ts",
    "verify:pivot": "tsx scripts/verify-sales-pivot.ts",
```

- [ ] **Step 2: Write the failing assertions**

Create `scripts/verify-sales-pivot.ts`:

```ts
// Verification for lib/sales-pivot.ts + lib/panel-scope.ts.
// Run: pnpm verify:pivot
//
// These two modules answer a question in money, and a wrong answer looks
// exactly like a right one on screen — there is no crash to notice. The UTC
// month bucketing (assertion 1) is the subtle one: GHL stores DATE custom
// fields at UTC midnight, so reading the month in local time moves a close on
// the 1st into the previous month.
//
// Wrapped in main() rather than using top-level await: this package is CJS.
import assert from "node:assert/strict";
import type { Opportunity, Pipeline } from "../lib/types";
import {
  buildSalesPivot,
  closeDateOf,
  NO_DATE_KEY,
  NO_SERVICIO,
  NO_SUCURSAL,
  TOTAL_KEY,
} from "../lib/sales-pivot";
import { PANEL_SCOPES, resolvePipelineId, scopeOpportunities } from "../lib/panel-scope";

const SUCURSAL_FIELD = PANEL_SCOPES.vaeo.sucursalField; // "Sucursal VAEO"

let seq = 0;

// Build a minimally valid Opportunity. Only the fields the pivot reads matter.
function opp(o: {
  value: number;
  cierre?: string;
  sucursal?: string;
  servicio?: string;
  status?: Opportunity["status"];
  stage?: string;
  pipelineId?: string;
}): Opportunity {
  const resolved: Record<string, string> = {};
  if (o.cierre) resolved["Fecha de Cierre"] = o.cierre;
  if (o.sucursal) resolved[SUCURSAL_FIELD] = o.sucursal;
  if (o.servicio) resolved["Servicio"] = o.servicio;

  return {
    id: `o${++seq}`,
    name: `Opp ${seq}`,
    pipelineId: o.pipelineId ?? PANEL_SCOPES.vaeo.pipelineId,
    pipelineStageId: "stage-1",
    status: o.status ?? "won",
    createdAt: "2026-01-01T00:00:00.000Z",
    contactId: `c${seq}`,
    value: o.value,
    stage: o.stage ?? "Ganado",
    pipelineName: "VAEO",
    customFieldsResolved: resolved,
  };
}

const cellAt = (
  pivot: ReturnType<typeof buildSalesPivot>,
  rowKey: string,
  columnKey: string
) => {
  const row = pivot.rows.find((r) => r.key === rowKey);
  assert.ok(row, `row ${rowKey} exists`);
  const i = pivot.columns.findIndex((c) => c.key === columnKey);
  assert.notEqual(i, -1, `column ${columnKey} exists`);
  return row!.cells[i];
};

function main() {
  // 1. UTC month bucketing at the month boundary.
  {
    const pivot = buildSalesPivot(
      [
        opp({ value: 100, cierre: "2026-08-01T00:00:00.000Z", sucursal: "MTY Tanarah", servicio: "Coworking" }),
        opp({ value: 50, cierre: "2026-07-31T00:00:00.000Z", sucursal: "MTY Tanarah", servicio: "Coworking" }),
      ],
      { sucursalField: SUCURSAL_FIELD }
    );
    const keys = pivot.rows.filter((r) => r.kind === "month").map((r) => r.key);
    assert.deepEqual(keys, ["2026-07", "2026-08"], "UTC midnight on the 1st stays in its own month");
    assert.equal(cellAt(pivot, "2026-08", "MTY Tanarah||Coworking").value, 100);
    assert.equal(cellAt(pivot, "2026-07", "MTY Tanarah||Coworking").value, 50);
  }

  // 2. Empty buckets: missing sucursal, missing servicio, missing close date.
  {
    const pivot = buildSalesPivot(
      [
        opp({ value: 10, cierre: "2026-03-15T00:00:00.000Z", servicio: "Coworking" }),
        opp({ value: 20, cierre: "2026-03-15T00:00:00.000Z", sucursal: "SLP Covalia" }),
        opp({ value: 30, sucursal: "SLP Covalia", servicio: "Coworking" }),
      ],
      { sucursalField: SUCURSAL_FIELD }
    );
    assert.equal(cellAt(pivot, "2026-03", `${NO_SUCURSAL}||Coworking`).value, 10, "sucursal vacía cae en Sin sucursal");
    assert.equal(cellAt(pivot, "2026-03", `SLP Covalia||${NO_SERVICIO}`).value, 20, "servicio vacío cae en Sin servicio");
    assert.equal(cellAt(pivot, NO_DATE_KEY, "SLP Covalia||Coworking").value, 30, "sin fecha cae en su propia fila");
    assert.equal(pivot.grandTotal, 60, "las tres siguen contando para el total");
  }

  // 3. Only wins count — including a stage-only win with status "open".
  {
    const pivot = buildSalesPivot(
      [
        opp({ value: 100, cierre: "2026-05-10T00:00:00.000Z", sucursal: "QRO Central Park", servicio: "Day pass", status: "won" }),
        opp({ value: 7, cierre: "2026-05-10T00:00:00.000Z", sucursal: "QRO Central Park", servicio: "Day pass", status: "open", stage: "Propuesta" }),
        opp({ value: 7, cierre: "2026-05-10T00:00:00.000Z", sucursal: "QRO Central Park", servicio: "Day pass", status: "lost", stage: "Ganado" }),
        opp({ value: 7, cierre: "2026-05-10T00:00:00.000Z", sucursal: "QRO Central Park", servicio: "Day pass", status: "abandoned", stage: "Perdido" }),
        opp({ value: 25, cierre: "2026-05-10T00:00:00.000Z", sucursal: "QRO Central Park", servicio: "Day pass", status: "open", stage: "Ganado" }),
      ],
      { sucursalField: SUCURSAL_FIELD }
    );
    assert.equal(pivot.grandTotal, 125, "abierta/perdida/abandonada fuera; stage Ganado con status open dentro");
  }

  // 4. Subtotals, total row and grand total agree with the raw sum.
  {
    const opps = [
      opp({ value: 100, cierre: "2026-04-02T00:00:00.000Z", sucursal: "MTY Tanarah", servicio: "Coworking" }),
      opp({ value: 200, cierre: "2026-04-20T00:00:00.000Z", sucursal: "MTY Tanarah", servicio: "Sala de Juntas" }),
      opp({ value: 300, cierre: "2026-05-05T00:00:00.000Z", sucursal: "SLP Covalia", servicio: "Coworking" }),
      opp({ value: 400, cierre: "2026-05-06T00:00:00.000Z", sucursal: "SLP Covalia" }),
    ];
    const pivot = buildSalesPivot(opps, { sucursalField: SUCURSAL_FIELD });
    const raw = opps.reduce((s, o) => s + o.value, 0);

    assert.equal(pivot.grandTotal, raw, "el total general cuadra con la suma cruda");
    assert.equal(cellAt(pivot, "2026-04", "sub||MTY Tanarah").value, 300, "subtotal por sucursal en un mes");
    assert.equal(cellAt(pivot, TOTAL_KEY, "sub||SLP Covalia").value, 700, "subtotal de la fila Total");
    assert.equal(cellAt(pivot, TOTAL_KEY, TOTAL_KEY).value, raw, "la celda Total/Total es el total general");

    // Every row's Total cell equals the sum of that row's plain cells.
    for (const row of pivot.rows) {
      const cellSum = pivot.columns.reduce(
        (s, c, i) => (c.kind === "cell" ? s + row.cells[i].value : s),
        0
      );
      const totalIdx = pivot.columns.findIndex((c) => c.key === TOTAL_KEY);
      assert.equal(row.cells[totalIdx].value, cellSum, `la fila ${row.key} cuadra con sus celdas`);
    }

    // Drill-down ids: the Total/Total cell holds every won opportunity.
    assert.equal(cellAt(pivot, TOTAL_KEY, TOTAL_KEY).oppIds.length, opps.length, "el drill del total trae todas");
  }

  // 5. Ordering: no-date row first, months ascending, Total last;
  //    "Sin servicio" closes its group and the grand total is the last column.
  {
    const pivot = buildSalesPivot(
      [
        opp({ value: 5, cierre: "2026-06-01T00:00:00.000Z", sucursal: "MTY Tanarah", servicio: "Coworking" }),
        opp({ value: 5, cierre: "2026-01-01T00:00:00.000Z", sucursal: "MTY Tanarah", servicio: "Coworking" }),
        opp({ value: 9, sucursal: "MTY Tanarah", servicio: "Coworking" }),
        opp({ value: 1, cierre: "2026-01-01T00:00:00.000Z", sucursal: "MTY Tanarah" }),
      ],
      { sucursalField: SUCURSAL_FIELD }
    );
    assert.deepEqual(
      pivot.rows.map((r) => r.key),
      [NO_DATE_KEY, "2026-01", "2026-06", TOTAL_KEY],
      "sin-fecha arriba, meses ascendentes, Total al final"
    );
    assert.deepEqual(
      pivot.columns.map((c) => c.key),
      [
        "MTY Tanarah||Coworking",
        `MTY Tanarah||${NO_SERVICIO}`,
        "sub||MTY Tanarah",
        TOTAL_KEY,
      ],
      "Sin servicio cierra el grupo, luego Subtotal, y Total al final"
    );
    assert.equal(pivot.rows[0].label, "Sin fecha de cierre");
    assert.equal(pivot.rows[1].label, "ene 2026", "etiqueta de mes en español");
  }

  // 6. Empty input produces an empty pivot, not a lone Total row.
  {
    const pivot = buildSalesPivot([], { sucursalField: SUCURSAL_FIELD });
    assert.deepEqual(pivot.rows, [], "sin datos no hay filas");
    assert.equal(pivot.grandTotal, 0);
  }

  // 7. closeDateOf ignores an unparseable value.
  {
    const bad = opp({ value: 1, sucursal: "MTY Tanarah" });
    bad.customFieldsResolved = { "Fecha de Cierre": "no soy fecha" };
    assert.equal(closeDateOf(bad), undefined, "una fecha basura se trata como ausente");
  }

  // 8. panel-scope: name match wins, id is the fallback, and scoping filters.
  {
    const pipelines: Pipeline[] = [
      { id: "nuevo-id-vaeo", name: "VAEO", stages: ["Nuevo Lead", "Ganado"] },
      { id: "nuevo-id-mesh", name: "MESH", stages: ["Nuevo Lead", "Ganado"] },
    ];
    assert.equal(resolvePipelineId(pipelines, "vaeo"), "nuevo-id-vaeo", "gana el match por nombre");
    assert.equal(resolvePipelineId([], "vaeo"), PANEL_SCOPES.vaeo.pipelineId, "sin match, cae al id");
    assert.equal(resolvePipelineId(undefined, "mesh"), PANEL_SCOPES.mesh.pipelineId, "sin pipelines, cae al id");

    const mixed = [
      opp({ value: 1, pipelineId: "nuevo-id-vaeo" }),
      opp({ value: 1, pipelineId: "nuevo-id-mesh" }),
    ];
    assert.equal(scopeOpportunities(mixed, "vaeo", pipelines).length, 1, "solo el pipeline del panel");
    assert.equal(scopeOpportunities(mixed, "mesh", pipelines).length, 1);
  }

  console.log("verify-sales-pivot: all assertions passed");
}

main();
```

- [ ] **Step 3: Run it**

Run: `pnpm verify:pivot`
Expected: `verify-sales-pivot: all assertions passed`.

If an assertion fails, fix `lib/sales-pivot.ts` or `lib/panel-scope.ts` — **not** the
assertion — unless the assertion itself contradicts the spec.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add scripts/verify-sales-pivot.ts package.json
git commit -m "test(lib): assertions para sales-pivot y panel-scope"
```

---

### Task 5: `components/dashboard/sales-pivot-table.tsx` — the table

**Files:**
- Create: `components/dashboard/sales-pivot-table.tsx`

**Interfaces:**
- Consumes: `buildSalesPivot`, `closeDateOf`, `PivotCell` from `lib/sales-pivot.ts`;
  `PANEL_SCOPES`, `scopeOpportunities`, `PanelId` from `lib/panel-scope.ts`;
  `filterByDateRange`, `ResolvedDateRange` from `lib/date-range.ts`;
  `DashboardCard`, `ChartCardHeader`, `ChartCardContent`, `ChartEmpty`, `ScopePill` from
  `./dashboard-ui`; `ChartDrillDrawer`, `DrillState`, `DRILL_CLOSED` from
  `./chart-drill-drawer`.
- Produces: `<SalesPivotTable panel contacts allContacts allOpportunities dateRange
  tasks calls allPautas appointments messages locationId />`.

- [ ] **Step 1: Write the component**

```tsx
"use client"

import { useMemo, useState } from "react"
import { Table2 } from "lucide-react"
import type { Appointment, Call, Contact, Message, Opportunity, Pauta, Pipeline, Task } from "@/lib/types"
import { buildSalesPivot, closeDateOf, type PivotCell } from "@/lib/sales-pivot"
import { PANEL_SCOPES, scopeOpportunities, type PanelId } from "@/lib/panel-scope"
import { filterByDateRange, type ResolvedDateRange } from "@/lib/date-range"
import { cn } from "@/lib/utils"
import {
  ChartCardContent,
  ChartCardHeader,
  ChartEmpty,
  DashboardCard,
  ScopePill,
} from "./dashboard-ui"
import { ChartDrillDrawer, DRILL_CLOSED, type DrillState } from "./chart-drill-drawer"

const money = new Intl.NumberFormat("es-MX", {
  style: "currency",
  currency: "MXN",
  maximumFractionDigits: 0,
})

export interface SalesPivotTableProps {
  panel: PanelId
  /** Unfiltered opportunities — this table does its own date filtering, by close date. */
  allOpportunities: Opportunity[]
  contacts: Contact[]
  /** Unfiltered contacts — drill-down joins resolve against these. */
  allContacts: Contact[]
  pipelines?: Pipeline[]
  dateRange: ResolvedDateRange | null
  tasks?: Task[]
  calls?: Call[]
  allPautas?: Pauta[]
  appointments?: Appointment[]
  messages?: Message[]
  locationId?: string
}

export function SalesPivotTable({
  panel,
  allOpportunities,
  contacts,
  allContacts,
  pipelines = [],
  dateRange,
  tasks = [],
  calls = [],
  allPautas = [],
  appointments = [],
  messages = [],
  locationId = "",
}: SalesPivotTableProps) {
  const [drill, setDrill] = useState<DrillState>(DRILL_CLOSED)
  const scope = PANEL_SCOPES[panel]

  // Deliberately built off allOpportunities, not the date-filtered prop: the
  // rest of the panel filters by createdAt, and this table measures the close
  // date. filterByDateRange keeps records with no date, which is what puts the
  // "Sin fecha de cierre" row on screen under any filter.
  const pivot = useMemo(() => {
    const scoped = scopeOpportunities(allOpportunities, panel, pipelines)
    const inRange = filterByDateRange(scoped, closeDateOf, dateRange)
    return buildSalesPivot(inRange, { sucursalField: scope.sucursalField })
  }, [allOpportunities, panel, pipelines, dateRange, scope.sucursalField])

  const oppById = useMemo(
    () => new Map(allOpportunities.map((o) => [o.id, o])),
    [allOpportunities]
  )

  const openDrill = (cell: PivotCell, title: string, subtitle: string) => {
    if (cell.oppIds.length === 0) return
    const opportunities = cell.oppIds
      .map((id) => oppById.get(id))
      .filter((o): o is Opportunity => Boolean(o))
    setDrill({ open: true, title, subtitle, opportunities })
  }

  // Column-group spans for the top header row: one <th> per sucursal covering
  // its servicio columns plus its subtotal.
  const groups = useMemo(() => {
    const out: { sucursal: string; span: number }[] = []
    for (const col of pivot.columns) {
      if (col.kind === "total") continue
      const last = out[out.length - 1]
      if (last && last.sucursal === col.sucursal) last.span += 1
      else out.push({ sucursal: col.sucursal, span: 1 })
    }
    return out
  }, [pivot.columns])

  const stickyCol = "sticky left-0 z-20 bg-card"

  return (
    <DashboardCard>
      <ChartCardHeader
        title="Resumen general de ventas"
        icon={Table2}
        total={money.format(pivot.grandTotal)}
        actions={
          <ScopePill
            label="Ganadas · por fecha de cierre"
            tooltip={
              <>
                Suma el valor de las oportunidades <strong>ganadas</strong> del embudo{" "}
                {scope.label}, agrupadas por el mes de su <strong>Fecha de Cierre</strong>{" "}
                (no por su fecha de creación). Las que no tienen sucursal o servicio
                capturado caen en las columnas <em>Sin sucursal</em> / <em>Sin servicio</em>,
                y las que no tienen fecha de cierre viven en la fila{" "}
                <em>Sin fecha de cierre</em>, que no se ve afectada por el filtro de fechas.
              </>
            }
          />
        }
      />
      <ChartCardContent>
        {pivot.rows.length === 0 ? (
          <ChartEmpty message="Sin ventas cerradas en el periodo seleccionado" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-max border-separate border-spacing-0 text-right text-xs tabular-nums">
              <thead>
                <tr>
                  <th
                    rowSpan={2}
                    className={cn(
                      stickyCol,
                      "border-b border-r border-border px-3 py-2 text-left align-bottom font-semibold"
                    )}
                  >
                    Fecha de cierre
                  </th>
                  {groups.map((g) => (
                    <th
                      key={g.sucursal}
                      colSpan={g.span}
                      className="border-b border-r border-border px-3 py-2 text-center font-semibold"
                    >
                      {g.sucursal}
                    </th>
                  ))}
                  <th rowSpan={2} className="border-b border-border px-3 py-2 align-bottom font-semibold">
                    Total
                  </th>
                </tr>
                <tr>
                  {pivot.columns
                    .filter((c) => c.kind !== "total")
                    .map((c) => (
                      <th
                        key={c.key}
                        className={cn(
                          "min-w-[7.5rem] border-b border-border px-3 py-2 font-medium text-muted-foreground",
                          c.kind === "subtotal" && "border-r font-semibold text-foreground",
                        )}
                      >
                        {c.servicio}
                      </th>
                    ))}
                </tr>
              </thead>
              <tbody>
                {pivot.rows.map((row) => (
                  <tr key={row.key} className={cn(row.kind === "total" && "font-semibold")}>
                    <th
                      scope="row"
                      className={cn(
                        stickyCol,
                        "whitespace-nowrap border-b border-r border-border px-3 py-2 text-left font-medium",
                        row.kind === "total" && "font-semibold",
                        row.kind === "no-date" && "text-muted-foreground",
                      )}
                    >
                      {row.label}
                    </th>
                    {row.cells.map((cell, i) => {
                      const col = pivot.columns[i]
                      const label =
                        col.kind === "cell"
                          ? `${col.sucursal} · ${col.servicio}`
                          : col.kind === "subtotal"
                            ? `${col.sucursal} · total`
                            : "Todas las sucursales"
                      return (
                        <td
                          key={col.key}
                          onClick={() => openDrill(cell, `${row.label} — ${label}`, "Oportunidades ganadas")}
                          className={cn(
                            "border-b border-border px-3 py-2",
                            (col.kind === "subtotal" || col.kind === "total") && "font-semibold",
                            col.kind === "subtotal" && "border-r",
                            cell.oppIds.length > 0 && "cursor-pointer hover:bg-muted/50",
                          )}
                        >
                          {cell.value === 0 ? (
                            <span className="text-muted-foreground">–</span>
                          ) : (
                            money.format(cell.value)
                          )}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output. If `ChartDrillDrawer`'s prop names differ, read
`components/dashboard/chart-drill-drawer.tsx:62-87` and match them exactly — do not
loosen types to make it compile.

- [ ] **Step 3: Commit**

```bash
git add components/dashboard/sales-pivot-table.tsx
git commit -m "feat(ui): tabla pivote de ventas por sucursal y servicio"
```

---

### Task 6: Wire it into both panels

The table only renders in VAEO for now, but the `dateRange` prop goes into **both**
dashboards in this same commit — the two prop surfaces are kept identical on purpose so a
chart can move between panels unchanged.

**Files:**
- Modify: `components/dashboard/vaeo-dashboard.tsx`
- Modify: `components/dashboard/mesh-dashboard.tsx`
- Modify: `app/page.tsx` (~line 298 `<VaeoDashboard>`, ~line 319 `<MeshDashboard>`)

**Interfaces:**
- Consumes: `SalesPivotTable` from Task 5; `dateRange` already computed at `app/page.tsx:61`
  as `ResolvedDateRange | null`.
- Produces: `dateRange` on `VaeoDashboardProps` and `MeshDashboardProps`.

- [ ] **Step 1: Add the prop to both dashboards**

In **both** `vaeo-dashboard.tsx` and `mesh-dashboard.tsx`, add the import and the prop:

```ts
import type { ResolvedDateRange } from "@/lib/date-range"
```

and inside each props interface, after `periodLabel`:

```ts
  /**
   * Resolved global date range. Charts that measure a date OTHER than createdAt
   * (the pivot table measures the close date) filter the `all*` sets themselves
   * instead of using the pre-filtered props.
   */
  dateRange?: ResolvedDateRange | null
```

- [ ] **Step 2: Render the table in VAEO**

In `vaeo-dashboard.tsx`, replace the `PanelPlaceholder` body with the table, keeping
`DashboardShell`:

```tsx
export function VaeoDashboard({
  contacts,
  allContacts = [],
  allOpportunities = [],
  pipelines = [],
  dateRange = null,
  tasks = [],
  calls = [],
  allPautas = [],
  appointments = [],
  messages = [],
  locationId,
}: VaeoDashboardProps) {
  return (
    <DashboardShell>
      <SalesPivotTable
        panel="vaeo"
        allOpportunities={allOpportunities}
        contacts={contacts}
        allContacts={allContacts}
        pipelines={pipelines}
        dateRange={dateRange}
        tasks={tasks}
        calls={calls}
        allPautas={allPautas}
        appointments={appointments}
        messages={messages}
        locationId={locationId}
      />
    </DashboardShell>
  )
}
```

Add `import { SalesPivotTable } from "./sales-pivot-table"` and drop the now-unused
`PanelPlaceholder` import. **Leave `mesh-dashboard.tsx` rendering its placeholder** — MESH
gets its charts in its own pass.

- [ ] **Step 3: Pass `dateRange` from the page**

In `app/page.tsx`, add `dateRange={dateRange}` to **both** `<VaeoDashboard>` (~line 298)
and `<MeshDashboard>` (~line 319). The variable already exists at line 61.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output.

- [ ] **Step 5: Lint**

Run: `pnpm lint`
Expected: no errors. Unused imports left behind in `vaeo-dashboard.tsx` will surface here.

- [ ] **Step 6: Drive the real app**

Run `pnpm dev`, log in, land on the VAEO tab. Confirm, in order:

1. The table renders with `MTY Tanarah`, `MTY Calzada del Valle`, `QRO Central Park`,
   `SLP Covalia` as column groups (highest total first) and a `Sin sucursal` group last.
2. Each group ends in a `Subtotal` column; the far-right column is `Total`.
3. Rows read `Sin fecha de cierre` (if any), then months ascending, then `Total`.
4. Scrolling horizontally keeps the `Fecha de cierre` column pinned and readable — no
   text bleeding through it.
5. Clicking a non-zero cell opens the drill drawer with that cell's opportunities, and the
   drawer's count matches the cell's composition.
6. Changing the global date filter to "Últimos 3 meses" drops the older month rows, and
   the `Sin fecha de cierre` row **stays**.
7. The MESH tab still renders its placeholder without errors.

Sanity check against production numbers as of 2026-08-04: with the filter on "Todo", the
VAEO grand total should be in the neighborhood of **$9.2M** across **648** won
opportunities, and `Sin servicio` should be the largest column by far (373 of 648 opps).

- [ ] **Step 7: Commit**

```bash
git add app/page.tsx components/dashboard/vaeo-dashboard.tsx components/dashboard/mesh-dashboard.tsx
git commit -m "feat(vaeo): montar la tabla de resumen de ventas en el panel"
```

---

### Task 7: Document it

**Files:**
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing code-facing.

- [ ] **Step 1: Update the shared-domain-rules table**

In `CLAUDE.md`, under "Shared domain rules (single sources of truth)", add two rows to the
module table:

```markdown
| `lib/panel-scope.ts` | which pipeline + sucursal custom field each panel means |
| `lib/sales-pivot.ts` | the ventas pivot aggregation (mes de cierre × sucursal › servicio) |
```

- [ ] **Step 2: Record the DATE custom-field gotcha**

Under "GHL API Gotchas", add a bullet next to the existing `customFields` shape bullet:

```markdown
- **DATE custom fields use `fieldValueDate`** — an epoch in **milliseconds at UTC
  midnight**, not `fieldValue`/`fieldValueString`. `resolveCustomFields()` normalizes it to
  ISO. Bucket such dates with UTC getters: read in `America/Mexico_City`, a close on the
  1st at 00:00Z lands in the previous month.
```

- [ ] **Step 3: Register the verify script**

In the "Commands" block, add to the verification list:

```bash
pnpm verify:pivot        # lib/sales-pivot.ts + lib/panel-scope.ts — el agregado de ventas
```

and add `sales-pivot / panel-scope` to the sentence listing which modules have assertion
scripts.

- [ ] **Step 4: Update "Current state"**

`vaeo-dashboard.tsx` is no longer empty. Amend that bullet to say VAEO now renders
`sales-pivot-table.tsx` and that `mesh-dashboard.tsx` is still a placeholder, and note the
new `dateRange` prop on both panels (for charts measuring a date other than `createdAt`).

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: documentar panel-scope, sales-pivot y el gotcha de fieldValueDate"
```

---

## Verification Summary

Run before calling this done:

```bash
pnpm verify:pivot     # the new assertions
npx tsc --noEmit      # REQUIRED — next build ignores TS errors
pnpm lint
```

Plus the manual pass in Task 6, Step 6 — the sticky header, the horizontal scroll and the
drill drawer have no automated coverage, and pdfmake-style "verify by driving the real app"
is this repo's standing rule for UI.
