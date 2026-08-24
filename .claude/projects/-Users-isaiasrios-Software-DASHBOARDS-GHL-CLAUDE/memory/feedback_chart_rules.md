---
name: feedback_chart_rules
description: Rules for all charts in the GHL dashboard — zero-value tooltip filtering and drawer requirement
metadata:
  type: feedback
---

Always use `NonZeroTooltipContent` (exported from `./dashboard-ui`) instead of `ChartTooltipContent` directly in any `<ChartTooltip content={...} />`. It forwards all props (formatter, labelFormatter, etc.) to `ChartTooltipContent` but filters out any payload entries with value 0 so they never appear in the tooltip.

**Why:** User requested zero values be hidden from all chart tooltips to reduce noise.

**How to apply:** Every `<ChartTooltip content={<ChartTooltipContent ... />} />` must become `<ChartTooltip content={<NonZeroTooltipContent ... />} />`. Never import `ChartTooltipContent` directly in dashboard chart files — use the wrapper.

Any new chart added to the dashboard **must** have a drill-down drawer (using `ChartDrillDrawer` or `AppointmentDrillDrawer` or a new drawer). Charts without a drawer are not acceptable.

**Why:** User stated "any new chart has to have a drawer" — this is a hard requirement, not optional.

**How to apply:** Before adding a new chart, wire up a drawer. Use the existing `DrillState` / `DRILL_CLOSED` / `ChartDrillDrawer` pattern in the same dashboard file, or create an appropriate drawer if the data type differs from opportunities/appointments.
