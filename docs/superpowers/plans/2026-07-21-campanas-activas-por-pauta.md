# Campañas activas por pauta — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Marketing-dashboard chart that lists every campaign with a Pauta in the active date range, grouped by detected name-prefix family, so a human can tell which agency owns which campaign at a glance.

**Architecture:** A pure family-detection layer in `lib/pauta.ts` (no React, no GHL), a self-contained presentational component in a new file, and a three-line wiring change in `marketing-dashboard.tsx`. The component receives already-date-filtered `pautas` as props, exactly like every other dashboard component.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Tailwind CSS v3, shadcn/ui. No charting library for this one — it is a div-based bar list, following the row-based pattern already used in `marketing-dashboard.tsx` (the "Oportunidades por fuente" rows around line 1330).

**Spec:** `docs/superpowers/specs/2026-07-21-campanas-activas-por-pauta-design.md`

## Global Constraints

- **No test framework, and none is being adopted.** Verification is `npx tsc --noEmit` plus driving the real app. `next build` ignores TypeScript errors (see `next.config.mjs`), so a green build proves nothing.
- **No new `scripts/verify-*.ts` is committed.** Those are reserved for the three modules where a silent bug is a cross-tenant data leak (`lib/clients.ts`, `lib/auth.ts`, `lib/ghl-limiter.ts`). Task 1 uses a throwaway script that is deleted before its commit.
- This package is CommonJS (no `"type": "module"`), so `tsx` compiles to CJS where **top-level `await` fails**. The Task 1 script is fully synchronous, so this does not bite — but do not add `await` at top level.
- Installing anything needs `npm install --legacy-peer-deps`. This plan adds no dependencies.
- All user-facing copy is in **Spanish**. Number formatting uses `toLocaleString("es-MX")`, matching the rest of the file.
- The unit of measure is the **`Pauta` record**, never the opportunity. One record = one entry, so reingresos count on their own.
- "Lead único" means `isUniqueLead(p)` — the contact's first-ever pauta. Never redefine it as "distinct contactIds".
- The PDF report (`lib/report.ts`, `lib/pdf/charts.ts`) is **out of scope**. Do not touch those files.

## File Structure

| File | Responsibility |
|---|---|
| `lib/pauta.ts` (modify, append) | Pure campaign-name family detection: split a name into `family` + `prefixLen`, and bucket a list of tallies into ordered groups. No React, no GHL. |
| `components/dashboard/campaign-activity-chart.tsx` (create) | The card: depth toggle, tallying, family colors, rows, scroll, empty state. Presentational — owns no drawer state. |
| `components/dashboard/marketing-dashboard.tsx` (modify) | Adds `openPautaRecordsDrill` and renders the card. Nothing else. |

`marketing-dashboard.tsx` is already 2 304 lines; the chart goes in its own file rather than growing it further.

---

### Task 1: Family detection in `lib/pauta.ts`

**Files:**
- Modify: `lib/pauta.ts` (append at end of file)
- Test: `scripts/tmp-campaign-family-check.ts` (temporary — created, run, then **deleted** before the commit)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces, all exported from `@/lib/pauta`:
  - `SIN_PATRON_FAMILY: string` — the literal `"Sin patrón"`
  - `SIN_NOMBRE_CAMPAIGN: string` — the literal `"Sin nombre"`
  - `campaignFamilySplit(name: string, depth: number): { family: string; prefixLen: number } | null`
  - `interface CampaignTally { name: string; pautas: number; leads: number }`
  - `interface CampaignRow extends CampaignTally { prefixLen: number }`
  - `interface CampaignGroup { key: string; kind: "family" | "orphan" | "unnamed"; campaigns: CampaignRow[]; pautas: number; leads: number }`
  - `groupCampaignsByFamily(tallies: CampaignTally[], depth: number): CampaignGroup[]`

- [ ] **Step 1: Write the failing assertion script**

