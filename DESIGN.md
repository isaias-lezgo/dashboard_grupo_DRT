---
name: GHL CRM Dashboard
description: Internal operations dashboard surfacing GoHighLevel CRM data for marketing, sales, and executive review.
colors:
  brand-amber: "#F59B1B"
  structural-navy: "#335577"
  cool-slate-bg: "#F2F4F7"
  surface-white: "#FFFFFF"
  ink-navy: "#151B28"
  muted-steel: "#EAEDF1"
  subtle-border: "#DBE0E5"
  danger-red: "#DC2626"
typography:
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1.4
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: "0.01em"
rounded:
  sm: "8px"
  md: "10px"
  lg: "12px"
  full: "9999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.brand-amber}"
    textColor: "{colors.surface-white}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
  button-primary-hover:
    backgroundColor: "#D9870F"
    textColor: "{colors.surface-white}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.structural-navy}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
  chip-total-badge:
    backgroundColor: "{colors.muted-steel}"
    textColor: "{colors.ink-navy}"
    rounded: "{rounded.full}"
    padding: "2px 10px"
---

# Design System: GHL CRM Dashboard

## 1. Overview

**Creative North Star: "The Amber Ledger"**

This is an instrument, not a showpiece. Every element either carries a data point or helps the user find the next one. The dominant amber marks where the organization's attention belongs; the structural navy anchors the frame with authority. Together they reject the safe middle ground of generic SaaS and land somewhere more specific: a command tool used by people who already know what they're looking for.

The surface is a pale cool slate. Cards emerge from it without drama. Charts encode meaning in color, not decoration. Typography is system sans throughout; every number is tabular. The interface disappears into the work.

This system explicitly rejects two failure modes documented in PRODUCT.md. First: the generic SaaS blue-and-white template where every interactive element is the same shade of cornflower blue and nothing has earned visual priority. Second: the heavy BI tool aesthetic where dashboards are carpeted in docked filter panels, toolbar rows above every chart, and visible controls for every possible configuration. This dashboard must feel decisive. It shows answers, not machinery.

**Key Characteristics:**
- Brand amber on primary actions, active states, and the leading chart series only
- Structural navy for navigation, headers, and load-bearing frame elements
- Cool-slate background that lifts white card surfaces without shadows
- System fonts throughout; no display type in a data context
- Flat at rest; shadows appear only on floating and interactive-elevated states

---

## 2. Colors: The Amber and Navy Command Palette

Two strong voices against cool neutral ground. Neither color apologizes for being there.

