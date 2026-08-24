---
name: pdf-report
description: How the branded PDF report export works — lib/report.ts composing the spec, the analyze-report Haiku pass and its token budget, the pdfmake renderers in lib/pdf/*, and the sanitizeBrand rule. Use when touching export-report-button.tsx, lib/report.ts, app/api/analyze-report, lib/pdf/*, or the AI assistant's create_pdf tool.
---

# PDF report export

Both dashboards export a branded PDF via `components/dashboard/export-report-button.tsx`.

- `lib/report.ts` composes a `ReportInput` (KPIs + `ReportSection[]`) from the dashboard's
  **already-computed aggregates** — deterministic code, not the model.
- `app/api/analyze-report/route.ts` then makes one Haiku pass that writes an executive
  summary plus one analysis per section. Sections are analyzed **by default**; `ai: false`
  opts out. Token budget is sized to the section count (~13 marketing / ~8 ventas) — if you
  add sections, check it still fits.
- `lib/pdf/*` renders the spec with pdfmake: `build-pdf.ts` (doc definition — **LETTER
  landscape**, 712pt usable width), `charts.ts` (hand-drawn canvas charts), `blocks.ts`
  (tables/KPIs), `branding.ts` (palette, `sanitizeBrand`).
- The same `create_pdf` spec/renderer backs the AI assistant's PDF tool, so both outputs
  share one format. Changing `lib/pdf/*` affects both.
- **Brand rule**: `sanitizeBrand()` strips "GoHighLevel"/"GHL" from all rendered text —
  the platform is presented as "Lezgo Suite CRM". The AI prompts carry the same rule.
- pdfmake **cannot render in a bare Node harness** — verify PDF changes by building and
  driving the real app.