Create `scripts/tmp-campaign-family-check.ts`:

```typescript
// TEMPORARY — delete before committing. Not a verify:* script; those are
// reserved for the multi-tenant isolation modules.
// Run: npx tsx scripts/tmp-campaign-family-check.ts
import assert from "node:assert/strict";
import {
  campaignFamilySplit,
  groupCampaignsByFamily,
  SIN_PATRON_FAMILY,
  SIN_NOMBRE_CAMPAIGN,
  type CampaignTally,
} from "../lib/pauta";

// ── campaignFamilySplit ────────────────────────────────────────────────────
assert.deepEqual(
  campaignFamilySplit("IW - CC - FF - Corregidora - Julio", 1),
  { family: "IW", prefixLen: 5 },
  "depth 1 cuts after the first separator",
);

assert.deepEqual(
  campaignFamilySplit("IW - CC - FF - Corregidora - Julio", 2),
  { family: "IW - CC", prefixLen: 10 },
  "depth 2 cuts after the second separator",
);

assert.deepEqual(
  campaignFamilySplit("IW-CC-FF", 1),
  { family: "IW", prefixLen: 3 },
  "separators without surrounding spaces still split",
);

assert.equal(
  campaignFamilySplit("Remarketing", 1),
  null,
  "a name with no separator has no family",
);

assert.equal(
  campaignFamilySplit("IW - CC", 2),
  null,
  "depth deeper than the token count has no family",
);

assert.equal(
  campaignFamilySplit("IW - ", 1),
  null,
  "an empty remainder is not a family — nothing would distinguish its members",
);

assert.deepEqual(
  campaignFamilySplit("- IW - CC", 1),
  { family: "IW", prefixLen: 7 },
  "a leading separator is punctuation, not a token boundary",
);

assert.equal(
  campaignFamilySplit("IW - CC", 0),
  null,
  "depth 0 disables detection",
);

// ── groupCampaignsByFamily ─────────────────────────────────────────────────
const tallies: CampaignTally[] = [
  { name: "IW - Corregidora - Julio", pautas: 52, leads: 41 },
  { name: "IW - Corregidora - Agosto", pautas: 31, leads: 28 },
  { name: "MKD - Remarketing", pautas: 38, leads: 30 },
  { name: "MKD - Prospección", pautas: 25, leads: 25 },
  { name: "Solitaria - Unica", pautas: 90, leads: 90 },
  { name: "fb_leadform", pautas: 7, leads: 7 },
  { name: SIN_NOMBRE_CAMPAIGN, pautas: 4, leads: 2 },
];

const groups = groupCampaignsByFamily(tallies, 1);

assert.deepEqual(
  groups.map((g) => g.key),
  ["IW", "MKD", SIN_PATRON_FAMILY, SIN_NOMBRE_CAMPAIGN],
  "families sorted by volume desc; Sin patrón then Sin nombre always last",
);

assert.deepEqual(
  groups.map((g) => g.kind),
  ["family", "family", "orphan", "unnamed"],
  "each group is tagged with its kind",
);

assert.equal(groups[0].pautas, 83, "family total sums its campaigns' pautas");
assert.equal(groups[0].leads, 69, "family total sums its campaigns' leads");

assert.deepEqual(
  groups[0].campaigns.map((c) => c.name),
  ["IW - Corregidora - Julio", "IW - Corregidora - Agosto"],
  "campaigns inside a family sort by volume desc",
);

assert.equal(
  groups[0].campaigns[0].prefixLen,
  5,
  "a family member carries the prefix length so the UI can dim it",
);

const orphan = groups[2];
assert.deepEqual(
  orphan.campaigns.map((c) => c.name),
  ["Solitaria - Unica", "fb_leadform"],
  "a one-member family is demoted into Sin patrón, sorted by volume",
);
assert.deepEqual(
  orphan.campaigns.map((c) => c.prefixLen),
  [0, 0],
  "a demoted singleton loses its dimming — no pattern was actually found",
);

// "Sin patrón" outranks nothing: it stays after every real family even when its
// volume is the largest in the set.
assert.ok(
  orphan.pautas > groups[0].pautas,
  "precondition: the orphan bucket really is the heaviest here",
);

assert.deepEqual(groupCampaignsByFamily([], 1), [], "empty input yields no groups");

console.log("OK — campaign family detection");
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npx tsx scripts/tmp-campaign-family-check.ts
```

