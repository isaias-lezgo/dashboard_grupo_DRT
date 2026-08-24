---
target: sales dashboard
total_score: 19
p0_count: 2
p1_count: 2
timestamp: 2026-05-24T08-08-15Z
slug: components-dashboard-sales-dashboard-tsx
---
## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Header shows last-updated time, loading indicator, and counts. Solid. |
| 2 | Match System / Real World | 3 | Spanish labels match user language. One miss: "Win/Loss" is English in a fully Spanish UI. |
| 3 | User Control and Freedom | 2 | Drill drawers open/close. No filter visibility on Sales tab, no date range indicator, no comparison mode. |
| 4 | Consistency and Standards | 2 | TotalBadge appears inconsistently, all KPI icons are blue-500 regardless of semantic meaning, empty state copy varies. |
| 5 | Error Prevention | 1 | Revenue card silently disappears when empty (layout breaks). Date filter silently applies to sales without indication. |
| 6 | Recognition Rather Than Recall | 2 | Clickable bars signal only by tiny 10px hint text. No hover fill state on bars. Users discover by accident. |
| 7 | Flexibility and Efficiency | 1 | No export, no sort controls on Win/Loss chart, no keyboard navigation, no batch path. |
| 8 | Aesthetic and Minimalist Design | 2 | Section dividers are appropriate. But 7 charts + 4 KPIs shown simultaneously with no progressive disclosure is exhaustive, not minimal. |
| 9 | Error Recovery | 1 | Generic "Error al cargar datos" banner. No per-section retry, no actionable recovery path. |
| 10 | Help and Documentation | 2 | InfoTooltip used in 3 places. Not used where needed most: KPI definitions, win-rate formula, pipeline value definition. |
| **Total** | | **19/40** | **Poor (12–19): Major improvements needed** |

## Anti-Patterns Verdict

**LLM assessment — Yes, this reads as AI-generated.**

Four specific tells:

1. **Hero-metric template, quadrupled.** Lines 564-628: four `text-3xl font-bold` cards, identical structure, all icons `text-blue-500`. Count metrics, rate metrics, and currency metrics are rendered at the same visual weight. This is the exact banned template from the design system.
2. **Brand is entirely absent.** `#F59B1B` (orange) and `#335577` (navy) do not appear once in the file. The entire dashboard uses the default Recharts/shadcn demo palette: blue-500, violet-500, emerald-500, red-500. The design system was written and then ignored.
3. **Seven charts, zero editorial judgment.** Every chart section renders unconditionally with the same card weight. There is no declared "this is the primary question this dashboard answers."
4. **Copy-pasted hint text.** Seven identical "Haz clic en una barra para ver…" lines beneath every chart, including charts where the drill interaction is not meaningfully different.

**Deterministic scan:** Exit code 0, zero findings. The detector found no rule violations (side-stripe borders, gradient text, glassmorphism, etc.). The problems here are architectural and brand-level, not CSS-pattern violations.

## Overall Impression

The engineering quality is solid — the drill drawer pattern, business-hours response time, and conditional height scaling are genuinely thoughtful. But the dashboard presents 11+ simultaneous questions with no declared priority, zero brand presence, and a hero-metric row that is the most recognizable AI dashboard anti-pattern in existence. The single biggest opportunity: establish one primary question ("Is the team on pace?") and redesign the visual hierarchy to answer it in under 10 seconds.

## What's Working

**1. Drill drawer architecture.** `ChartDrillDrawer` and `AppointmentDrillDrawer` use the right pattern: drawer (not modal), preserves scroll, typed state initialized to closed constants. The interaction model is correct.

**2. Business-hours response time.** The `isBusinessHoursStr` / `nextBusinessOpenMs` / `responseColor` logic (lines 93-132) measures advisor response time against `America/Mexico_City` working hours with green/amber/red thresholds. This is genuine domain intelligence, not generic metric counting.

**3. Dynamic chart height scaling.** Charts use `Math.max(200, data.length * 64)` so layout scales gracefully as team size grows. Real data variability was considered.

## Priority Issues

**[P0] Brand identity is entirely absent**
Every chart uses the default Tailwind/shadcn demo palette. `#F59B1B` and `#335577` appear zero times. The KPI icons are all `text-blue-500` with no semantic meaning. An internal tool that does not look like the company's tool feels like a prototype.
**Fix:** Audit all `fill=`, `text-*-500`, and icon color props. Replace the primary data series with `#F59B1B`. Use `#335577` for structural/framing elements. At minimum: won-revenue KPI icon and the "Ganado" chart series should be orange.
**Command:** `/impeccable colorize sales-dashboard`

