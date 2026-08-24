"use client"

import { Database } from "lucide-react"
import { Switch } from "@/components/ui/switch"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

interface HubspotImportToggleProps {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  /** How many opportunities the toggle would add, for the tooltip. */
  importedCount?: number
  className?: string
}

/**
 * Panel-wide switch for the deals migrated from HubSpot. Off by default: the
 * migration wrote its own bulk close date, so those deals pile onto a single
 * month and drown out real sales on any chart that measures money over time.
 *
 * Lives next to the date filter because it is the same kind of control — it
 * changes which opportunities the whole panel is talking about, not how one
 * chart draws them.
 */
export function HubspotImportToggle({
  checked,
  onCheckedChange,
  importedCount,
  className,
}: HubspotImportToggleProps) {
  // Own provider: the filter bar sits outside the header's TooltipProvider,
  // and Radix throws without an ancestor one. Same pattern as ScopePill.
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <label
            className={cn(
              "inline-flex h-7 shrink-0 cursor-pointer select-none items-center gap-2 rounded-md",
              "border border-border/50 bg-white/60 px-2.5 dark:bg-white/[0.06]",
              className
            )}
          >
            <Database
              className={cn(
                "h-3.5 w-3.5 transition-colors",
                checked ? "text-primary" : "text-muted-foreground"
              )}
              aria-hidden="true"
            />
            <span
              className={cn(
                "text-[11px] font-medium transition-colors",
                checked ? "text-foreground" : "text-muted-foreground"
              )}
            >
              Importación HubSpot
            </span>
            <Switch
              checked={checked}
              onCheckedChange={onCheckedChange}
              aria-label="Incluir oportunidades importadas de HubSpot"
              className="h-4 w-7 [&>span]:h-3 [&>span]:w-3 [&>span]:data-[state=checked]:translate-x-3"
            />
          </label>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-xs text-xs leading-relaxed">
          {checked ? (
            <>
              Incluyendo las oportunidades migradas desde HubSpot
              {importedCount !== undefined && ` (${importedCount.toLocaleString("es-MX")})`}.
              Ojo: la migración les puso una fecha de cierre masiva, así que inflan el mes
              en que se corrió.
            </>
          ) : (
            <>
              Solo oportunidades trabajadas en el CRM.
              {importedCount !== undefined &&
                ` Quedan fuera ${importedCount.toLocaleString("es-MX")} migradas desde HubSpot.`}
            </>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