Expected: FAIL. The error is a module/export error, not an assertion error — something like `SyntaxError: The requested module '../lib/pauta' does not provide an export named 'campaignFamilySplit'` or `TypeError: (0, pauta_1.campaignFamilySplit) is not a function`. If you instead see an assertion failure, the functions already exist and you are on the wrong branch — stop and check.

- [ ] **Step 3: Append the implementation to `lib/pauta.ts`**

Add at the **end** of `lib/pauta.ts` (after `resolveCampaignName`):

```typescript
// ── Familias de campaña ────────────────────────────────────────────────────
// Nothing in GHL says which agency owns a campaign — not on the Pauta object,
// not on the opportunity. The only signal is the naming convention: each agency
// prefixes its pautas its own way ("IW - CC - FF - Corregidora - Julio"). These
// helpers detect that shared prefix so the Marketing chart can group by it and
// dim it, making the pattern legible to a human who then infers the agency.
//
// This is the deliberate INVERSE of campaignPrefixCut() in
// marketing-dashboard.tsx, which strips the prefix shared by ALL keys so bars
// don't render visually identical. Different question, opposite treatment —
// do not try to unify them.

/** Bucket for named campaigns whose name matched no family. */
export const SIN_PATRON_FAMILY = "Sin patrón"

/**
 * The sentinel app/api/dashboard/route.ts writes when the Pauta record has no
 * name property. Kept distinct from SIN_PATRON_FAMILY: "I don't know what this
 * is called" is not the same as "it's called something that fits no family".
 */
export const SIN_NOMBRE_CAMPAIGN = "Sin nombre"

// Campaign names separate tokens with any of these, with or without spaces.
const CAMPAIGN_SEPARATOR = /\s*[-|_/]\s*/

/**
 * Split a campaign name into its family prefix and the rest, cutting after the
 * `depth`-th separator. Returns null when the name has no family at that depth
 * — no separator, too few tokens, or nothing left after the cut.
 *
 * `prefixLen` is a character offset into the ORIGINAL string (separator
 * included) so the UI can render name.slice(0, prefixLen) dimmed and
 * name.slice(prefixLen) emphasized, without re-deriving the split.
 */
export function campaignFamilySplit(
  name: string,
  depth: number,
): { family: string; prefixLen: number } | null {
  if (depth < 1) return null
  const re = new RegExp(CAMPAIGN_SEPARATOR.source, "g")
  let seen = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(name)) !== null) {
    // A separator at position 0 is leading punctuation, not a token boundary.
    if (m.index === 0) continue
    seen++
    if (seen < depth) continue
    const family = name.slice(0, m.index).trim()
    const prefixLen = m.index + m[0].length
    // Both halves must be non-empty: "IW - " would otherwise yield a family
    // with nothing left to tell its members apart.
    if (!family || !name.slice(prefixLen).trim()) return null
    return { family, prefixLen }
  }
  return null
}

/** One campaign's counts. `leads` is the isUniqueLead subset of `pautas`. */
export interface CampaignTally {
  name: string
  pautas: number
  leads: number
}

export interface CampaignRow extends CampaignTally {
  /** Leading chars of `name` that belong to the family prefix. 0 = dim nothing. */
  prefixLen: number
}

export interface CampaignGroup {
  /** Family name, or SIN_PATRON_FAMILY / SIN_NOMBRE_CAMPAIGN. */
  key: string
  kind: "family" | "orphan" | "unnamed"
  campaigns: CampaignRow[]
  pautas: number
  leads: number
}

/**
 * Bucket campaign tallies into families detected at `depth`, ordered for
 * display: real families by volume desc, then "Sin patrón", then "Sin nombre".
 * The two leftover buckets are pinned last regardless of volume — they are
 * residue, not findings, and letting a big one lead would bury the signal.
 */
export function groupCampaignsByFamily(
  tallies: CampaignTally[],
  depth: number,
): CampaignGroup[] {
  const families = new Map<string, CampaignRow[]>()
  const orphans: CampaignRow[] = []
  const unnamed: CampaignRow[] = []

  for (const t of tallies) {
    if (t.name === SIN_NOMBRE_CAMPAIGN) {
      unnamed.push({ ...t, prefixLen: 0 })
      continue
    }
    const split = campaignFamilySplit(t.name, depth)
    if (!split) {
      orphans.push({ ...t, prefixLen: 0 })
      continue
    }
    const arr = families.get(split.family) ?? []
    arr.push({ ...t, prefixLen: split.prefixLen })
    families.set(split.family, arr)
  }

  // A family of one costs a header and a color and conveys nothing. Demote it,
  // and drop its dimming — we did not actually find a pattern.
  for (const [key, rows] of families) {
    if (rows.length > 1) continue
    orphans.push({ ...rows[0], prefixLen: 0 })
    families.delete(key)
  }

  const byVolume = (a: CampaignRow, b: CampaignRow) =>
    b.pautas - a.pautas || a.name.localeCompare(b.name, "es")
  const sum = (rows: CampaignRow[], k: "pautas" | "leads") =>
    rows.reduce((s, r) => s + r[k], 0)

  const groups: CampaignGroup[] = [...families.entries()]
    .map(([key, rows]) => ({
      key,
      kind: "family" as const,
      campaigns: [...rows].sort(byVolume),
      pautas: sum(rows, "pautas"),
      leads: sum(rows, "leads"),
    }))
    .sort((a, b) => b.pautas - a.pautas || a.key.localeCompare(b.key, "es"))

  if (orphans.length > 0) {
    groups.push({
      key: SIN_PATRON_FAMILY,
      kind: "orphan",
      campaigns: [...orphans].sort(byVolume),
      pautas: sum(orphans, "pautas"),
      leads: sum(orphans, "leads"),
    })
  }
  if (unnamed.length > 0) {
    groups.push({
      key: SIN_NOMBRE_CAMPAIGN,
      kind: "unnamed",
      campaigns: [...unnamed].sort(byVolume),
      pautas: sum(unnamed, "pautas"),
      leads: sum(unnamed, "leads"),
    })
  }
  return groups
}
```