### Primary
- **Brand Amber** (#F59B1B): The dominant brand color. Primary buttons, active tab indicators, the lead chart data series, and status badges marking the most important value on a panel. Warm and directive against the cool-slate ground. Its scarcity is the point: do not distribute it freely.

### Secondary
- **Structural Navy** (#335577): The dark structural anchor. Used for the application header background, navigation elements, and any surface that says "this is load-bearing, not content." Not for body text; that role belongs to Ink Navy.

### Neutral
- **Cool Slate Background** (#F2F4F7): The page ground. Not white. The blue-gray tint ensures Surface White cards lift visibly without shadows.
- **Surface White** (#FFFFFF): Card and panel surfaces. Clean, untinted; stands against the slate.
- **Ink Navy** (#151B28): Primary text color. Near-black with a naval undertone that connects it to the structural palette.
- **Muted Steel** (#EAEDF1): Secondary surfaces, chip fills, disabled states, filter bar backgrounds.
- **Subtle Border** (#DBE0E5): Card borders, input outlines, dividers.
- **Danger Red** (#DC2626): Destructive actions, error states, negative-value indicators only.

### Named Rules
**The Amber Discipline Rule.** Amber occupies at most three roles simultaneously on any screen: primary action, active selection, and the leading chart series. A view with amber in five different places has five competing claims on attention and no actual hierarchy. When it feels like more amber is needed, the problem is information architecture, not the palette.

**The No-Blue-Primary Rule.** The generic SaaS cornflower blue (#2563eb) is not a brand color in this system. It lives in the chart data palette as one series among many. It is never used as a primary action color, focus ring, or interactive indicator. Using it as a primary would recreate the exact anti-reference documented in PRODUCT.md.

---

## 3. Typography

**UI Font:** System sans-serif stack (-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif)

**Character:** A single family, tuned at each scale. No display-weight pairing, no editorial headline faces. System fonts render at native quality, load at zero cost, and feel native to the user's operating environment. In a data tool, the type should be invisible: the numbers are the content.

### Hierarchy
- **Title** (semibold, 1rem / 16px, 1.4 line-height): Card titles, section headers, tab labels. The top of the information hierarchy inside a panel.
- **Body** (regular, 0.875rem / 14px, 1.5 line-height): Chart descriptions, table cell text, inline explanations. Max line length 65–75ch for any prose block.
- **Label** (medium, 0.75rem / 12px, 1.3 line-height, 0.01em tracking): Badge text, axis tick labels, metadata pills, filter counts.
- **Data** (semibold–bold, 1.25–2rem, tabular-nums): Primary metric values and KPI counts. Always rendered with `font-variant-numeric: tabular-nums` so digits align in columns.

### Named Rules
**The No-Display Rule.** No editorial typefaces, no variable-weight animations, no serif headlines anywhere in the application UI. This is a command tool; the type hierarchy signals information structure, not brand personality.

**The Tabular Numbers Rule.** Every number that shares a visual column, chart axis, or row with another number uses `font-variant-numeric: tabular-nums`. Ragged digit widths in financial data read as a defect.

---

## 4. Elevation

Flat by default. Depth is communicated through background-color contrast, not shadow: the Cool Slate Background (#F2F4F7) creates inherent contrast for Surface White (#FFFFFF) cards without any `box-shadow` required. Shadows are reserved for interactive elevation and floating layers exclusively.

### Shadow Vocabulary
- **Hover lift** (`box-shadow: 0 1px 3px rgba(21, 27, 40, 0.08), 0 1px 2px rgba(21, 27, 40, 0.06)`): Cards and interactive panels on hover. Signals that the element will respond.
- **Floating layer** (`box-shadow: 0 4px 16px rgba(21, 27, 40, 0.12), 0 2px 6px rgba(21, 27, 40, 0.08)`): Dropdowns, tooltips, drill drawers, any panel floating above the content surface.

### Named Rules
**The Flat-By-Default Rule.** A resting box-shadow implies an element is permanently elevated and can be pressed further. Most content cards cannot be. Shadow at rest is a false promise; reserve it for state changes and floating overlays.

---

## 5. Components

### Buttons
Minimal set: primary (amber solid), ghost (navy-bordered), destructive (red). Nothing else needs a button shape; lower-stakes actions use links or inline controls.

- **Shape:** Gently curved (10px radius)
- **Primary:** Brand amber (#F59B1B) fill, white text, 8px×16px padding. Hover darkens to #D9870F. Focus: 2px amber ring, 2px offset.
- **Ghost:** No fill, 1px navy border at 30% opacity (#335577 at 0.3 alpha), structural navy text. Hover adds Muted Steel fill.
- **Destructive:** Danger red (#DC2626) fill, white text. Only for irreversible destructive actions.

### Cards / Containers
The primary layout unit for chart panels and data summaries.

- **Corner Style:** Gently curved (12px radius)
- **Background:** Surface White (#FFFFFF) against the Cool Slate page background
- **Shadow Strategy:** None at rest (Flat-By-Default Rule). Hover lift shadow on interactive cards.
- **Border:** 1px Subtle Border (#DBE0E5) at rest.
- **Internal Padding:** 12px vertical, 16px horizontal for the header row; 16px padding for the content area.

### Inputs / Fields
- **Style:** 1px Subtle Border (#DBE0E5), Surface White fill, 10px radius
- **Focus:** Border holds; a 2px amber ring (rgba(245, 155, 27, 0.25)) wraps the element.
- **Disabled:** Muted Steel fill, 50% opacity text.
- **Error:** Danger Red border, small red label below the field.

### Navigation (Tabs)
Top-level Marketing / Sales tab switcher. Sits on the Cool Slate background, not inside a card.

- **Default:** Label-weight text, muted color. No background, no underline.
- **Hover:** Muted Steel background tint.
- **Active:** Full-weight title text, 2px Brand Amber underline flush to the tab bar bottom. No filled background on the active tab.

### TotalBadge
Inline pill showing aggregate counts alongside chart card titles.

- **Style:** Muted Steel fill (#EAEDF1), Ink Navy text, full-radius pill, label-scale type (0.75rem medium).
- **Purpose:** Supporting context, never primary emphasis. It complements the title; it does not compete with the chart.

### Chart Series Palette
Data visualization uses a fixed sequence independent of the brand palette. Brand Amber (#F59B1B) always occupies position 1 when there is a single most-important series. Remaining series follow in order: #2563eb, #10b981, #8b5cf6, #06b6d4, #f97316, #22c55e, #ec4899, #84cc16, #ef4444. Color is never the sole data encoding: chart tooltips, axis labels, and legend text always accompany it.

---

## 6. Do's and Don'ts

### Do:
- **Do** use Brand Amber (#F59B1B) for primary buttons, active tab indicators, and the leading chart series. Its contrast against the cool-slate ground is what gives it authority; use it sparingly to preserve that.
- **Do** use Structural Navy (#335577) for the application header and navigation anchors. It signals permanence and frame, not content.
- **Do** keep card surfaces Surface White (#FFFFFF) against the Cool Slate background (#F2F4F7). The color-contrast approach to depth eliminates the need for default shadows.
- **Do** apply `font-variant-numeric: tabular-nums` to every number that appears alongside other numbers in a column, axis, or row.
- **Do** make charts drillable: a click on a chart bar or segment opens a detail drawer in the same view. Never navigate to a new page for a drill-down.
- **Do** keep the filter bar minimal. Surface the date range and the one or two filters that drive the core decisions. Hide advanced filters behind a secondary control.

### Don't:
- **Don't** use the generic SaaS blue (#2563eb) as a primary action color, focus ring, or tab indicator. It is a chart series color only. This directly recreates the "generic blue-and-white SaaS template" anti-reference in PRODUCT.md.
- **Don't** put box-shadows on cards at rest. Flat surfaces on a tinted background have inherent depth; adding shadows on top creates visual noise and signals false interactivity.
- **Don't** use a heavy BI tool pattern: docked filter panels, toolbar rows above every chart, controls for every possible configuration visible simultaneously. The dashboard must feel decisive. Show answers; hide machinery.
- **Don't** add decorative gradients, background shapes, ambient glows, or any visual element that does not encode data or guide comprehension (Design Principle 1: Data earns the surface).
- **Don't** use display typefaces, serif fonts, or variable-weight animations in the UI. All type is system sans; hierarchy is expressed through scale and weight, not family.
- **Don't** scatter Brand Amber across more than three concurrent roles on the same screen. Overuse destroys the hierarchy that makes it useful.
