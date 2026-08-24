"use client"

import { useState } from "react"
import { AlertTriangle, RefreshCw, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { SyncWarning } from "@/hooks/use-dashboard-data"

// Human labels + what the user actually loses when a dataset is missing. The
// consequence matters more than the dataset name: "oportunidades" means nothing
// to someone looking at an empty sales chart.
const DATASET_COPY: Record<string, { name: string; impact: string }> = {
  contacts: { name: "los contactos", impact: "Las gráficas de leads y origen quedan incompletas." },
  opportunities: { name: "las oportunidades", impact: "Las gráficas de ventas y conversión quedan incompletas." },
  pautas: { name: "las pautas", impact: "Las gráficas de campañas y pauta quedan incompletas." },
  appointments: { name: "las citas", impact: "Las gráficas de agenda quedan incompletas." },
  // El impacto se nombra por lo que REALMENTE depende de las tareas: el rezago
  // por asesor (solo pendientes) y el historial/tasa de completado. Antes decía
  // "las gráficas de seguimiento quedan incompletas", que acusaba de incompleto
  // al rezago por asesor incluso cuando el recorte había sido solo de tareas
  // completadas y ese gráfico estaba entero.
  tasks: {
    name: "las tareas",
    impact: "El rezago por asesor y el historial de tareas pueden quedar cortos.",
  },
}

function describe(w: SyncWarning): string {
  const copy = DATASET_COPY[w.key] ?? { name: `los datos de ${w.key}`, impact: "" }
  if (w.kind === "error") {
    return `No se pudieron cargar ${copy.name}. ${copy.impact}`.trim()
  }
  const of = w.expected ? ` de ~${w.expected.toLocaleString("es-MX")}` : ""
  return `Se cargaron ${w.loaded.toLocaleString("es-MX")}${of} ${copy.name.replace(/^(los|las) /, "")}. ${copy.impact}`.trim()
}

export function SyncWarningBanner({
  warnings,
  onRetry,
  isLoading,
}: {
  warnings: SyncWarning[]
  onRetry: () => void
  isLoading: boolean
}) {
  // Dismissal is per-render-session only: a fresh sync that still produces
  // warnings mounts a new banner, because silently hiding incomplete data is
  // the failure mode this whole component exists to prevent.
  const [dismissed, setDismissed] = useState(false)
  if (dismissed || warnings.length === 0) return null

  return (
    <div className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-2.5 sm:px-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-500" />
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="text-xs font-semibold text-amber-900 dark:text-amber-200">
            Datos incompletos en esta sincronización
          </p>
          {warnings.map((w) => (
            <p key={w.key} className="text-xs text-amber-800/90 dark:text-amber-200/80">
              {describe(w)}
            </p>
          ))}
        </div>
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 border-amber-500/40 bg-transparent text-xs text-amber-900 hover:bg-amber-500/15 dark:text-amber-200"
          onClick={onRetry}
          disabled={isLoading}
        >
          <RefreshCw className={`h-3 w-3 ${isLoading ? "animate-spin" : ""}`} />
          Reintentar
        </Button>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label="Descartar aviso"
          className="rounded p-1 text-amber-700/70 hover:bg-amber-500/15 dark:text-amber-300/70"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}