- [ ] **Step 4: Run the script to verify it passes**

```bash
npx tsx scripts/tmp-campaign-family-check.ts
```

Expected: `OK — campaign family detection` and exit code 0.

- [ ] **Step 5: Typecheck**

```bash
npx tsc --noEmit
```

Expected: no output, exit code 0.

- [ ] **Step 6: Delete the temporary script and commit**

```bash
rm scripts/tmp-campaign-family-check.ts
git add lib/pauta.ts
git commit -m "feat(pauta): detect campaign-name families by shared prefix

Nothing in GHL says which agency owns a campaign, so the name's prefix is
the only signal. campaignFamilySplit() cuts a name into family + remainder
at a given depth; groupCampaignsByFamily() buckets tallies into display
order, demoting one-member families to \"Sin patrón\".

Deliberately the inverse of campaignPrefixCut(), which strips the shared
prefix on the existing \"por campaña\" charts."
```

Verify nothing stray was committed:

```bash
git status --short
```

Expected: `scripts/tmp-campaign-family-check.ts` must NOT appear (it is deleted and was never added).

---

### Task 2: The `CampaignActivityChart` component

**Files:**
- Create: `components/dashboard/campaign-activity-chart.tsx`

**Interfaces:**
- Consumes from Task 1: `SIN_NOMBRE_CAMPAIGN`, `groupCampaignsByFamily`, types `CampaignTally`, `CampaignRow`, `CampaignGroup` — all from `@/lib/pauta`.
- Consumes from the existing codebase:
  - `@/lib/types` → `Pauta`
  - `./dashboard-ui` → `DashboardCard`, `ChartCardHeader`, `ChartCardContent`, `ChartEmpty`, `ChartHint`, `chartPaletteColor`
