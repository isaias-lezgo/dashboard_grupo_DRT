"use client"

import * as React from "react"
import { AlertTriangle, Check, ChevronDown, type LucideIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { MISSING_TEXT } from "./dashboard-ui"

export interface MultiSelectOption {
  /** Valor guardado en el estado. */
  value: string
  label: string
  /** Cuántos registros trae — se pinta a la derecha de la fila. */
  count?: number
  /**
   * Cubetas que no son una categoría real ("Sin sucursal", "Sin dato"): van al
   * final y en el rojizo de dato faltante, para que no compitan con una
   * sucursal de verdad y se lean como el hueco de captura que son.
   */
  muted?: boolean
  /**
   * Aviso de grafía duplicada. Cuando viene, la fila muestra un ⚠ con este
   * texto: es la señal de que el valor está mal capturado en el CRM, y es la
   * razón de que el menú de categorías no agrupe las variantes.
   */
  variantHint?: string
}

interface MultiSelectFilterProps {
  label: string
  icon: LucideIcon
  options: MultiSelectOption[]
  selected: string[]
  onChange: (values: string[]) => void
  /** Texto del popover cuando no hay ninguna opción en el dataset. */
  emptyMessage?: string
  /**
   * Muestra un buscador arriba de la lista. Para los menús largos (origen y
   * canal listan una fila por grafía capturada, no una por categoría).
   */
  searchable?: boolean
  className?: string
}

/**
 * Menú de selección múltiple para la barra de filtros. Uno solo, montado dos
 * veces (sucursal / asesor) — el estado y el significado viven en
 * `lib/panel-filters.ts`, aquí solo se pintan casillas.
 *
 * No usa el `Select` de shadcn: ese no hace selección múltiple. Popover +
 * Checkbox, que ya están en el repo.
 *
 * **Selección vacía = sin filtro**, y el botón lo dice: sin selección se ve como
 * el resto de la barra, y con selección se pinta activo y muestra el conteo. Ese
 * conteo es lo que evita el clásico "¿por qué no salen datos?" con un filtro
 * puesto tres días antes y olvidado.
 */
export function MultiSelectFilter({
  label,
  icon: Icon,
  options,
  selected,
  onChange,
  emptyMessage = "Sin opciones disponibles",
  searchable = false,
  className,
}: MultiSelectFilterProps) {
  const [open, setOpen] = React.useState(false)
  const active = selected.length > 0
  const selectedSet = React.useMemo(() => new Set(selected), [selected])

  const [query, setQuery] = React.useState("")

  // Sin acentos ni mayúsculas: escribir "walk" tiene que encontrar "Walk In",
  // "WALK IN" y "walk-in", que es justo la comparación que el usuario quiere
  // hacer cuando anda cazando grafías repetidas.
  const visible = React.useMemo(() => {
    const q = query.trim()
    if (!searchable || q === "") return options
    const norm = (s: string) =>
      s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    const needle = norm(q)
    return options.filter((o) => norm(o.label).includes(needle))
  }, [options, query, searchable])

  const toggle = (value: string) => {
    onChange(
      selectedSet.has(value)
        ? selected.filter((v) => v !== value)
        : [...selected, value]
    )
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        // Que no quede una búsqueda vieja escondiendo opciones al reabrir.
        if (!next) setQuery("")
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant={active ? "default" : "outline"}
          disabled={options.length === 0}
          className="h-7 gap-1.5 rounded-md px-2.5 text-[11px] font-medium"
          aria-label={`Filtrar por ${label.toLowerCase()}`}
        >
          <Icon className="h-3.5 w-3.5 opacity-70" aria-hidden="true" />
          {label}
          {active && (
            <span className="tabular-nums opacity-80">· {selected.length}</span>
          )}
          <ChevronDown className="h-3 w-3 opacity-60" aria-hidden="true" />
        </Button>
      </PopoverTrigger>

      <PopoverContent align="start" className={cn("w-60 p-0", className)}>
        {options.length === 0 ? (
          <p className="px-3 py-4 text-center text-[11px] text-muted-foreground">
            {emptyMessage}
          </p>
        ) : (
          <>
            {searchable && (
              <div className="border-b border-border p-2">
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Buscar…"
                  aria-label={`Buscar en ${label.toLowerCase()}`}
                  className="h-7 text-[11px]"
                />
              </div>
            )}

            {/* overflow-y-auto a secas: Radix ScrollArea rompe `truncate`. */}
            <div className="max-h-72 overflow-y-auto py-1">
              {visible.length === 0 ? (
                <p className="px-3 py-4 text-center text-[11px] text-muted-foreground">
                  Sin coincidencias
                </p>
              ) : (
                visible.map((option) => {
                  const checked = selectedSet.has(option.value)
                  return (
                    <label
                      key={option.value}
                      className={cn(
                        "flex cursor-pointer items-center gap-2.5 px-3 py-1.5 text-xs transition-colors hover:bg-muted/60",
                        option.muted && MISSING_TEXT
                      )}
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={() => toggle(option.value)}
                        className="h-3.5 w-3.5 shrink-0"
                        aria-label={option.label}
                      />
                      {/* La grafía se pinta VERBATIM: cualquier capitalización
                          aquí volvería a esconder el error de captura. */}
                      <span className="min-w-0 flex-1 truncate">{option.label}</span>
                      {option.variantHint && (
                        <span
                          title={option.variantHint}
                          aria-label={option.variantHint}
                          className="shrink-0"
                        >
                          <AlertTriangle className="h-3 w-3 text-amber-500" />
                        </span>
                      )}
                      {option.count !== undefined && (
                        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                          {option.count.toLocaleString("es-MX")}
                        </span>
                      )}
                    </label>
                  )
                })
              )}
            </div>

            <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2">
              <span className="text-[11px] text-muted-foreground">
                {active ? `${selected.length} seleccionada(s)` : "Todas"}
              </span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-6 rounded px-2 text-[11px]"
                disabled={!active}
                onClick={() => onChange([])}
              >
                Limpiar
              </Button>
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}

/** Píldora que resume los filtros activos y los apaga de un clic. */
export function ActiveFiltersPill({
  count,
  onClear,
}: {
  count: number
  onClear: () => void
}) {
  if (count === 0) return null
  return (
    <button
      type="button"
      onClick={onClear}
      className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-primary/25 bg-primary/10 px-2.5 text-[11px] font-medium text-primary transition-colors hover:bg-primary/15"
    >
      <Check className="h-3 w-3" aria-hidden="true" />
      {count} filtro{count === 1 ? "" : "s"} activo{count === 1 ? "" : "s"} · Limpiar
    </button>
  )
}