**[P0] KPI row is the hero-metric anti-pattern**
Lines 564-628: four identical `text-3xl font-bold` tiles. Count, rate, and currency metrics share the same visual weight and template. The Founder cannot identify the headline number in under 1 second.
**Fix:** Replace with a horizontal data strip. One primary metric at large scale (won revenue or conversion rate), three supporting figures at smaller weight with `tabular-nums`. Use brand orange on the lead metric only.
**Command:** `/impeccable layout sales-dashboard KPI row`

**[P1] Appointments chart is cognitively unrenderable**
`apptByMonthByAdvisor` encodes N advisors × M statuses. With 4 advisors × 6 statuses = 24 bar sub-segments per month group. The legend shows only status colors; advisor identity disambiguation is impossible at a glance.
**Fix:** Default to 2 statuses (showed vs. no-show), toggle to see full breakdown. Or split into "citas por asesor" (grouped total) + a separate status detail.
**Command:** `/impeccable shape appointments chart split`

**[P1] Active date range is invisible on the Sales tab**
`SalesDashboard` receives no date range props. A user who selects "Last 7 days" on Marketing, then switches to Sales, sees 7-day data with no indication of the active window.
**Fix:** Pass `startDate`/`endDate` as props and render them in a sticky summary row or the first section header: "Mostrando datos del 1 May – 24 May 2026."
**Command:** `/impeccable harden sales-dashboard filter awareness`

**[P2] Response time chart is a layout orphan**
Lines 801-860: the chart is conditionally rendered outside the "Rendimiento Individual" 2-column grid. When data exists it appears as a full-width orphan between sections. When absent, the section header is followed by only two charts.
**Fix:** Move inside the "Rendimiento Individual" section (third grid item), or give it its own sub-section that only renders when data exists.
**Command:** `/impeccable layout sales-dashboard response time placement`

## Persona Red Flags

**Alex (Power User — Sales Rep)**
- Cannot export chart data. No sort control on Win/Loss chart — renders in array order, not win-rate order. Top performer is not immediately visible.
- Win-rate percentage label (`LabelList`, lines 726-732) is the most important number on that chart. It is right-of-bar and gets clipped by long bars.
- No keyboard navigation into the drill drawer.
- No "My Performance" summary — Alex must cross-reference 4 separate charts to assess their own results.

**The Founder (exec, 2-minute read)**
- No targets, quotas, or period-over-period deltas. Cannot tell if 12.3% conversion is improvement or regression.
- Pipeline health section is the fourth section — below the fold, past individual performance charts. The most strategic signal is buried.
- No visual status indicator. Stripe and every other exec tool the Founder uses has a one-line status bar. This does not.
- Appointments chart costs 25% of a 2-minute read and cannot answer the question "Is the team performing?"

## Minor Observations

- "Miembros Activos" subtitle reads `{kpiMetrics.activeMembers} en total` — identical to the KPI above it. The same number displayed twice.
- TotalBadge appears on some charts, not others, with no communicated rule.
- `members` `useMemo` (line 206) re-derives members from opportunities, ignoring `membersProp`. Members with zero opportunities are invisible in charts but counted in the KPI. Can produce `activeMembers = 8` while charts show 5 names.
- All charts share `CartesianGrid strokeDasharray="3 3"` — Recharts default. Should use a lighter stroke weight matching the brand system.
- "Win/Loss por Asesor" — the only English phrase in a Spanish-language UI.

## Questions to Consider

- **What is the one question this dashboard must answer in under 10 seconds?** Right now it answers approximately 11. Every design decision flows from the answer to this. If it is "Is the team on pace to close quota this month?" the current layout, hierarchy, and chart selection are all wrong — and fixable.
- **Why do appointments appear in a Sales dashboard at all?** Appointments are calendar events. Win rates, conversion, and revenue are sales indicators. Is an advisor with 40 appointments and 5% conversion better than one with 15 appointments and 30% conversion? The dashboard cannot answer this. If the relationship cannot be shown, appointments may belong elsewhere.
- **What would the Founder's 3-number view look like?** Forcing a 3-number constraint reveals which of the current metrics are load-bearing for decisions. Likely: total won revenue (this period), conversion rate, open pipeline value. Everything else becomes depth.