- Produces, for Task 3:
  ```typescript
  export function CampaignActivityChart(props: {
    pautas: Pauta[]                          // already date-filtered
    isUniqueLead: (p: Pauta) => boolean
    onDrill: (title: string, items: Pauta[]) => void
  }): JSX.Element
  ```

- [ ] **Step 1: Create the component file**

Create `components/dashboard/campaign-activity-chart.tsx` with exactly this content:

```tsx
"use client"

import { useMemo, useState } from "react"
import { Megaphone } from "lucide-react"

import type { Pauta } from "@/lib/types"
import {
  groupCampaignsByFamily,
  SIN_NOMBRE_CAMPAIGN,
  type CampaignGroup,
  type CampaignRow,
  type CampaignTally,
} from "@/lib/pauta"

import {
  ChartCardContent,
  ChartCardHeader,
  ChartEmpty,
  ChartHint,
  DashboardCard,
  chartPaletteColor,
} from "./dashboard-ui"

// How many leading tokens form the family key. "flat" keeps the detection (for
// color and prefix dimming) but drops the grouping, leaving one volume-ordered
// list — the escape hatch when automatic grouping cuts in the wrong place.
type GroupDepth = 1 | 2 | "flat"

const DEPTH_OPTIONS: { v: GroupDepth; label: string }[] = [
  { v: 1, label: "1" },
  { v: 2, label: "2" },
  { v: "flat", label: "PLANO" },
]

// The leftover buckets ("Sin patrón", "Sin nombre") never get a palette color —
// a color would imply we identified something.
const NEUTRAL_COLOR = "#94a3b8"

const fmt = (n: number) => n.toLocaleString("es-MX")

function DepthToggle({ value, onChange }: { value: GroupDepth; onChange: (v: GroupDepth) => void }) {
  return (
    <div className="flex items-center overflow-hidden rounded border border-border/50 text-[10px] font-medium">
      {DEPTH_OPTIONS.map((opt, i) => (
        <button
          key={String(opt.v)}
          type="button"
          onClick={() => onChange(opt.v)}
          className={[
            "px-2 py-0.5 uppercase tracking-wide transition-colors",
            i > 0 ? "border-l border-border/50" : "",
            value === opt.v
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-accent/30 hover:text-foreground",
          ].join(" ")}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

function CampaignBarRow({
  row,
  max,
  color,
  onClick,
}: {
  row: CampaignRow
  max: number
  color: string
  onClick: () => void
}) {
  const pct = max > 0 ? (row.pautas / max) * 100 : 0
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded px-2 py-1.5 text-left transition-colors hover:bg-accent/40"
    >
      <span className="min-w-0 flex-1 truncate text-xs" title={row.name}>
        {row.prefixLen > 0 && (
          <span className="text-muted-foreground/60">{row.name.slice(0, row.prefixLen)}</span>
        )}
        <span className="font-medium text-foreground">{row.name.slice(row.prefixLen)}</span>
      </span>
      <span className="h-2 w-[30%] shrink-0 overflow-hidden rounded-full bg-muted">
        <span
          className="block h-full rounded-full"
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
      </span>
      <span className="w-12 shrink-0 text-right text-xs font-semibold tabular-nums">
        {fmt(row.pautas)}
      </span>
      <span className="w-12 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
        {fmt(row.leads)}
      </span>
    </button>
  )
}

function FamilyHeaderRow({
  group,
  color,
  onClick,
}: {
  group: CampaignGroup
  color: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mt-3 flex w-full items-center gap-2 rounded px-2 py-1 text-left transition-colors first:mt-0 hover:bg-accent/40"
    >
      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
      <span className="min-w-0 truncate text-[11px] font-semibold uppercase tracking-wide">
        {group.key}
      </span>
      <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground">
        {fmt(group.campaigns.length)} {group.campaigns.length === 1 ? "campaña" : "campañas"} ·{" "}
        {fmt(group.pautas)} pautas · {fmt(group.leads)} leads
      </span>
    </button>
  )
}

export function CampaignActivityChart({
  pautas,
  isUniqueLead,
  onDrill,
}: {
  /** Already filtered by the global date range — the component never re-filters. */
  pautas: Pauta[]
  isUniqueLead: (p: Pauta) => boolean
  onDrill: (title: string, items: Pauta[]) => void
}) {
  const [depth, setDepth] = useState<GroupDepth>(1)

  // One pass: the tallies that drive the bars and the record lists the drill
  // needs, keyed by the same campaign name so the drawer count always matches
  // the bar it came from.
  const { tallies, recordsByCampaign } = useMemo(() => {
    const recordsByCampaign = new Map<string, Pauta[]>()
    const counts = new Map<string, { pautas: number; leads: number }>()
    for (const p of pautas) {
      const name = p.nombrePauta?.trim() || SIN_NOMBRE_CAMPAIGN
      const list = recordsByCampaign.get(name) ?? []
      list.push(p)
      recordsByCampaign.set(name, list)
      const c = counts.get(name) ?? { pautas: 0, leads: 0 }
      c.pautas++
      // The contactId guard is required: pautaReingresoMap only indexes pautas
      // that have a contact, so isUniqueLead() returns true by default for an
      // orphan record and would inflate the lead count.
      if (p.contactId && isUniqueLead(p)) c.leads++
      counts.set(name, c)
    }
    const tallies: CampaignTally[] = [...counts.entries()].map(([name, c]) => ({ name, ...c }))
    return { tallies, recordsByCampaign }
  }, [pautas, isUniqueLead])

  // "flat" still detects at depth 1 so rows keep their family color and dimmed
  // prefix; only the grouping is dropped.
  const groups = useMemo(
    () => groupCampaignsByFamily(tallies, depth === "flat" ? 1 : depth),
    [tallies, depth],
  )

  const colorByGroup = useMemo(() => {
    const m = new Map<string, string>()
    let i = 0
    for (const g of groups) m.set(g.key, g.kind === "family" ? chartPaletteColor(i++) : NEUTRAL_COLOR)
    return m
  }, [groups])

  // Normalized against the largest campaign in the whole set, not per family,
  // so bar lengths are comparable across families.
  const maxPautas = useMemo(
    () => groups.reduce((m, g) => Math.max(m, ...g.campaigns.map((c) => c.pautas)), 0),
    [groups],
  )

  const flatRows = useMemo(
    () =>
      groups
        .flatMap((g) => g.campaigns.map((c) => ({ row: c, groupKey: g.key })))
        .sort((a, b) => b.row.pautas - a.row.pautas || a.row.name.localeCompare(b.row.name, "es")),
    [groups],
  )

  const totalPautas = useMemo(() => groups.reduce((s, g) => s + g.pautas, 0), [groups])
  const campaignCount = tallies.length
  const familyCount = groups.filter((g) => g.kind === "family").length

  const drillCampaign = (row: CampaignRow) =>
    onDrill(row.name, recordsByCampaign.get(row.name) ?? [])

  const drillFamily = (group: CampaignGroup) =>
    onDrill(
      group.key,
      group.campaigns.flatMap((c) => recordsByCampaign.get(c.name) ?? []),
    )

  return (
    <DashboardCard>
      <ChartCardHeader
        title="Campañas activas por pauta"
        total={totalPautas}
        icon={Megaphone}
        actions={<DepthToggle value={depth} onChange={setDepth} />}
      />
      <ChartCardContent>
        {campaignCount === 0 ? (
          <ChartEmpty message="Sin pautas en el periodo seleccionado." height={220} />
        ) : (
          <>
            <div className="flex items-center gap-3 border-b border-border/50 px-2 pb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              <span className="min-w-0 flex-1">
                {fmt(campaignCount)} {campaignCount === 1 ? "campaña" : "campañas"}
                {depth !== "flat" && familyCount > 0 && (
                  <> · {fmt(familyCount)} {familyCount === 1 ? "familia" : "familias"}</>
                )}
              </span>
              <span className="w-[30%] shrink-0" />
              <span className="w-12 shrink-0 text-right">Pautas</span>
              <span className="w-12 shrink-0 text-right">Leads</span>
            </div>

            <div className="mt-1 max-h-[520px] overflow-y-auto pr-1">
              {depth === "flat"
                ? flatRows.map(({ row, groupKey }) => (
                    <CampaignBarRow
                      key={row.name}
                      row={row}
                      max={maxPautas}
                      color={colorByGroup.get(groupKey) ?? NEUTRAL_COLOR}
                      onClick={() => drillCampaign(row)}
                    />
                  ))
                : groups.map((g) => (
                    <div key={g.key}>
                      <FamilyHeaderRow
                        group={g}
                        color={colorByGroup.get(g.key) ?? NEUTRAL_COLOR}
                        onClick={() => drillFamily(g)}
                      />
                      {g.campaigns.map((row) => (
                        <CampaignBarRow
                          key={row.name}
                          row={row}
                          max={maxPautas}
                          color={colorByGroup.get(g.key) ?? NEUTRAL_COLOR}
                          onClick={() => drillCampaign(row)}
                        />
                      ))}
                    </div>
                  ))}
            </div>

            <ChartHint>
              Activa = con al menos una pauta en el periodo · la barra mide pautas (incluye
              reingresos), &ldquo;Leads&rdquo; cuenta el primer ingreso de cada contacto · haz clic
              en una fila para ver los registros
            </ChartHint>
          </>
        )}
      </ChartCardContent>
    </DashboardCard>
  )
}
```

