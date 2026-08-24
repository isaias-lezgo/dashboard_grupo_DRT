"use client"

import * as React from "react"
import { FileDown, Loader2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { downloadPdf } from "@/lib/pdf/build-pdf"
import {
  buildAnalyzePayload,
  buildReportSpec,
  type ReportAiResult,
  type ReportInput,
} from "@/lib/report"

interface ExportReportButtonProps {
  /** Called on click so the report reflects the dashboard's current state. */
  getInput: () => ReportInput
  className?: string
}

export function ExportReportButton({ getInput, className }: ExportReportButtonProps) {
  const [working, setWorking] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const handleExport = React.useCallback(async () => {
    if (working) return
    setWorking(true)
    setError(null)

    try {
      const input = getInput()

      // AI analysis is best-effort: a failure degrades to a data-only PDF
      // (buildReportSpec inserts the warn callout when ai is null).
      let ai: ReportAiResult | null = null
      try {
        const res = await fetch("/api/analyze-report", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(buildAnalyzePayload(input)),
        })
        if (res.ok) ai = (await res.json()) as ReportAiResult
      } catch {
        ai = null
      }

      const result = await downloadPdf(buildReportSpec(input, ai))
      if (!result.success) {
        setError(result.error ?? "No se pudo generar el PDF")
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo generar el reporte")
    } finally {
      setWorking(false)
    }
  }, [getInput, working])

  return (
    <div className={className}>
      <div className="flex items-center gap-2">
        {error && (
          <span className="text-[11px] text-destructive" role="alert">
            {error}
          </span>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 rounded-md text-xs font-medium"
          onClick={handleExport}
          disabled={working}
        >
          {working ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Generando reporte…
            </>
          ) : (
            <>
              <FileDown className="h-3.5 w-3.5" />
              Exportar reporte
            </>
          )}
        </Button>
      </div>
    </div>
  )
}