Two things to be careful about, both already handled above — do not "simplify" them away:

1. The scroll container is a plain `div` with `overflow-y-auto`, **not** Radix `ScrollArea`. Radix `ScrollArea` breaks `truncate` in narrow panels.
2. `maxPautas` uses `Math.max(m, ...c)` over each group's campaigns rather than spreading every campaign at once, keeping the argument count bounded per group.

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

Expected: no output, exit code 0. The component is not yet rendered anywhere, so this only proves it compiles — that is the point of the checkpoint.

- [ ] **Step 3: Lint**

```bash
npm run lint
```

Expected: no errors for `components/dashboard/campaign-activity-chart.tsx`.

- [ ] **Step 4: Commit**

```bash
git add components/dashboard/campaign-activity-chart.tsx
git commit -m "feat(marketing): add CampaignActivityChart component

A div-based bar list rather than a Recharts chart: the full campaign name
is the data here (its prefix is the only agency signal), and a Recharts
Y axis truncates exactly the suffix that distinguishes one campaign from
another. Not wired into the dashboard yet."
```

---

### Task 3: Wire it into the Marketing dashboard

**Files:**
- Modify: `components/dashboard/marketing-dashboard.tsx` — one import, one callback, one render site.

**Interfaces:**
- Consumes from Task 2: `CampaignActivityChart` from `./campaign-activity-chart`.
- Consumes from the existing file: `isUniqueLead` (defined around line 517), `contactById` (around line 583), `setDrill`, `pautas` (the date-filtered prop).
- Produces: nothing for later tasks. This is the last task.

- [ ] **Step 1: Add the import**

In the import block at the top of `components/dashboard/marketing-dashboard.tsx`, next to the existing `ChartDrillDrawer` import (line 35), add:

```typescript
import { CampaignActivityChart } from "./campaign-activity-chart"
```

- [ ] **Step 2: Add the records-mode drill callback**

Immediately **after** the `openPautaDrill` callback (it ends at line 614 with `}, [lookupContacts, contactById, pautaUniqueLeads, isUniqueLead])`), insert:

```typescript
  // Always a records-mode drill, mirroring openSinContactoDrill. openPautaDrill
  // can't be reused here: it branches on pautaUniqueLeads — the toggle belonging
  // to the channel chart — and would resolve to contacts, so the drawer count
  // would stop matching this chart's bars depending on an unrelated control.
  const openPautaRecordsDrill = useCallback(
    (title: string, pautaItems: Pauta[]) => {
      setDrill({
        open: true,
        title,
        opportunities: [],
        pautaItems: pautaItems.map((p) => ({
          pauta: p,
          contact: p.contactId ? contactById.get(p.contactId) : undefined,
        })),
      })
    },
    [contactById],
  )
```

- [ ] **Step 3: Render the card**

Find the `</div>` that closes the two-column grid right before the "Pautas creadas por mes y reingresos" card (around line 1488 — the `<DashboardCard>` whose `ChartCardHeader` has `title="Pautas creadas por mes y reingresos"` starts a few lines later, at ~1490). Insert the new card **between** them, so it sits with the other pauta charts:

```tsx
      <CampaignActivityChart
        pautas={pautas}
        isUniqueLead={isUniqueLead}
        onDrill={openPautaRecordsDrill}
      />
```

It is a full-width card, a sibling of the "Pautas creadas por mes y reingresos" `DashboardCard` — **not** inside the two-column `div` that precedes it.

- [ ] **Step 4: Typecheck**

```bash
npx tsc --noEmit
```

Expected: no output, exit code 0.

- [ ] **Step 5: Drive the real app**

```bash
npm run dev
```

Open `http://localhost:3000`, log in with a client whose campaign names show at least two distinct prefix patterns, and go to the Marketing tab. Confirm, in order:

1. The card **"Campañas activas por pauta"** renders with a total badge.
2. At depth `1`, campaigns are grouped under family headers; each row shows the prefix in grey and the distinguishing suffix in normal weight.
3. Switching to `2` regroups live; switching to `PLANO` produces a single volume-ordered list that **keeps** the colors and the dimmed prefixes, and drops the family count from the summary line.
4. Long campaign names truncate with an ellipsis and their `title` tooltip shows the full name — the row does not wrap or push the numbers off.
5. Clicking a campaign row opens the drawer, and **the drawer's count equals the number on that row**.
6. Clicking a family header opens the drawer with that family's combined records; the count equals the header's "N pautas".
7. Toggle the unrelated "Leads únicos" switch on "Pautas por canal de contacto", then re-open a drill from this chart: the count must still match the bar (this is the bug `openPautaRecordsDrill` exists to prevent).
8. Set the global date filter to a narrow recent range: the campaign list shrinks to what is actually active in that window.
9. Set the date filter to a range with no pautas: `Sin pautas en el periodo seleccionado.` renders instead of an empty list.

Stop the dev server when done.

- [ ] **Step 6: Commit**

```bash
git add components/dashboard/marketing-dashboard.tsx
git commit -m "feat(marketing): render Campañas activas por pauta

Adds openPautaRecordsDrill, which always drills in records mode. Reusing
openPautaDrill would let the channel chart's \"Leads únicos\" toggle change
this chart's drawer count while its bars stay put."
```

---

## Done when

- `npx tsc --noEmit` is clean.
- `npm run lint` reports nothing new.
- All nine checks in Task 3 Step 5 pass against a real sub-account.
- `git status --short` shows no leftover temporary script.
